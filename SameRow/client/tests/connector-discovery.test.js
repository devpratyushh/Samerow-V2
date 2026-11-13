import test from 'node:test';
import assert from 'node:assert/strict';
import { configureSession } from '../src/session.js';
import { discoverAccountConnectors } from '../src/connectorDiscovery.js';

test('split deployments discover the account server from the configured media role after control returns 404', async () => {
  configureSession(async () => 'same-google-account-token');
  const calls=[];
  const result=await discoverAccountConnectors('https://control.example',{request:async(url,options)=>{
    calls.push({url,headers:options.headers});
    if(url==='https://control.example/api/jellyfin-relay/connectors')return new Response(null,{status:404});
    if(url==='https://control.example/api/config')return Response.json({mediaOrigin:'https://media.example'});
    assert.equal(url,'https://media.example/api/jellyfin-relay/connectors');
    assert.equal(options.headers['X-SameRow-Token'],'same-google-account-token');
    return Response.json({connectors:[{id:'paired-server',online:true}]});
  }});
  assert.equal(result[0].id,'paired-server');
  assert.equal(calls.length,3);
});

test('account denial does not fall back to another service or guess an owner from email', async () => {
  let count=0;
  await assert.rejects(discoverAccountConnectors('https://control.example',{request:async()=>{count++;return new Response(null,{status:403});}}),/account that approved/);
  assert.equal(count,1);
});

test('malformed media origins cannot receive the account token', async () => {
  for(const mediaOrigin of ['http://untrusted.example','https://media.example/path','https://user:password@media.example','javascript:alert(1)']) {
    let count=0;
    await assert.rejects(discoverAccountConnectors('https://control.example',{request:async()=>{count++;return count===1?new Response(null,{status:404}):Response.json({mediaOrigin});}}),/HTTP 404/);
    assert.equal(count,2);
  }
});
