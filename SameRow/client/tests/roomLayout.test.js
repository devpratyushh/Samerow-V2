import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSource, gridColumns, initials, formatTime } from '../src/components/roomLayout.js';

const sources = [{ id: 'people' }, { id: 'screen-jamie' }, { id: 'youtube' }, { id: 'jellyfin' }];

test('source focus follows shared content until a person makes an explicit selection', () => {
  assert.equal(resolveSource(null, sources), 'screen-jamie');
  assert.equal(resolveSource('youtube', sources), 'youtube');
  assert.equal(resolveSource('people', sources), 'people');
  // Adding another shared source must preserve a chosen view.
  assert.equal(resolveSource('youtube', [...sources, { id: 'screen-alex' }]), 'youtube');
  assert.equal(resolveSource('people', [...sources, { id: 'screen-alex' }]), 'people');
});

test('an ended source falls back to another live source, or the participant grid', () => {
  assert.equal(resolveSource('screen-jamie', sources.filter(source => source.id !== 'screen-jamie')), 'youtube');
  assert.equal(resolveSource('youtube', [{ id: 'people' }]), 'people');
  assert.equal(resolveSource(null, []), 'people');
});

test('participant grid adapts to portrait and wide space with a maximum of four columns', () => {
  assert.equal(gridColumns(1, 1200, 800), 1);
  assert.equal(gridColumns(2, 1200, 400), 2);
  assert.equal(gridColumns(2, 320, 640), 1);
  assert.equal(gridColumns(4, 1000, 700), 2);
  // Very narrow or temporarily hidden grids must keep at least one usable column.
  assert.equal(gridColumns(8, 240, 640), 1);
  assert.equal(gridColumns(4, 0, 0), 1);
  for (const count of [2, 4, 8, 12, 50]) {
    for (const [width, height] of [[320, 640], [768, 1024], [1440, 900], [844, 260]]) {
      const columns = gridColumns(count, width, height);
      assert.ok(Number.isInteger(columns));
      assert.ok(columns >= 1 && columns <= Math.min(count, 4));
      if (columns > 1) assert.ok((width - 12 * (columns - 1)) / columns >= 140);
    }
  }
});

test('playback clock formats missing, fractional, and hour-long positions safely', () => {
  for (const value of [undefined, null, NaN, Infinity, -1]) assert.equal(formatTime(value), '0:00');
  assert.equal(formatTime(9.9), '0:09');
  assert.equal(formatTime(754), '12:34');
  assert.equal(formatTime(3600), '1:00:00');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(formatTime(36000), '10:00:00');
});

test('camera-off avatars handle blank names and normalize surrounding whitespace', () => {
  assert.equal(initials(), '?');
  assert.equal(initials('   '), '?');
  assert.equal(initials('  Jamie   Chen  '), 'JC');
  assert.equal(initials('Alex'), 'A');
  assert.equal(initials('Alex Morgan Brooks'), 'AM');
});
