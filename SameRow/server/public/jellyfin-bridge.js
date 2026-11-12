/* SameRow's small plugin for the unmodified Jellyfin Web player.
 * Loaded before Jellyfin's bundles; config.json registers SameRowBridge.
 * Uses Jellyfin's public window-plugin dependency injection, never bundle IDs.
 */
(function () {
  'use strict';

  const config = window.__SAMEROW_JELLYFIN__;
  if (!config || !config.channel || !config.parentOrigin || window.parent === window) return;
  const TICKS = 10000000;
  const clock = () => performance.now();
  const send = (type, details = {}) => window.parent.postMessage({
    source: 'samerow-jellyfin', channel: config.channel, type, ...details,
  }, config.parentOrigin);

  // Opaque-origin sandboxing blocks browser Storage. Private memory also keeps
  // two room players from replacing one another's Jellyfin credentials.
  function memoryStorage() {
    const values = new Map();
    const storage = {
      get length() { return values.size; },
      key(index) { return [...values.keys()][Number(index)] ?? null; },
      getItem(key) { return values.get(String(key)) ?? null; },
      setItem(key, value) { values.set(String(key), String(value)); },
      removeItem(key) { values.delete(String(key)); },
      clear() { values.clear(); },
    };
    return new Proxy(storage, {
      get(target, key) { return key in target ? target[key] : values.get(String(key)); },
      set(target, key, value) { values.set(String(key), String(value)); return true; },
      deleteProperty(target, key) { values.delete(String(key)); return true; },
    });
  }
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: memoryStorage() });
    localStorage.setItem('jellyfin_credentials', JSON.stringify({ Servers: [{
      Id: config.serverId, Name: config.serverName || 'Jellyfin',
      ManualAddress: config.serverAddress, LocalAddress: config.serverAddress,
      RemoteAddress: config.serverAddress, LastConnectionMode: 2,
      UserId: config.userId, AccessToken: config.accessToken,
      DateLastAccessed: Date.now(), manualAddressOnly: true,
    }] }));
    localStorage.setItem('_deviceId2', `samerow-${config.channel}`);
    localStorage.setItem('enableAutoLogin', 'true');
    // A room has one selected item. Episode changes are selected in SameRow.
    localStorage.setItem('enableNextVideoInfoOverlay', 'false');
  } catch {
    send('status', { phase: 'error', message: 'This browser could not initialize the Jellyfin player.' });
    return;
  }

  // Jellyfin's optional browser services are unavailable inside an opaque
  // frame. Keep its preferences/caches in memory and workers isolated.
  Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: () => {} });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    controller: null, ready: new Promise(() => {}),
    getRegistrations: async () => [], getRegistration: async () => undefined,
    register: async () => ({ installing: null, waiting: null, active: null, scope: config.serverAddress + '/web/', addEventListener() {}, update: async () => {}, unregister: async () => true }),
    addEventListener() {}, removeEventListener() {},
  } });
  const NativeWorker = window.Worker;
  if (NativeWorker) window.Worker = class extends NativeWorker {
    constructor(url, options) {
      const address = new URL(url, location.href);
      if (address.protocol === 'blob:' || address.protocol === 'data:') { super(url, options); return; }
      const bootstrap = options?.type === 'module' ? `import ${JSON.stringify(address.href)};` : `importScripts(${JSON.stringify(address.href)});`;
      const blob = URL.createObjectURL(new Blob([bootstrap], { type: 'application/javascript' }));
      super(blob, options);
      setTimeout(() => URL.revokeObjectURL(blob), 10000);
    }
  };

  let focused = true;
  let roomFullscreen = false;
  let roomConnected = true;
  let preferredMuted = false;
  // Jellyfin's fullscreen button expands the complete SameRow room, preserving
  // the call panel. Mirror that state so its native button toggles correctly.
  const requestRoomFullscreen = () => { send('fullscreen', { fullscreen: true }); return Promise.resolve(); };
  const leaveRoomFullscreen = () => { send('fullscreen', { fullscreen: false }); return Promise.resolve(); };
  for (const key of ['requestFullscreen', 'webkitRequestFullscreen', 'mozRequestFullScreen', 'msRequestFullscreen']) {
    if (key in Element.prototype) {
      try { Object.defineProperty(Element.prototype, key, { configurable: true, value: requestRoomFullscreen }); } catch { /* platform method may be fixed */ }
    }
  }
  for (const key of ['exitFullscreen', 'webkitExitFullscreen', 'mozCancelFullScreen', 'msExitFullscreen']) {
    if (key in document) {
      try { Object.defineProperty(document, key, { configurable: true, value: leaveRoomFullscreen }); } catch { /* platform method may be fixed */ }
    }
  }
  for (const key of ['fullscreenElement', 'webkitFullscreenElement', 'mozFullScreenElement', 'msFullscreenElement']) {
    if (key in document) {
      try { Object.defineProperty(document, key, { configurable: true, get: () => roomFullscreen ? document.documentElement : null }); } catch { /* platform property may be fixed */ }
    }
  }

  let latest = null;
  let receivedAt = 0;
  let manager = null;
  let pluginReady = false;
  let disposed = false;
  let started = false;
  let opening = false;
  let suppression = 0;
  let lastInputAt = -Infinity;
  let lastLocalCommand = null;
  let lastSeekAt = -Infinity;
  let changingTrackUntil = 0;
  let lastStatus = '';
  let lastStatusAt = 0;
  let blocked = false;
  let resumePending = false;
  let nextOpenAt = 0;
  let video = null;
  let quality = null;
  let qualityKey = '';
  let appliedQualityKey = '';
  let bufferingSince = 0;
  let lastQualityChange = -Infinity;
  let fallbackBitrate = null;
  const listeners = [];
  const cleanup = [];

  function applyQuality() {
    if (!quality || !started || opening || !manager?.getCurrentPlayer() || typeof manager.setMaxStreamingBitrate !== 'function') return;
    if (qualityKey === appliedQualityKey) return;
    const initialAuto = !appliedQualityKey && quality.mode === 'auto';
    appliedQualityKey = qualityKey;
    fallbackBitrate = null;
    // Initial Auto is already negotiated by Jellyfin and the gateway.
    if (initialAuto) return;
    suppress(() => manager.setMaxStreamingBitrate({
      enableAutomaticBitrateDetection: quality.mode === 'auto', maxBitrate: quality.maxBitrate,
    }));
    changingTrackUntil = clock() + 15000;
    lastQualityChange = clock();
  }

  function adaptQuality() {
    if (quality?.mode !== 'auto' || !started || opening || !latest?.playing || blocked || !video || typeof manager?.setMaxStreamingBitrate !== 'function') return;
    if (video.readyState >= 3) {
      bufferingSince = 0;
      if (fallbackBitrate && clock() - lastQualityChange >= 120000) {
        fallbackBitrate = null; lastQualityChange = clock();
        suppress(() => manager.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: true, maxBitrate: quality.maxBitrate }));
        changingTrackUntil = clock() + 15000;
        send('quality-status', { message: 'Rechecking your connection for higher quality.' });
      }
      return;
    }
    bufferingSince ||= clock();
    if (clock() - bufferingSince < 8000 || clock() - lastQualityChange < 30000) return;
    const current = Math.min(quality.maxBitrate, fallbackBitrate || currentState()?.PlayState?.MaxStreamingBitrate || quality.maxBitrate);
    const bitrate = Math.max(250000, Math.floor(current * 0.65));
    if (bitrate >= current) return;
    fallbackBitrate = bitrate;
    lastQualityChange = clock(); bufferingSince = 0;
    suppress(() => manager.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: bitrate }));
    changingTrackUntil = clock() + 15000;
    send('quality-status', { message: 'Reduced quality on this device to recover from buffering.' });
  }

  function listen(target, name, callback, options) {
    target.addEventListener(name, callback, options);
    cleanup.push(() => target.removeEventListener(name, callback, options));
  }
  function currentState() {
    if (!manager?.getCurrentPlayer()) return null;
    try { return manager.getPlayerState(); } catch { return null; }
  }
  function currentTime() { return (currentState()?.PlayState?.PositionTicks || 0) / TICKS; }
  function status(phase, message) {
    const now = clock();
    if (phase === lastStatus && !message && now - lastStatusAt < 1000) return;
    lastStatus = phase; lastStatusAt = now;
    send('status', { phase, ...(message ? { message } : {}), time: currentTime() });
  }
  function suppress(callback) {
    suppression += 1;
    try { return callback(); } finally { suppression -= 1; }
  }
  async function stopPlayer() {
    if (disposed) return;
    disposed = true;
    // The room may already have revoked this player's access when it closes.
    try { await suppress(() => manager?.stop()); } catch { /* The player is closing. */ }
  }
  function clamp(time) {
    const duration = Number(latest?.duration || config.duration);
    return Math.max(0, Math.min(Number.isFinite(duration) && duration > 0 ? duration : Infinity, time));
  }
  function targetTime() { return clamp((latest?.timestamp || 0) + (latest?.playing ? (clock() - receivedAt) / 1000 : 0)); }
  function emitCommand(action, time = currentTime()) {
    if (disposed || suppression || !Number.isFinite(time)) return;
    const now = clock();
    // Only native controls operated by the viewer send room commands. Native
    // track reloads, autoplay, buffering and room corrections are local work.
    if (now - lastInputAt > 1800 || now < changingTrackUntil) return;
    if (lastLocalCommand && lastLocalCommand.action === action && Math.abs(lastLocalCommand.time - time) < 0.05 && now - lastLocalCommand.at < 100) return;
    blocked = false;
    lastLocalCommand = { action, time: clamp(time), at: now, revision: latest?.revision ?? -1 };
    send('command', { action, time: clamp(time) });
  }
  for (const event of ['pointerdown', 'pointerup', 'click', 'keydown', 'change']) {
    listen(document, event, e => { if (e.isTrusted) lastInputAt = clock(); }, true);
  }

  function bindVideo() {
    const next = document.querySelector('video');
    if (!next || next === video) return;
    video = next;
    if (!focused) { preferredMuted = next.muted; next.muted = true; }
    listen(next, 'waiting', () => { if (started) status('buffering'); });
    listen(next, 'playing', () => { blocked = false; status('playing'); });
    listen(next, 'pause', () => { if (started && clock() >= changingTrackUntil) status('paused'); });
    listen(next, 'error', () => status('error', 'Jellyfin could not play this video. Check the server playback settings.'));
    listen(next, 'ended', () => {
      started = false; status('ended');
      if (!suppression && latest?.playing && currentTime() >= Number(latest.duration) - 1) {
        send('command', { action: 'pause', time: clamp(currentTime()) });
      }
    });
  }

  async function resumeLocally() {
    if (!manager || !started || resumePending) return;
    resumePending = true;
    blocked = false;
    try {
      // Use the media promise to identify autoplay rejection. The native
      // player's unpause() does not return its HTMLMediaElement.play promise.
      bindVideo();
      if (video) await suppress(() => video.play());
      else suppress(() => manager.unpause());
    } catch (error) {
      if (error?.name === 'NotAllowedError') { blocked = true; status('blocked', 'Press play to join the room playback.'); }
      else status('error', 'Jellyfin could not resume playback.');
    } finally { resumePending = false; }
  }

  function synchronize() {
    if (disposed || !roomConnected || !started || opening || !latest || !manager?.getCurrentPlayer()) return;
    bindVideo();
    const now = clock();
    if (lastLocalCommand && latest.revision <= lastLocalCommand.revision && now - lastLocalCommand.at < 1800) return;
    if (now < changingTrackUntil && (!video || video.readyState < 2)) return;
    const state = currentState();
    if (!state?.PlayState || state.NowPlayingItem?.Id !== config.itemId) return;
    const time = Number(state.PlayState.PositionTicks || 0) / TICKS;
    const expected = targetTime();
    const drift = expected - time;
    const paused = !!state.PlayState.IsPaused;
    const needsSeek = Math.abs(drift) > (latest.playing ? 1.5 : 0.35);
    if (needsSeek && now - lastSeekAt >= 1800 && (!video || !video.seeking)) {
      lastSeekAt = now;
      suppress(() => manager.seek(Math.round(expected * TICKS)));
    }
    // Rate correction only applies to a loaded, directly playing video. HLS
    // restarts use the same bounded seek path and retain Jellyfin's track state.
    if (video && !video.seeking && video.readyState >= 3) {
      const rate = latest.playing && !paused && Math.abs(drift) > 0.25 && Math.abs(drift) < 1.5
        ? (drift > 0 ? 1.03 : 0.97) : 1;
      if (Math.abs(video.playbackRate - rate) > 0.005) video.playbackRate = rate;
    }
    if (!latest.playing && !paused) suppress(() => manager.pause());
    else if (latest.playing && paused && !blocked && clock() >= changingTrackUntil) void resumeLocally();
    if (!blocked && video?.readyState >= 2) status(latest.playing && !video.paused ? 'playing' : 'paused');
  }

  async function openItem() {
    if (disposed || opening || started || !pluginReady || !manager || clock() < nextOpenAt) return;
    if (latest && targetTime() >= Number(latest.duration || config.duration) - 0.1) { status('ended'); return; }
    const api = window.ApiClient;
    const players = manager.getPlayers?.() || [];
    if (!api || api.serverId?.() !== config.serverId || !api.getCurrentUserId?.() || !players.some(player => /video/i.test(player.name || ''))) return;
    opening = true;
    status('loading');
    try {
      await suppress(() => manager.play({
        ids: [config.itemId], serverId: config.serverId,
        startPositionTicks: Math.round(targetTime() * TICKS),
        fullscreen: true, enableRemotePlayers: false,
      }));
      if (disposed) return;
      started = true;
      bindVideo();
      if (latest && !latest.playing) suppress(() => manager.pause());
    } catch (error) {
      if (error?.name === 'NotAllowedError') {
        started = !!manager.getCurrentPlayer(); blocked = true;
        status('blocked', 'Press play to join the room playback.');
      } else {
        nextOpenAt = clock() + 5000;
        status('error', 'Jellyfin could not start this video. Check the server connection and playback settings.');
      }
    } finally { opening = false; }
  }

  window.SameRowBridge = async function () {
    return class SameRowBridge {
      constructor({ events, playbackManager }) {
        this.id = 'samerow-bridge';
        this.name = 'SameRow Watch Together';
        this.type = 'samerow';
        manager = playbackManager;
        const bind = (target, name, callback) => {
          events.on(target, name, callback);
          listeners.push(() => events.off(target, name, callback));
        };
        const originals = {};
        for (const [name, action] of [['pause', 'pause'], ['unpause', 'play'], ['seek', 'seek'], ['stop', 'stop']]) {
          if (typeof manager[name] !== 'function') continue;
          originals[name] = manager[name];
          manager[name] = function (...args) {
            const time = action === 'seek' ? Number(args[0]) / TICKS : currentTime();
            emitCommand(action, time);
            return originals[name].apply(this, args);
          };
          cleanup.push(() => { manager[name] = originals[name]; });
        }
        // Some native players implement their own toggle, bypassing the
        // manager's pause/unpause methods. Capture the intent exactly once.
        if (typeof manager.playPause === 'function') {
          const original = manager.playPause;
          manager.playPause = function (...args) {
            emitCommand(currentState()?.PlayState?.IsPaused ? 'play' : 'pause');
            return suppress(() => original.apply(this, args));
          };
          cleanup.push(() => { manager.playPause = original; });
        }
        // These native settings can recreate the media element asynchronously.
        // No pause/seek is inferred from the recreation or its DOM events.
        for (const name of ['setAudioStreamIndex', 'setSubtitleStreamIndex', 'setSecondarySubtitleStreamIndex', 'setMaxStreamingBitrate']) {
          if (typeof manager[name] !== 'function') continue;
          const original = manager[name];
          manager[name] = function (...args) {
            changingTrackUntil = clock() + 1500;
            return suppress(() => original.apply(this, args));
          };
          cleanup.push(() => { manager[name] = original; });
        }
        bind(manager, 'playbackstart', () => {
          started = true; changingTrackUntil = 0; bindVideo();
          // Jellyfin expands one episode into its remaining season. Keep the
          // selected item so its next/previous controls cannot leave the room.
          if (manager.getPlaylist && manager.removeFromPlaylist) {
            void Promise.resolve(manager.getPlaylist()).then(items => {
              if (disposed) return;
              const extra = items.filter(item => item.Id !== config.itemId).map(item => item.PlaylistItemId).filter(Boolean);
              if (extra.length) return suppress(() => manager.removeFromPlaylist(extra));
            }).catch(() => { /* restricted gateways already return one item */ });
          }
          if (!opening) synchronize();
        });
        bind(manager, 'playbackerror', () => status('error', 'Jellyfin reported a playback error. Try another quality setting or reconnect.'));
        bind(manager, 'playerchange', () => bindVideo());
        pluginReady = true;
        send('ready');
        void openItem();
      }
    };
  };

  listen(window, 'message', event => {
    const message = event.data;
    if (event.source !== window.parent || event.origin !== config.parentOrigin || message?.source !== 'samerow' || message.channel !== config.channel) return;
    if (message.type === 'sync') {
      roomConnected = message.connected !== false;
      const state = message.state;
      if (!state || !Number.isFinite(state.timestamp) || !Number.isFinite(state.revision) || typeof state.playing !== 'boolean') return;
      if (latest && state.revision < latest.revision) return;
      latest = { ...state, timestamp: clamp(state.timestamp) }; receivedAt = clock();
      synchronize();
    } else if (message.type === 'quality') {
      const policy = message.policy;
      if (!policy || !['auto', 'original'].includes(policy.mode) || !Number.isFinite(policy.maxBitrate) || policy.maxBitrate <= 0 || policy.maxBitrate > 1000000000) return;
      quality = policy;
      qualityKey = `${policy.mode}:${policy.maxBitrate}:${policy.revision || 0}`;
      applyQuality();
    } else if (message.type === 'play-local') {
      lastInputAt = clock();
      nextOpenAt = 0;
      if (!started) void openItem();
      else if (latest?.playing) void resumeLocally();
      else suppress(() => manager?.pause());
    } else if (message.type === 'focus') {
      const wasFocused = focused;
      focused = !!message.focused;
      roomFullscreen = !!message.fullscreen;
      if (video && wasFocused !== focused) {
        if (!focused) { preferredMuted = video.muted; video.muted = true; }
        else video.muted = preferredMuted;
      }
      document.dispatchEvent(new Event('fullscreenchange'));
      document.dispatchEvent(new Event('webkitfullscreenchange'));
    } else if (message.type === 'stop') {
      void stopPlayer();
    }
  });
  const interval = setInterval(() => {
    if (!disposed) { void openItem(); applyQuality(); adaptQuality(); synchronize(); }
  }, 250);
  const deadline = setTimeout(() => {
    if (!started && !disposed) status('error', 'The Jellyfin player did not finish loading. Reconnect to the server and try again.');
  }, 45000);
  cleanup.push(() => clearInterval(interval), () => clearTimeout(deadline));
  listen(window, 'pagehide', () => {
    void stopPlayer();
    listeners.forEach(remove => remove());
    cleanup.forEach(remove => remove());
  });
  Object.defineProperty(window, '__sameRowNativeDiagnostics', { value: {
    get state() {
      const state = currentState();
      return {
        ready: pluginReady, started, opening, blocked, phase: lastStatus,
        itemId: state?.NowPlayingItem?.Id || null,
        time: (state?.PlayState?.PositionTicks || 0) / TICKS,
        paused: state?.PlayState?.IsPaused ?? true,
        revision: latest?.revision ?? null,
        audioIndex: state?.PlayState?.AudioStreamIndex ?? null,
        subtitleIndex: state?.PlayState?.SubtitleStreamIndex ?? null,
        qualityMode: quality?.mode || 'auto',
        maxStreamingBitrate: state?.PlayState?.MaxStreamingBitrate ?? null,
        playMethod: state?.PlayState?.PlayMethod ?? null,
      };
    },
  } });
  status('loading');
})();
