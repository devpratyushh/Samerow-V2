import test from 'node:test';
import assert from 'node:assert/strict';
import { hlsFailure, mediaFailure, mediaReadiness } from '../src/playbackDiagnostics.js';

test('HLS diagnostics include the failure and HTTP status without request credentials', () => {
  assert.equal(hlsFailure({ details: 'manifestLoadError', response: { code: 503, url: 'https://gateway/api/private-token' }, error: new Error('private-token') }), 'manifestLoadError · HTTP 503');
  assert.equal(hlsFailure({ details: 'https://gateway/private-token', response: { code: 0 } }), 'HLS request failed');
  assert.equal(hlsFailure({ details: 'fragLoadTimeOut' }), 'fragLoadTimeOut');
});

test('browser diagnostics distinguish missing metadata and decode failures', () => {
  assert.equal(mediaFailure(3), 'MEDIA_ERR_DECODE');
  assert.equal(mediaFailure(4), 'MEDIA_ERR_SRC_NOT_SUPPORTED');
  assert.equal(mediaReadiness(0), 'No media metadata');
  assert.equal(mediaReadiness(3), 'Future frames available');
});
