const { randomUUID } = require('node:crypto');

const isVideoUrl = (url) => typeof url === 'string' && /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(url);
const isTimestamp = (time) => typeof time === 'number' && Number.isFinite(time) && time >= 0;

function createState(url = null, timestamp = 0, now = Date.now()) {
  return { url, sessionId: randomUUID(), isPlaying: !!url, timestamp, lastUpdate: now };
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
  return { ...state, isPlaying: update.isPlaying, timestamp: update.timestamp, lastUpdate: now };
}

module.exports = { isVideoUrl, isTimestamp, createState, snapshot, updateState };
