import test from 'node:test';
import assert from 'node:assert/strict';
import { rate, summarizeRtp } from '../src/nerdStats.js';
import { mediaBudget, tunePeer } from '../src/peerQuality.js';
import { playbackStats } from '../src/playbackStats.js';

test('rates use elapsed time and counter resets do not create negative throughput', () => {
  assert.equal(rate(1500000, 500000, 2000), 4000000);
  assert.equal(rate(10, 20, 1000), null);
  assert.equal(rate(20, 10, 0), null);
});
test('RTP reports isolate peers, deduplicate SDK reports and use interval packet loss', () => {
  const report = (bytes, timestamp, packets, lost) => new Map([
    ['video', { id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: bytes, timestamp, packetsReceived: packets, packetsLost: lost, frameWidth: 1280, frameHeight: 720, jitter: 0.02, codecId: 'codec' }],
    ['codec', { type: 'codec', mimeType: 'video/VP8' }],
  ]);
  const first = summarizeRtp([{ key: 'alice', name: 'Alice', report: report(100, 1000, 100, 9) }]);
  const source = { key: 'alice', name: 'Alice', report: report(500100, 2000, 190, 19) };
  const result = summarizeRtp([source, source, { ...source, key: 'bob' }], first.previous);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].bitrate, 4000000);
  assert.equal(result.rows[0].loss, 10);
  assert.equal(result.rows[0].jitter, 20);
  assert.equal(result.rows[0].codec, 'video/VP8');
  assert.equal(result.rows[1].bitrate, null);
  assert.equal(summarizeRtp([], result.previous).previous.size, 0);
});
test('high quality keeps LAN resolution across mesh sizes while balanced still bounds upload', async () => {
  assert.equal(mediaBudget(4).height, 180);
  assert.equal(mediaBudget(6, false, 'high').height, 720);
  assert.equal(mediaBudget(6, true, 'high').height, 1080);
  let applied;
  const peer = { _pc: { getStats: async () => new Map(), getSenders: () => [{ track: { kind: 'video', getSettings: () => ({ width: 1920 }) }, getParameters: () => ({ encodings: [{}] }), setParameters: async parameters => { applied = parameters; } }] } };
  tunePeer(peer, 5, false, 'high');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(applied.encodings[0].maxBitrate, 2500000);
  assert.equal(applied.encodings[0].scaleResolutionDownBy, 1.5);
});
test('playback stats report the current buffered range and preserve unsupported frame counts', () => {
  const stats = playbackStats({ videoWidth: 1920, videoHeight: 1080, currentTime: 25, paused: false, readyState: 4,
    buffered: { length: 2, start: i => [0, 20][i], end: i => [10, 40][i] } });
  assert.equal(stats.buffer, 15); assert.equal(stats.frames, null);
});
