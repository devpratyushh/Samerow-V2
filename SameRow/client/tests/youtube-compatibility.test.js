import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connectYouTubeRoom } from '../src/youtubeRoom.js';

const url = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';
class Socket extends EventEmitter {
    connected = true;
    sent = [];
    emit(event, value, ...args) { this.sent.push([event, value, ...args]); }
    receive(event, value) { super.emit(event, value); }
}
function setup(options = {}) {
    const socket = new Socket();
    const states = [], errors = [];
    let submitted = 0;
    const room = connectYouTubeRoom({socket, roomId:'test', userName:'Test', onState:state=>states.push(state), onSubmitted:()=>submitted++, onError:error=>errors.push(error),...options});
    return {socket, room, states, errors, get submitted() {return submitted;}};
}

test('hosted legacy change events open the player and confirm submission', () => {
    const context = setup();
    try {
        context.socket.receive('youtube-change', null);
        context.room.submit({url, startTime:42});
        assert.equal(context.submitted, 0);
        context.socket.receive('youtube-change', url);
        assert.equal(context.submitted, 1);
        assert.equal(context.states.at(-1).url, url);
        assert.equal(context.states.at(-1).timestamp, 42);
        assert.equal(context.states.at(-1).isPlaying, true);
        assert.deepEqual(context.socket.sent.at(-1), ['youtube-state-change',{roomId:'test',timestamp:42,isPlaying:true}]);
    } finally {context.room.dispose();}
});

test('legacy play, pause and late-join snapshots restore the video without remounting', () => {
    const context = setup();
    try {
        context.socket.receive('youtube-change', url);
        const session = context.states.at(-1).sessionId;
        context.socket.receive('youtube-state-change',{url,isPlaying:true,timestamp:30,lastUpdate:Date.now()-5000});
        assert.ok(context.states.at(-1).timestamp>=35);
        context.socket.receive('youtube-change',url);
        assert.equal(context.states.at(-1).sessionId,session);
        context.socket.receive('youtube-state-change',{isPlaying:false,timestamp:70});
        assert.equal(context.states.at(-1).timestamp,70);
        assert.equal(context.states.at(-1).isPlaying,false);
        context.socket.receive('youtube-change',null);
        assert.equal(context.states.at(-1).url,null);
    } finally {context.room.dispose();}
});

test('new server snapshots remain authoritative and legacy events cannot overwrite them', () => {
    const context = setup();
    try {
        context.room.submit({url,startTime:42});
        context.socket.receive('youtube-sync',{url,sessionId:'modern',timestamp:42,isPlaying:true});
        assert.equal(context.submitted,1);
        context.socket.receive('youtube-change',null);
        context.socket.receive('youtube-state-change',{isPlaying:false,timestamp:0});
        assert.equal(context.states.at(-1).sessionId,'modern');
        assert.equal(context.states.at(-1).timestamp,42);
        assert.equal(context.socket.sent.filter(([event])=>event==='youtube-state-change').length,0);
    } finally {context.room.dispose();}
});

test('unconfirmed submission reports an error instead of silently dismissing the form', t => {
    t.mock.timers.enable({apis:['setTimeout','setInterval']});
    const context=setup();
    try {
        context.room.submit({url,startTime:0});
        t.mock.timers.tick(8000);
        assert.equal(context.submitted,0);
        assert.match(context.errors[0],/did not confirm/);
    } finally {context.room.dispose();}
});

test('disconnect and disposal cancel submissions and remove event listeners', () => {
    const context=setup();
    context.room.submit({url,startTime:0});
    context.socket.receive('disconnect');
    assert.match(context.errors[0],/disconnected/);
    context.room.dispose();
    for (const event of ['youtube-sync','youtube-change','youtube-state-change','connect','disconnect']) assert.equal(context.socket.listenerCount(event),0);
    context.socket.receive('youtube-change',url);
    assert.equal(context.submitted,0);
});

test('acknowledged snapshots compensate downstream latency without using client wall time', () => {
    let time=1000;
    const context=setup({now:()=>time,wallNow:()=>9999999999999});
    try {
        const acknowledge=context.socket.sent.find(([event])=>event==='sync-request')[2];
        time=1400;
        acknowledge({state:{url,sessionId:'modern',revision:1,timestamp:10,isPlaying:true,lastUpdate:900001200},serverReceivedAt:900001200,serverSentAt:900001200});
        const state=context.states.at(-1);
        assert.equal(state.timestamp,10.2);
        assert.equal(state.serverTimeOffset,900000000);
        assert.equal(state.receivedAt,1400);
    } finally {context.room.dispose();}
});
test('late acknowledgments cannot undo a newer pause, replace a session, or survive disposal', () => {
    let time=1000;
    const context=setup({now:()=>time});
    const acknowledge=context.socket.sent.find(([event])=>event==='sync-request')[2];
    context.socket.receive('youtube-sync',{url,sessionId:'new',revision:4,timestamp:90,isPlaying:false,lastUpdate:900002000});
    time=1400;
    const reply={state:{url,sessionId:'old',revision:3,timestamp:10,isPlaying:true,lastUpdate:900001200},serverReceivedAt:900001200,serverSentAt:900001200};
    acknowledge(reply);
    assert.equal(context.states.at(-1).timestamp,90);assert.equal(context.states.at(-1).sessionId,'new');
    context.room.dispose();const count=context.states.length;acknowledge(reply);assert.equal(context.states.length,count);
});
test('reconnect accepts the restarted server revision and discards old connection acknowledgments', () => {
    let time=1000;
    const context=setup({now:()=>time});
    try {
        const acknowledge=context.socket.sent.find(([event])=>event==='sync-request')[2];
        context.socket.receive('youtube-sync',{url,sessionId:'old',revision:40,timestamp:90,isPlaying:false});
        context.socket.receive('disconnect'); context.socket.receive('connect'); time=1400;
        acknowledge({state:{url,sessionId:'old',revision:41,timestamp:100,isPlaying:true},serverReceivedAt:900001200,serverSentAt:900001200});
        context.socket.receive('youtube-sync',{url,sessionId:'restarted',revision:0,timestamp:5,isPlaying:false});
        assert.equal(context.states.at(-1).sessionId,'restarted');
    } finally {context.room.dispose();}
});
