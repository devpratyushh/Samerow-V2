const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const http=require('node:http');
const {createHash}=require('node:crypto');
const {MemoryStore}=require('../store');
const {installJellyfinRelay}=require('../jellyfinRelay');
test('plugin binding status exposes only its owning account label and linked Jellyfin user',async t=>{
 const store=new MemoryStore(),app=express(),id='a'.repeat(32),token=`${id}.${'b'.repeat(64)}`;
 await store.set(`connector:${id}`,{ownerUid:'owner',ownerEmail:'owner@example.com',digest:createHash('sha256').update(token).digest('hex')});
 await store.set('jellyfin-links:owner',['private-account-token']);
 await store.set('account:private-account-token',{ownerUid:'owner',accountLinked:true,base:`https://${id}.samerow-connector.invalid`,userName:'Movie fan',serverName:'Home cinema',apiToken:'upstream-secret'});
 const relay=installJellyfinRelay(app,{store,config:{jellyfinRelay:true,serviceRole:'media',encryptionKey:'c'.repeat(64)},identity:{verify:async()=>({uid:'other'})}});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{relay.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const url=`http://127.0.0.1:${server.address().port}/api/jellyfin-relay/account-binding`;
 assert.equal((await fetch(url)).status,401);
 const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
 assert.deepEqual(await response.json(),{sameRowEmail:'owner@example.com',jellyfinAccount:{userName:'Movie fan',serverName:'Home cinema'}});
 assert.equal(response.headers.get('cache-control'),'no-store');
 await store.set(`connector:${id}`,null);
 assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${token}`}})).status,401);
});

test('a valid connector missing from the discovery index is recovered without transferring ownership',async t=>{
 const store=new MemoryStore(),app=express(),id='d'.repeat(32),record={ownerUid:'owner',digest:'digest'};
 await store.set(`connector:${id}`,record);
 const relay=installJellyfinRelay(app,{store,config:{jellyfinRelay:true,serviceRole:'media',encryptionKey:'c'.repeat(64)},identity:{verify:async token=>({uid:token})}});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{relay.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const origin=`http://127.0.0.1:${server.address().port}/api/jellyfin-relay`;
 assert.equal((await fetch(`${origin}/connectors/${id}`,{headers:{'X-SameRow-Token':'other'}})).status,404);
 assert.equal(await store.get('user-connectors:other'),null);
 const restored=await fetch(`${origin}/connectors/${id}`,{headers:{'X-SameRow-Token':'owner'}});
 assert.equal(restored.status,200);
 assert.equal((await restored.json()).connector.id,id);
 assert.equal((await store.get('user-connectors:owner'))[0].id,id);
 assert.equal((await fetch(`${origin}/connectors`,{headers:{'X-SameRow-Token':'owner'}}).then(r=>r.json())).connectors[0].id,id);
});

test('Redis: durable ownership and guarded indexes have no inactivity expiry', {skip:!process.env.TEST_REDIS_URL}, async t=>{
 const {createStore}=require('../store');
 const store=await createStore({redisUrl:process.env.TEST_REDIS_URL,encryptionKey:'a'.repeat(64),prefix:`availability:${require('node:crypto').randomUUID()}`});
 t.after(()=>store.close());
 const record={ownerUid:'owner'};
 await store.set('connector:test',record,1);
 await store.touch('connector:test',0);
 assert.equal(await store.client.ttl(store.key('connector:test')),-1);
 assert.equal(await store.guardedSet('connector:test',record,'index:test',['server'],0),true);
 await store.guardedUpdate('connector:test',record,'index:test',list=>[...list,'second'],0);
 assert.equal(await store.client.ttl(store.key('index:test')),-1);
 await store.set('connector:test',null);
 assert.equal(await store.guardedUpdate('connector:test',record,'index:test',()=>['resurrected'],0),null);
 assert.deepEqual(await store.get('index:test'),['server','second']);
 await store.set('index:test',null);
});

test('concurrent polls share the worker limit and rejected polls do not renew health',async t=>{
 const store=new MemoryStore(),app=express(),id='e'.repeat(32),token=`${id}.${'f'.repeat(64)}`;
 await store.set(`connector:${id}`,{ownerUid:'owner',digest:createHash('sha256').update(token).digest('hex')},0);
 const relay=installJellyfinRelay(app,{store,config:{jellyfinRelay:true,serviceRole:'media',encryptionKey:'c'.repeat(64)},identity:{verify:async()=>({uid:'owner'})}});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const controller=new AbortController();
 t.after(async()=>{controller.abort();relay.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const url=`http://127.0.0.1:${server.address().port}/api/jellyfin-relay/poll`;
 const workers=Array.from({length:8},()=>fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal}).catch(()=>null));
 await new Promise(r=>setTimeout(r,100));
 const seen=await store.get(`connector-seen:${id}`);
 assert.equal(typeof seen,'number');
 assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${token}`}})).status,429);
 assert.equal(await store.get(`connector-seen:${id}`),seen);
 controller.abort();await Promise.all(workers);
});
