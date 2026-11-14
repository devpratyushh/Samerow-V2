import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingPlayback } from '../src/pendingPlayback.js';

test('rapid scrubs preserve the latest intent across stale polls and earlier echoes', () => {
  const pending = createPendingPlayback();
  const state = { sessionId: 'movie', revision: 5 };
  pending.begin(state, 'seek-1', 0);
  pending.begin(state, 'seek-2', 100);
  assert.equal(pending.accept({ ...state, timestamp: 10 }, 200), false);
  assert.equal(pending.accept({ ...state, revision: 6, commandId: 'seek-1', timestamp: 30 }, 300), false);
  assert.equal(pending.accept({ ...state, revision: 7, commandId: 'seek-2', timestamp: 60 }, 400), true);
});

test('remote commands, stop, session replacement, reconnect and timeout remain authoritative', () => {
  const pending = createPendingPlayback();
  const state = { sessionId: 'movie', revision: 5 };
  for (const incoming of [null, { sessionId: 'other', revision: 6 }, { ...state, revision: 6, commandId: 'remote' }]) {
    pending.begin(state, 'local', 0);
    assert.equal(pending.accept(incoming, 200), true);
  }
  pending.begin(state, 'local', 0);
  assert.equal(pending.accept(state, 5001), true);
  pending.begin(state, 'local', 6000);
  pending.reset();
  assert.equal(pending.accept(state, 6100), true);
});
