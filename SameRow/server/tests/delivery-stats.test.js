const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MemoryStore } = require('../store');
const { createDeliveryStats } = require('../deliveryStats');

test('gateway counts concurrent binary streams unchanged and scopes snapshots to session and members', async () => {
  const store = new MemoryStore(), stats = createDeliveryStats(store);
  const state = { id: 'movie' }, viewer = { socketId: 'alice', token: 'secret' };
  const input = Buffer.from([0, 1, 255, 9]);
  const send = async () => {
    const output = [];
    await pipeline(Readable.from([input, input]), stats.meter(viewer, state), new Writable({ write(chunk, encoding, done) { output.push(chunk); done(); } }));
    assert.deepEqual(Buffer.concat(output), Buffer.concat([input, input]));
  };
  await Promise.all([send(), send()]);
  const members = [{ id: 'alice', data: { userName: 'Alice' } }, { id: 'bob', data: { userName: 'Bob' } }];
  const snapshot = await stats.snapshot(state, members);
  assert.equal(snapshot.bytes, 16);
  assert.equal(snapshot.viewers[0].name, 'Alice');
  assert.equal(snapshot.viewers[1].bytes, 0);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.equal((await stats.snapshot({ id: 'other' }, members)).bytes, 0);
  assert.equal((await stats.snapshot(state, [members[1]])).bytes, 0);
  assert.deepEqual(store.read('delivery:movie:alice').value.bytes, 16);
});
test('playback reports sanitize fields and expire independently of byte counters', async () => {
  const store = new MemoryStore(), stats = createDeliveryStats(store), state = { id: 'movie' };
  await stats.report(state, 'alice', { width: 1920, height: -1, buffer: Infinity, dropped: 2, frames: 200, paused: false, secret: 'hidden' });
  const snapshot = await stats.snapshot(state, [{ id: 'alice' }]);
  assert.equal(snapshot.viewers[0].playback.width, 1920);
  assert.equal(snapshot.viewers[0].playback.height, null);
  assert.equal(snapshot.viewers[0].playback.buffer, null);
  assert.equal(snapshot.viewers[0].playback.secret, undefined);
  store.entries.get('playback:movie:alice').expires = Date.now() - 1;
  assert.equal((await stats.snapshot(state, [{ id: 'alice' }])).viewers[0].playback, null);
});

test('Redis shares delivery and playback counters between media and control replicas', { skip: !process.env.TEST_REDIS_URL }, async t => {
  const { randomUUID } = require('node:crypto');
  const { createStore } = require('../store');
  const config = { redisUrl: process.env.TEST_REDIS_URL, prefix: `delivery-test:${randomUUID()}`, encryptionKey: 'b'.repeat(64) };
  const a = await createStore(config), b = await createStore(config);
  t.after(async () => {
    const keys = await a.client.keys(`${config.prefix}:*`);
    if (keys.length) await a.client.del(keys);
    await a.close(); await b.close();
  });
  const media = createDeliveryStats(a), control = createDeliveryStats(b);
  const state = { id: 'movie' }, viewer = { socketId: 'alice' };
  const send = meter => pipeline(Readable.from([Buffer.alloc(1024)]), meter, new Writable({ write(chunk, encoding, done) { done(); } }));
  await Promise.all([send(media.meter(viewer, state)), send(control.meter(viewer, state))]);
  await media.report(state, 'alice', { width: 1280, height: 720, frames: 100 });
  const snapshot = await control.snapshot(state, [{ id: 'alice' }]);
  assert.equal(snapshot.bytes, 2048);
  assert.equal(snapshot.viewers[0].playback.width, 1280);
});
