const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MemoryStore, createStore } = require('../store');
const { createQualityPolicy, negotiateQuality, sourceInfo } = require('../jellyfinQuality');
const { configuration } = require('../config');

const movie = base => ({ base, sourceId: 'source', item: { MediaSources: [{ Id: 'source', Bitrate: 40000000, MediaStreams: [{ Type: 'Video', Width: 3840, Height: 2160 }] }] } });

test('manual quality caps apply per viewer and obey shared capacity', async () => {
  const policy = createQualityPolicy(new MemoryStore(), { gatewayMbps: 10 });
  const state = movie('https://movies.example');
  const first = { token: 'manual', qualityMode: '4mbps' };
  const second = { token: 'original', qualityMode: 'original' };
  assert.equal((await policy.describe(first, state)).maxBitrate, 4000000);
  assert.equal((await policy.describe(second, state)).mode, 'original');
  assert.equal((await policy.describe(first, state)).maxBitrate, 4000000);
});

test('quality respects the narrower shared budget and releases capacity when viewers leave', async () => {
  const store = new MemoryStore(), policy = createQualityPolicy(store, { gatewayMbps: 1000, originMbps: 100 });
  const state = movie('https://movies.example/library');
  const one = { token: 'one', qualityMode: 'original' }, two = { token: 'two' }, three = { token: 'three' };
  await policy.renew(one, state); await policy.renew(two, state); await policy.renew(three, state);
  assert.equal((await policy.describe(one, state)).maxBitrate, 26666666);
  await policy.release(two, state); await policy.release(three, state);
  assert.equal((await policy.describe(one, state)).maxBitrate, 50000000);
  // Another origin uses its own upload budget, but the same gateway budget.
  await policy.renew(two, movie('https://another.example'));
  assert.equal((await policy.describe(one, state)).maxBitrate, 50000000);
  assert.throws(() => configuration({ JELLYFIN_ORIGIN_BANDWIDTH_MBPS: 'NaN' }));
  assert.throws(() => configuration({ JELLYFIN_GATEWAY_BANDWIDTH_MBPS: '-1' }));
});

test('Original preserves decoder/subtitle constraints; Auto retains measured bandwidth', () => {
  const body = { MaxStreamingBitrate: 3000000, AllowVideoStreamCopy: false, SubtitleStreamIndex: 5,
    DeviceProfile: { MaxStreamingBitrate: 3000000, CodecProfiles: [{ Codec: 'hevc', Conditions: [{ Property: 'VideoBitDepth', Value: '10' }] }] } };
  const original = negotiateQuality(body, { mode: 'original', maxBitrate: 50000000 });
  assert.equal(original.MaxStreamingBitrate, 50000000);
  assert.deepEqual(original.DeviceProfile.CodecProfiles, body.DeviceProfile.CodecProfiles);
  assert.equal(original.AllowVideoStreamCopy, false);
  assert.equal(original.SubtitleStreamIndex, 5);
  assert.equal(negotiateQuality(body, { mode: 'auto', maxBitrate: 50000000 }).MaxStreamingBitrate, 3000000);
  assert.equal(negotiateQuality(body, { mode: 'original', maxBitrate: 2000000 }).MaxStreamingBitrate, 2000000);
  assert.equal(body.DeviceProfile.MaxStreamingBitrate, 3000000, 'Do not mutate caller capabilities');
  assert.equal(sourceInfo({ item: { MediaSources: [{ MediaStreams: [{ Type: 'Audio', BitRate: 192000 }] }] } }).bitrate, null, 'Audio metadata alone cannot estimate original video bitrate');
});

test('Redis viewer leases share capacity across replicas, expire after crashes, and hide bearer tokens', { skip: !process.env.TEST_REDIS_URL }, async t => {
  const config = { redisUrl: process.env.TEST_REDIS_URL, prefix: `quality-test:${randomUUID()}`, encryptionKey: 'b'.repeat(64) };
  const a = await createStore(config), b = await createStore(config);
  t.after(async () => {
    const keys = await a.client.keys(`${config.prefix}:*`);
    if (keys.length) await a.client.del(keys);
    await a.close(); await b.close();
  });
  assert.equal(await a.leaseCount('gateway', 'secret-bearer-one', 1), 1);
  assert.equal(await b.leaseCount('gateway', 'secret-bearer-two', 1), 2);
  assert.equal(await a.leaseCount('gateway', 'secret-bearer-one', 1), 2, 'Renewal does not double count');
  const stored = await a.client.zRange(a.key('leases:gateway'), 0, -1);
  assert.ok(stored.every(member => !member.includes('secret-bearer')));
  await b.releaseLease('gateway', 'secret-bearer-two');
  assert.equal(await a.leaseCount('gateway', 'secret-bearer-one', 1), 1);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await b.leaseCount('gateway', 'replacement', 1), 1, 'A crashed viewer does not retain a permanent share');
  const first = createQualityPolicy(a, { gatewayMbps: 100 }), second = createQualityPolicy(b, { gatewayMbps: 100 });
  const state = movie('https://movies.example');
  await first.renew({ token: 'alice' }, state); await second.renew({ token: 'bob' }, state);
  assert.equal((await first.describe({ token: 'alice' }, state)).maxBitrate, 40000000);
});
