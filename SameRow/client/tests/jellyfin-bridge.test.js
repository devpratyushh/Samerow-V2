import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../../server/public/jellyfin-bridge.js', import.meta.url), 'utf8');
const tick = 10000000;

class Target {
  handlers = new Map();
  addEventListener(name, callback) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.handlers.get(name)?.delete(callback); }
  dispatchEvent(event) { this.handlers.get(event.type)?.forEach(callback => callback(event)); }
}

async function fixture({ directToggle = false, playError = null, queue = [] } = {}) {
  let now = 10000;
  const messages = [];
  const timers = new Map();
  let timerId = 0;
  const parent = { postMessage(message, origin) { messages.push({ ...message, origin }); } };
  const document = new Target();
  const video = Object.assign(new Target(), {
    readyState: 4, currentTime: 0, playbackRate: 1, paused: false, seeking: false,
    play() { if (playError) return Promise.reject(playError); this.paused = false; return Promise.resolve(); },
  });
  document.querySelector = () => video;
  document.documentElement = {};
  document.fullscreenElement = null;
  document.exitFullscreen = () => Promise.resolve();
  const window = Object.assign(new Target(), {
    __SAMEROW_JELLYFIN__: {
      channel: 'frame-channel', parentOrigin: 'https://samerow.test',
      serverId: 'server-id', serverName: 'Movies', serverAddress: 'https://samerow.test/native/session',
      userId: 'user-id', accessToken: 'frame-scoped-token', itemId: 'movie-id', duration: 300,
    },
    parent, document, navigator: {}, performance: { now: () => now },
    Element: class { requestFullscreen() { return Promise.resolve(); } },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout(callback) { const id = ++timerId; timers.set(id, { callback, interval: false }); return id; },
    setInterval(callback) { const id = ++timerId; timers.set(id, { callback, interval: true }); return id; },
    clearTimeout(id) { timers.delete(id); }, clearInterval(id) { timers.delete(id); },
    ApiClient: { serverId: () => 'server-id', getCurrentUserId: () => 'user-id' },
  });
  window.window = window;
  const context = createContext(window);
  runInContext(source, context);
  const callbacks = new Map();
  const calls = [];
  let active = false;
  let activeQueue = queue;
  const manager = {
    getCurrentPlayer: () => active ? {} : null,
    getPlayers: () => [{ name: 'Html Video Player' }],
    getPlayerState: () => ({ NowPlayingItem: { Id: 'movie-id' }, PlayState: { PositionTicks: video.currentTime * tick, IsPaused: video.paused } }),
    play(options) {
      calls.push(['play', options]); active = true; video.currentTime = options.startPositionTicks / tick;
      callbacks.get('playbackstart')?.(); return Promise.resolve();
    },
    pause() { calls.push(['pause']); video.paused = true; },
    unpause() { calls.push(['unpause']); video.paused = false; },
    seek(ticks) { calls.push(['seek', ticks]); video.currentTime = ticks / tick; },
    stop() { calls.push(['stop']); active = false; return Promise.resolve(); },
    playPause() {
      if (directToggle) video.paused = !video.paused;
      else if (video.paused) this.unpause();
      else this.pause();
    },
    setMaxStreamingBitrate(options) { calls.push(['quality', options]); this.pause(); this.seek(video.currentTime * tick); this.unpause(); },
    setAudioStreamIndex() { this.pause(); this.seek(0); this.unpause(); },
    getPlaylist: () => Promise.resolve(activeQueue),
    removeFromPlaylist(ids) { activeQueue = activeQueue.filter(item => !ids.includes(item.PlaylistItemId)); calls.push(['removeFromPlaylist', ids]); return Promise.resolve(); },
  };
  const events = {
    on(_target, name, callback) { callbacks.set(name, callback); },
    off(_target, name, callback) { if (callbacks.get(name) === callback) callbacks.delete(name); },
  };
  const Plugin = await window.SameRowBridge();
  new Plugin({ events, playbackManager: manager });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  await flush();
  return {
    window, document, video, manager, calls, messages, timers, callbacks, flush,
    commands: () => messages.filter(message => message.type === 'command'),
    input() { document.dispatchEvent({ type: 'click', isTrusted: true }); },
    advance(ms) { now += ms; },
    poll() { for (const timer of timers.values()) if (timer.interval) timer.callback(); },
    receive(message, overrides = {}) {
      window.dispatchEvent({ type: 'message', source: parent, origin: 'https://samerow.test',
        data: { source: 'samerow', channel: 'frame-channel', ...message }, ...overrides });
    },
  };
}

test('the native frame keeps credentials only in private storage and trusts only its parent channel', async () => {
  const f = await fixture();
  const credentials = JSON.parse(f.window.localStorage.getItem('jellyfin_credentials'));
  assert.equal(credentials.Servers[0].AccessToken, 'frame-scoped-token');
  assert.equal(f.window.sessionStorage.getItem('jellyfin_credentials'), null);
  const sync = { type: 'sync', state: { revision: 1, timestamp: 50, playing: false, duration: 300 } };
  f.receive(sync, { origin: 'https://attacker.test' });
  f.receive(sync, { source: {} });
  f.receive({ ...sync, channel: 'other-room' });
  assert.equal(f.window.__sameRowNativeDiagnostics.state.revision, null);
  f.receive(sync);
  assert.equal(f.video.currentTime, 50);
  assert.equal(f.video.paused, true);
  assert.equal(f.commands().length, 0, 'room corrections never echo into commands');
});

test('native pause, seek, and direct play/pause toggles broadcast user intent once', async () => {
  for (const directToggle of [true, false]) {
    const f = await fixture({ directToggle });
    f.manager.pause();
    assert.equal(f.commands().length, 0, 'programmatic calls without user input stay local');
    f.input(); f.manager.playPause();
    assert.deepEqual(f.commands().map(command => command.action), ['play']);
    f.advance(200); f.input(); f.manager.seek(45 * tick);
    assert.equal(f.commands()[1].action, 'seek');
    assert.equal(f.commands()[1].time, 45);
    f.advance(200); f.input(); f.manager.pause();
    assert.equal(f.commands()[2].action, 'pause');
  }
});

test('audio changes and their delayed player reloads do not pause or seek the room', async () => {
  const f = await fixture();
  f.input(); f.manager.setAudioStreamIndex(2);
  f.advance(300); f.manager.pause(); f.manager.seek(40 * tick); f.manager.unpause();
  assert.equal(f.commands().length, 0);
  f.advance(1600); f.input(); f.manager.pause();
  assert.equal(f.commands().length, 1, 'viewer controls resume after track reload');
});

test('shared revisions settle user commands and bound drift without repeatedly seeking', async () => {
  const f = await fixture();
  f.receive({ type: 'sync', state: { revision: 1, timestamp: 40, playing: false } });
  f.input(); f.manager.seek(70 * tick);
  f.poll();
  assert.equal(f.video.currentTime, 70, 'pending local seek survives stale room snapshots');
  f.receive({ type: 'sync', state: { revision: 0, timestamp: 10, playing: false } });
  assert.equal(f.window.__sameRowNativeDiagnostics.state.revision, 1);
  f.advance(2000);
  f.receive({ type: 'sync', state: { revision: 2, timestamp: 70, playing: true } });
  await f.flush();
  assert.equal(f.video.paused, false);
  f.advance(500); f.poll();
  assert.equal(f.video.playbackRate, 1.03);
  f.advance(2500); f.poll();
  assert.ok(f.video.currentTime >= 73);
  const count = f.calls.filter(call => call[0] === 'seek').length;
  f.poll(); f.poll();
  assert.equal(f.calls.filter(call => call[0] === 'seek').length, count);
  assert.equal(f.commands().length, 1);
});

test('autoplay rejection reports a local join action without changing shared playback', async () => {
  const error = new Error('User gesture required'); error.name = 'NotAllowedError';
  const f = await fixture({ playError: error });
  f.video.paused = true;
  f.receive({ type: 'sync', state: { revision: 1, timestamp: 0, playing: true } });
  await f.flush();
  assert.equal(f.window.__sameRowNativeDiagnostics.state.blocked, true);
  assert.ok(f.messages.some(message => message.type === 'status' && message.phase === 'blocked'));
  assert.equal(f.commands().length, 0);
});

test('the episode queue stays on the selected item, fullscreen belongs to the room, and disposal stops work', async () => {
  const f = await fixture({ queue: [
    { Id: 'movie-id', PlaylistItemId: 'selected' }, { Id: 'next-episode', PlaylistItemId: 'next' },
  ] });
  await f.flush();
  assert.deepEqual(Array.from(f.calls.find(call => call[0] === 'removeFromPlaylist')[1]), ['next']);
  await new f.window.Element().requestFullscreen();
  assert.equal(f.messages.at(-1).type, 'fullscreen');
  f.receive({ type: 'focus', focused: true, fullscreen: true });
  assert.equal(f.document.fullscreenElement, f.document.documentElement);
  f.window.dispatchEvent({ type: 'pagehide' });
  assert.equal(f.timers.size, 0);
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.commands().length, 0);
});


test('an ended native movie holds its final state and explicit replay opens from the new room position', async () => {
  const f = await fixture();
  f.receive({ type: 'sync', state: { revision: 1, timestamp: 300, duration: 300, playing: true } });
  f.video.currentTime = 300;
  f.video.dispatchEvent({ type: 'ended' });
  assert.equal(f.window.__sameRowNativeDiagnostics.state.phase, 'ended');
  const initialOpens = f.calls.filter(call => call[0] === 'play').length;
  f.poll(); await f.flush();
  assert.equal(f.calls.filter(call => call[0] === 'play').length, initialOpens);
  f.receive({ type: 'sync', state: { revision: 2, timestamp: 0, duration: 300, playing: true } });
  f.poll(); await f.flush();
  assert.equal(f.calls.filter(call => call[0] === 'play').length, initialOpens + 1);
  assert.equal(f.video.currentTime, 0);
});


test('quality changes use the native bitrate API and never broadcast shared controls', async () => {
  const f = await fixture();
  f.input();
  f.receive({ type: 'quality', policy: { mode: 'original', maxBitrate: 50000000 } });
  assert.equal(f.calls.filter(call => call[0] === 'quality').at(-1)[1].maxBitrate, 50000000);
  assert.equal(f.calls.filter(call => call[0] === 'quality').at(-1)[1].enableAutomaticBitrateDetection, false);
  f.receive({ type: 'quality', policy: { mode: 'original', maxBitrate: 50000000 } });
  assert.equal(f.calls.filter(call => call[0] === 'quality').length, 1, 'Periodic policy messages do not restart playback');
  f.receive({ type: 'quality', policy: { mode: 'auto', maxBitrate: 10000000 } });
  assert.equal(f.calls.filter(call => call[0] === 'quality').at(-1)[1].enableAutomaticBitrateDetection, true);
  assert.equal(f.commands().length, 0);
});

test('sustained Auto buffering reduces only local bitrate, bounds retries and recovers quality later', async () => {
  const f = await fixture();
  f.receive({ type: 'sync', state: { revision: 1, timestamp: 0, playing: true } });
  f.receive({ type: 'quality', policy: { mode: 'auto', maxBitrate: 40000000 } });
  f.video.readyState = 1; f.poll(); f.advance(8100); f.poll();
  let changes = f.calls.filter(call => call[0] === 'quality');
  assert.equal(changes.length, 1);
  assert.equal(changes[0][1].maxBitrate, 26000000);
  f.advance(9000); f.poll();
  assert.equal(f.calls.filter(call => call[0] === 'quality').length, 1, 'Cooldown prevents restart storms');
  f.video.readyState = 4; f.advance(120000); f.poll();
  changes = f.calls.filter(call => call[0] === 'quality');
  assert.equal(changes.at(-1)[1].enableAutomaticBitrateDetection, true);
  assert.equal(f.commands().length, 0);
  f.receive({ type: 'quality', policy: { mode: 'original', maxBitrate: 40000000 } });
  const before = f.calls.filter(call => call[0] === 'quality').length;
  f.video.readyState = 1; f.poll(); f.advance(40000); f.poll();
  assert.equal(f.calls.filter(call => call[0] === 'quality').length, before, 'Original never silently lowers the requested bitrate');
});
