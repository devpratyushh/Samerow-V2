import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackNetwork, diagnosticLoader, networkDiagnosis } from '../src/playbackNetwork.js';

test('request telemetry measures waiting, first byte, bytes and completion without retaining credentials', () => {
  let time = 10;
  const network = createPlaybackNetwork(() => time);
  const update = network.begin('manifest');
  time = 2010;
  assert.match(networkDiagnosis(network.snapshot()), /2.0s. No response bytes/);
  update('Downloading', { loaded: 1024, loading: { start: 10, first: 510 } });
  assert.match(networkDiagnosis(network.snapshot()), /1 KiB/);
  time = 4010;
  update('Complete', { loaded: 2048, retry: 1, loading: { start: 10, first: 510 } }, 200);
  const snapshot = network.snapshot();
  assert.equal(snapshot.transferred, 2048);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.requests[0].ttfb, 500);
  assert.equal(snapshot.requests[0].throughput, 4096);
  assert.equal(snapshot.requests[0].retries, 1);
});

test('loader preserves HLS callbacks and counts failures, timeouts and parallel requests', () => {
  class Loader { load(context, config, callbacks) { this.callbacks = callbacks; } }
  const network = createPlaybackNetwork();
  const DiagnosticLoader = diagnosticLoader(Loader, network);
  const loader = new DiagnosticLoader();
  let result;
  loader.load({ type: 'manifest', url: 'https://host/private-token' }, {}, { onError: (...args) => { result = args; } });
  network.begin('key')('Timed out', { loaded: 0 });
  loader.callbacks.onError({ code: 503, text: 'secret' }, {}, null, { loaded: 100 });
  assert.equal(result[0].code, 503);
  assert.equal(network.snapshot().failures, 2);
  assert.equal(network.snapshot().transferred, 100);
  assert.doesNotMatch(JSON.stringify(network.snapshot()), /private-token|secret|https/);
});
