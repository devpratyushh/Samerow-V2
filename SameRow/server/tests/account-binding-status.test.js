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
