const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { MemoryStore } = require('../store');
const { installJellyfinAccounts } = require('../jellyfinAccounts');

async function fixture(t) {
  const app = express(), store = new MemoryStore();
  let accepted = true, revoked = false;
  const address = `https://${'a'.repeat(32)}.samerow-connector.invalid`;
  app.use((req, res, next) => {
    const uid = req.get('X-Test-User') || 'owner';
    req.identity = { uid, ...(uid === 'connector' ? { connectorId: 'a'.repeat(32) } : {}), firebase: { sign_in_provider: uid === 'guest' ? 'anonymous' : 'google.com' } };
    next();
  });
  const options = { store, relay: {
    authorize: async () => { if (revoked) throw new Error('revoked'); return true; },
    request: async (connection, path, opts) => {
      if (path === '/Users/AuthenticateByName' && JSON.parse(opts.body).Pw !== 'correct') return Response.json({}, {status:401});
      if (path === '/System/Info/Public') return Response.json({ServerName:'Home cinema',Id:'server'});
      if (path === '/QuickConnect/Initiate') return Response.json({Secret:'private-quick-secret',Code:'123456'});
      if (path.startsWith('/QuickConnect/Connect?')) return Response.json({Authenticated:accepted});
      if (path === '/Users/Me' && !accepted) return Response.json({}, {status:401});
      if (path === '/Sessions/Logout') return new Response(null,{status:204});
      return Response.json({AccessToken:'private-upstream-token',User:{Id:'viewer',Name:'Movie fan'},ServerId:'server'});
    },
  } };
  let service = installJellyfinAccounts(app, options);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (path, {user='owner', body, token, method=body?'POST':'GET'}={}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jellyfin${path}`,{method,headers:{'X-Test-User':user,...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const text=await response.text();
    return {status:response.status,headers:response.headers,body:text?JSON.parse(text):null,text};
  };
  return {request,store,address, login: (extra={},user) => request('/login',{user,body:{serverUrl:address,username:'viewer',password:'correct',linkAccount:true,...extra}}), expire:()=>{accepted=false;}, revoke:()=>{revoked=true;}, restart:()=>{ service.close(); const second=express(); second.use((req,res,next)=>{req.identity={uid:'owner',firebase:{sign_in_provider:'google.com'}};next();}); service=installJellyfinAccounts(second,options); server.removeAllListeners('request'); server.on('request',second); }};
}

test('explicit links are restored by SameRow identity across browsers and service restarts',async t=>{
  const f=await fixture(t);
  const login=await f.login();
  assert.equal(login.status,200);
  assert.doesNotMatch(login.text,/private-upstream-token|correct/);
  const result=await f.request('/connections');
  assert.equal(result.body.connections[0].token,login.body.token);
  assert.equal(result.body.connections[0].account.userName,'Movie fan');
  assert.equal(result.headers.get('cache-control'),'no-store');
  assert.deepEqual((await f.request('/connections',{user:'other'})).body.connections,[]);
  assert.equal((await f.request('/account',{user:'other',token:login.body.token})).status,401);
  f.restart();
  assert.equal((await f.request('/connections')).body.connections[0].token,login.body.token);
  await f.request('/logout',{token:login.body.token,method:'POST'});
  assert.deepEqual((await f.request('/connections')).body.connections,[]);
});

test('guests, connector sessions, invalid credentials and temporary logins do not create account links',async t=>{
  const f=await fixture(t);
  for(const user of ['guest','connector']) {
    assert.equal((await f.login({},user)).status,403);
    assert.equal((await f.request('/connections',{user})).status,403);
  }
  assert.equal((await f.login({password:'wrong'})).status,401);
  assert.equal((await f.login({linkAccount:'yes'})).status,400);
  assert.equal((await f.login({linkAccount:false,remember:true})).status,200);
  assert.deepEqual((await f.request('/connections')).body.connections,[]);
});

test('Quick Connect links its approved Jellyfin user and revocation removes account discovery',async t=>{
  const f=await fixture(t);
  const quick=await f.request('/quick-connect',{body:{serverUrl:f.address,linkAccount:true}});
  assert.equal(quick.status,200);
  assert.doesNotMatch(quick.text,/private-quick-secret/);
  assert.equal((await f.request(`/quick-connect/${quick.body.id}`,{user:'other'})).status,403);
  const login=await f.request(`/quick-connect/${quick.body.id}`);
  assert.equal(login.status,200);
  assert.equal((await f.request('/connections')).body.connections[0].token,login.body.token);
  f.revoke();
  assert.deepEqual((await f.request('/connections')).body.connections,[]);
});

test('expired Jellyfin authorization preserves its binding and requests sign-in',async t=>{
  const f=await fixture(t);
  const login=await f.login();
  f.expire();
  assert.equal((await f.request('/account',{token:login.body.token})).status,401);
  const linked=(await f.request('/connections')).body.connections;
  assert.equal(linked.length,1);
  assert.equal(linked[0].needsSignIn,true);
  assert.equal(linked[0].token,null);
  assert.equal(linked[0].account.userName,'Movie fan');
});

test('offline status keeps a durable binding, isolates owners, and recovers after server restart',async t=>{
  const f=await fixture(t), id='a'.repeat(32);
  await f.store.set(`connector:${id}`,{ownerUid:'owner'},0);
  await f.store.set('user-connectors:owner',[{id,address:f.address}],0);
  const login=await f.login();
  const old=Date.now()-90*86400000;
  await f.store.update(`account:${login.body.token}`,value=>({...value,lastUsed:old}),0);
  const offline=await f.request('/status');
  assert.equal(offline.body.servers[0].status,'offline');
  assert.equal(offline.body.servers[0].bound,true);
  assert.equal(offline.body.servers[0].account.userName,'Movie fan');
  assert.equal(f.store.read(`account:${login.body.token}`).expires,0);
  assert.equal(f.store.read('jellyfin-links:owner').expires,0);
  assert.deepEqual((await f.request('/status',{user:'other'})).body.servers,[]);
  await f.store.set(`connector-online:${id}`,{lastSeen:Date.now()},30);
  await f.store.set(`connector-seen:${id}`,Date.now(),0);
  assert.equal((await f.request('/status')).body.servers[0].status,'ready');
  assert.equal((await f.request('/preferences',{body:{defaultServerId:id}})).status,204);
  assert.equal((await f.request('/preferences',{user:'other',body:{defaultServerId:id}})).status,404);
  f.restart();
  assert.equal((await f.request('/status')).body.defaultServerId,id);
  f.expire();f.restart();
  assert.equal((await f.request('/status')).body.servers[0].status,'sign_in_required');
  assert.equal((await f.request('/connections')).body.connections[0].needsSignIn,true);
});
