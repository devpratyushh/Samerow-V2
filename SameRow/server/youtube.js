const { randomUUID } = require('node:crypto');

const isVideoUrl = (url) => typeof url === 'string' && /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(url);
const isTimestamp = (time) => typeof time === 'number' && Number.isFinite(time) && time >= 0;

function createState(url = null, timestamp = 0, now = Date.now(), revision = 0) {
  return { revision, url, sessionId: randomUUID(), isPlaying: !!url, timestamp, lastUpdate: now };
}

function snapshot(state, now = Date.now()) {
  return {
    ...state,
    timestamp: state.timestamp + (state.isPlaying ? Math.max(0, now - state.lastUpdate) / 1000 : 0),
    lastUpdate: now
  };
}

function updateState(state, update, now = Date.now()) {
  if (!state?.url || update.sessionId !== state.sessionId || typeof update.isPlaying !== 'boolean' || !isTimestamp(update.timestamp)) return null;
  // The sender's calibrated server timestamp accounts for travel to this server.
  // Old clients omit it; unreasonable or stale estimates never advance the clock.
  const age = Number.isFinite(update.sentAt) && update.sentAt <= now + 100 && now - update.sentAt <= 5000
    ? Math.max(0, now - update.sentAt) / 1000 : 0;
  return { ...state, commandId: typeof update.commandId === 'string' && update.commandId.length <= 128 ? update.commandId : null, revision: (state.revision || 0) + 1, isPlaying: update.isPlaying,
    timestamp: update.timestamp + (update.isPlaying ? age : 0), lastUpdate: now };
}

module.exports = { isVideoUrl, isTimestamp, createState, snapshot, updateState };
