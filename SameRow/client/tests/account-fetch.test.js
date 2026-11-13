import test from 'node:test';
import assert from 'node:assert/strict';
import {accountFetch, configureSession} from '../src/session.js';
test('an account request refreshes a stale guest token after Google sign-in and retries once',async()=>{
 const calls=[]; configureSession(async force=>force?'google-user-token':'stale-guest-token');
 const result=await accountFetch('https://same-row.example/api/jellyfin/connections',{},async(url,options)=>{
  calls.push(options.headers['X-SameRow-Token']);return new Response(null,{status:calls.length===1?403:200});
 });
 assert.equal(result.status,200);assert.deepEqual(calls,['stale-guest-token','google-user-token']);
});
test('a real permission denial cannot be bypassed by retrying with the same token',async()=>{
 configureSession(async()=> 'same-token');let calls=0;
 assert.equal((await accountFetch('https://same-row.example',{},async()=>{calls++;return new Response(null,{status:403});})).status,403);
 assert.equal(calls,1);
});
