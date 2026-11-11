import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { maintainRoomMembership } from '../src/roomMembership.js';
import { maintainSession } from '../src/sessionRecovery.js';
import { maintainCall } from '../src/callRecovery.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const waitFor = async predicate => {
  const deadline = Date.now() + 1500;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Recovery timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
class Socket extends EventEmitter {
  connected = true; active = true; id = 'first'; requests = []; connects = 0;
  timeout() { return { emit: (event, ...args) => this.requests.push({ event, args, ack: args.at(-1) }) }; }
  connect() { this.connects++; }
}

test('room membership retries a lost acknowledgement and ignores stale replies after reconnect', async () => {
  const socket = new Socket(), ready = [];
  const stop = maintainRoomMembership({ socket, roomId: 'movie', userName: 'Viewer', onReady: value => ready.push(value), onWaiting() {}, onError() {}, retryDelay: () => 1 });
  const old = socket.requests[0]; old.ack(Error('timeout'));
  await waitFor(() => socket.requests.length === 2);
  socket.connected = false; socket.emit('disconnect'); socket.id = 'second'; socket.connected = true; socket.emit('connect');
  socket.requests[1].ack(null, { ok: true, mediaMode: 'mesh' });
  assert.equal(ready.length, 0, 'Old transport replies cannot mark the new room joined');
  socket.requests[2].ack(null, { ok: true, mediaMode: 'livekit' });
  assert.equal(ready.length, 1); assert.equal(socket.roomConfig.mediaMode, 'livekit');
  stop(); socket.emit('connect'); assert.equal(socket.requests.length, 3);
  assert.equal(socket.listenerCount('connect'), 0);
});

test('permission failures do not retry room admission indefinitely', async () => {
  const socket = new Socket();
  const stop = maintainRoomMembership({ socket, roomId: 'movie', userName: 'Viewer', onReady() {}, onWaiting() {}, onError() {}, retryDelay: () => 1 });
  socket.requests[0].ack(null, { error: 'Denied', status: 403 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(socket.requests.length, 1); stop();
});

test('session renewal updates a connected socket and retries a failed refresh', async () => {
  const socket = new Socket(); let tokens = 0;
  const stop = maintainSession({ socket, getToken: async () => `token-${++tokens}`, onError() {}, retryDelay: () => 1 });
  socket.emit('session-expiring'); await flush();
  assert.equal(socket.requests[0].event, 'auth-refresh');
  socket.requests[0].ack(Error('network'));
  await waitFor(() => socket.requests.length === 2);
  socket.requests[1].ack(null, { ok: true }); await flush();
  assert.equal(socket.auth.token, 'token-2'); assert.equal(socket.connects, 0);
  socket.connected = false; socket.active = false; socket.emit('disconnect', 'io server disconnect'); await flush();
  assert.equal(socket.connects, 1);
  stop(); socket.emit('session-expired'); await flush(); assert.equal(socket.connects, 1);
});

test('middleware rejection backs off and reconnects instead of leaving a dead socket', async () => {
  const socket = new Socket(); socket.connected = false; socket.active = false;
  const stop = maintainSession({ socket, getToken: async () => 'token', onError() {}, retryDelay: () => 1 });
  socket.emit('connect_error', new Error('Storage unavailable'));
  await waitFor(() => socket.connects === 1); stop();
});

function fakeCall() {
  return { closed: false, mutes: {}, screens: [], syncTracks: async () => {},
    setMuted: async function(kind, value) { this.mutes[kind] = value; },
    publishScreen: async function(screen) { this.screens.push(screen); },
    stopScreen: async () => {}, close() { this.closed = true; } };
}
test('SFU recovery retries initial failure, restores mute and screen state, and ignores old disconnects', async () => {
  const signal = new AbortController(), calls = [], opened = []; let attempts = 0;
  const screen = { getVideoTracks: () => [{ readyState: 'live' }] };
  const controller = maintainCall({ signal: signal.signal, retryDelay: () => 1, onError() {}, onPeers() {},
    open: async options => { opened.push(options); if (++attempts === 1) throw Error('Unavailable'); const call = fakeCall(); calls.push(call); return call; } });
  await controller.setMuted('audio', true); await controller.publishScreen(screen);
  await waitFor(() => calls[0]?.screens.length === 1);
  assert.equal(calls[0].mutes.audio, true);
  opened[1].onDisconnected(); await waitFor(() => calls[1]?.screens.length === 1);
  assert.equal(calls[0].closed, true); assert.equal(calls[1].mutes.audio, true);
  opened[1].onDisconnected(); await flush(); assert.equal(calls[1].closed, false);
  signal.abort(); assert.equal(calls[1].closed, true);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(attempts, 3);
});

test('leaving while an SFU connection is pending closes the late result without retrying', async () => {
  const signal = new AbortController(); let finish, attempts = 0;
  const controller = maintainCall({ signal: signal.signal, retryDelay: () => 1, onError() {}, onPeers() {}, open: () => { attempts++; return new Promise(resolve => { finish = resolve; }); } });
  controller.close(); const call = fakeCall(); finish(call); await flush();
  assert.equal(call.closed, true); assert.equal(attempts, 1);
});
