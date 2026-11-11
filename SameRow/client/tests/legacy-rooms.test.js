import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { joinLegacyRoom } from '../src/legacyRooms.js';

test('legacy joins require playback state after the original join and sync events', async () => {
  const socket = new EventEmitter();
  const events = [];
  socket.on('join-room', (...args) => events.push(['join', ...args]));
  socket.on('sync-request', (...args) => events.push(['sync', ...args]));
  const joining = joinLegacyRoom(socket, 'ABCD', 'Guest');
  assert.deepEqual(events, [['join', 'ABCD', 'Guest'], ['sync', 'ABCD']]);
  socket.emit('youtube-sync', { error: 'not in room' });
  socket.emit('youtube-sync', { sessionId: 'state', timestamp: 0, isPlaying: false });
  assert.deepEqual(await joining, { ok: true, mediaMode: 'mesh' });
  assert.equal(socket.listenerCount('youtube-sync'), 0);
  assert.equal(socket.listenerCount('disconnect'), 0);
});

test('a legacy disconnect fails admission and removes listeners', async () => {
  const socket = new EventEmitter();
  const joining = joinLegacyRoom(socket, 'ABCD', 'Guest');
  socket.emit('disconnect');
  await assert.rejects(joining, /did not confirm/);
  assert.equal(socket.listenerCount('youtube-sync'), 0);
});
