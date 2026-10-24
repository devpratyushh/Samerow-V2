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
function setup() {
    const socket = new Socket();
    const states = [], errors = [];
    let submitted = 0;
    const room = connectYouTubeRoom({socket, roomId:'test', userName:'Test', onState:state=>states.push(state), onSubmitted:()=>submitted++, onError:error=>errors.push(error)});
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
