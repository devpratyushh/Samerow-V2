import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerClock, createDriftController, commandServerTime } from '../src/playbackSync.js';
import youtube from '../../server/youtube.js';
const url = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';

test('clock calibration subtracts server processing and is independent of client wall time', () => {
  const clock = createServerClock();
  assert.equal(clock.offset(1000), null);
  assert.ok(clock.sample(1000, 1320, 900000150, 900000170));
  assert.equal(clock.offset(1320), 899999000);
  assert.equal(commandServerTime({serverTimeOffset:clock.offset(1320)}, 1500),900000500);
  assert.equal(commandServerTime({}, 1500),undefined);
});
test('lowest RTT sample resists jitter; stale calibration expires and reconnect resets it', () => {
  const clock = createServerClock();
  clock.sample(0, 100, 5050, 5050);
  clock.sample(1000, 1800, 6100, 6100);
  assert.equal(clock.offset(1800),5000);
  assert.equal(clock.offset(62000),null);
  clock.reset(); assert.equal(clock.offset(1800),null);
});
test('invalid clock samples cannot corrupt a valid estimate; clock steps recover', () => {
  const clock=createServerClock(); clock.sample(0,100,5050,5050);
  for (const args of [[NaN,1,1,1],[100,0,1,1],[0,10001,1,1],[0,100,100,99],[0,100,100,300]]) assert.equal(clock.sample(...args),false);
  assert.equal(clock.offset(100),5000);
  clock.sample(1000,1100,9050,9050); assert.equal(clock.offset(1100),8000);
});
const plan=(controller,options={})=>controller.correction({currentTime:10,target:10,playing:true,now:0,...options});
test('small jitter is ignored and paused frames use a tighter tolerance', () => {
  const controller=createDriftController();
  assert.deepEqual(plan(controller,{target:10.1}),{rate:1});
  assert.deepEqual(plan(controller,{target:10.1,playing:false}),{rate:1,seek:10.1});
});
test('supported small speed changes recover both directions and return to normal', () => {
  const controller=createDriftController(), rates=[0.5,0.95,1,1.05,1.25];
  assert.deepEqual(plan(controller,{target:10.5,rates}),{rate:1.05});
  assert.deepEqual(plan(controller,{target:9.5,rates,now:250}),{rate:0.95});
  assert.deepEqual(plan(controller,{target:10.05,rates,now:500}),{rate:1});
});
test('coarse YouTube rate steps use persistent-drift seeks instead of audible speed jumps', () => {
  const controller=createDriftController(), rates=[0.25,0.5,1,1.25,1.5,2];
  assert.deepEqual(plan(controller,{target:10.6,rates}),{rate:1});
  assert.deepEqual(plan(controller,{target:10.6,rates,now:1000}),{rate:1});
  assert.deepEqual(plan(controller,{target:10.6,rates,now:1500}),{rate:1,seek:10.6});
  assert.deepEqual(plan(controller,{target:10.6,rates,now:2000}),{rate:1});
});
test('large drift recovers immediately but seeks have a cooldown', () => {
  const controller=createDriftController();
  assert.deepEqual(plan(controller,{target:15}),{rate:1,seek:15});
  assert.deepEqual(plan(controller,{target:16,now:250}),{rate:1});
  assert.deepEqual(plan(controller,{target:17,now:2000}),{rate:1,seek:17});
  assert.deepEqual(plan(controller,{target:19,now:2100,force:true}),{rate:1,seek:19});
});
test('buffering, pending seeks, blocked playback and disconnect suspend drift recovery', () => {
  const controller=createDriftController();
  assert.deepEqual(plan(controller,{target:15,suspended:true,rates:[1,1.05]}),{rate:1});
  assert.deepEqual(plan(controller,{target:15,now:250}),{rate:1,seek:15});
  assert.deepEqual(plan(controller,{target:10,now:NaN}),{rate:1});
});
test('two clocks with different playback speeds recover stalls without seek storms', () => {
  for (const rates of [[1],[0.95,1,1.05]]) {
    const viewers=[{position:0,speed:0.99,rate:1,controller:createDriftController(),seeks:0},{position:0,speed:1.01,rate:1,controller:createDriftController(),seeks:0}];
    for(let now=0;now<=60000;now+=250) {
      for(const [index,viewer] of viewers.entries()) {
        const buffering=index===0&&now>=10000&&now<13000;
        if(now>0&&!buffering)viewer.position+=0.25*viewer.speed*viewer.rate;
        const correction=plan(viewer.controller,{currentTime:viewer.position,target:now/1000,now,rates,suspended:buffering,force:index===0&&now===13000});
        viewer.rate=correction.rate;
        if(correction.seek!==undefined){viewer.position=correction.seek;viewer.seeks++;}
      }
      if(now>14000)assert.ok(Math.abs(viewers[0].position-viewers[1].position)<0.75);
    }
    assert.ok(viewers.every(viewer=>viewer.seeks<15));
  }
});
test('server compensates calibrated command travel, preserves paused frames and increments revisions', () => {
  const state=youtube.createState(url,10,1000,7);
  const playing=youtube.updateState(state,{sessionId:state.sessionId,isPlaying:true,timestamp:20,sentAt:1200,commandId:'play-1'},1500);
  assert.equal(playing.timestamp,20.3); assert.equal(playing.revision,8);assert.equal(playing.commandId,'play-1');
  const paused=youtube.updateState(playing,{sessionId:state.sessionId,isPlaying:false,timestamp:25,sentAt:1600},1900);
  assert.equal(paused.timestamp,25);assert.equal(paused.revision,9);assert.equal(youtube.snapshot(paused,9900).timestamp,25);
  for(const sentAt of [NaN,Infinity,-99999,99999,undefined])assert.equal(youtube.updateState(state,{sessionId:state.sessionId,isPlaying:true,timestamp:20,sentAt},2000).timestamp,20);
});
