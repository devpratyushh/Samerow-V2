const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { MemoryStore } = require('../store');
const { installJellyfin } = require('../jellyfin');

// Both the native plugin and Docker use a paired relay address.
for (const [name, room, code, message] of [
  ['public room', { ownerUid: 'owner' }, 'JELLYFIN_PRIVATE_ROOM_REQUIRED', /private room/],
  ['another owner’s private room', { ownerUid: 'other', invite: 'secret' }, 'JELLYFIN_ROOM_OWNER_REQUIRED', /room creator/],
  ['expired room', null, 'JELLYFIN_ROOM_OWNER_REQUIRED', /room creator/],
]) {
  test(`paired Jellyfin playback gives actionable guidance for ${name}`, async () => {
    const store = new MemoryStore();
    await store.set('room:ROOM', room);
    const handlers = new Map();
    let upstreamCalls = 0;
    const io = { on: (event, handler) => handlers.set(event, handler) };
    installJellyfin(express(), io, {
      getConnection: async () => ({ base: `https://${'a'.repeat(32)}.samerow-connector.invalid`, ownerUid: 'owner' }),
      request: async () => { upstreamCalls++; throw Error('must not reach upstream'); },
    }, { store, production: true });
    const events = new Map();
    handlers.get('connection')({
      rooms: new Set(['ROOM']), data: { uid: 'owner' },
      on: (event, handler) => events.set(event, handler),
    });
    let reply;
    await events.get('jellyfin-open')({ roomId: 'ROOM', connectionToken: 'connection', itemId: 'movie' }, value => { reply = value; });
    assert.equal(reply.code, code);
    assert.match(reply.error, message);
    assert.doesNotMatch(reply.error, /Docker/);
    assert.equal(upstreamCalls, 0);
  });
}
