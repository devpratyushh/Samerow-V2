import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPluginBinding} from '../src/pluginBinding.js';
import {resolveAccountOrigin} from '../src/jellyfinAccount.js';
test('a failed saved-library lookup does not block an owned plugin binding',async()=>{
 const server={id:'owned',address:'https://paired.example'};
 const result=await loadPluginBinding('owned',async()=>[server],async()=>{throw new Error('HTTP 403');});
 assert.equal(result.server,server);assert.equal(result.bound,null);assert.match(result.notice,/can still connect/);
});
test('restoration failure cannot grant access to a different account’s server',async()=>{
 await assert.rejects(loadPluginBinding('other',async()=>[{id:'owned'}],async()=>{throw Error('HTTP 403');}),/different SameRow account/);
});
test('account calls use the advertised media service rather than the signaling role',async()=>{
 assert.equal(await resolveAccountOrigin('https://signaling.example',{request:async()=>Response.json({mediaOrigin:'https://media.example'})}),'https://media.example');
 await assert.rejects(resolveAccountOrigin('https://secure.example',{request:async()=>Response.json({mediaOrigin:'http://unsafe.example'})}),/invalid media/);
});
