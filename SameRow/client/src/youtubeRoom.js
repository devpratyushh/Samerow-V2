import { parseYouTubeUrl } from './youtube.js';
import { createServerClock } from './playbackSync.js';

// Hosted rooms may still use the original change/state events during rollout.
export function connectYouTubeRoom({ socket, roomId, userName, onState, onSubmitted, onError, joinRoom = true, now = () => performance.now(), wallNow = () => Date.now() }) {
    let modern = false;
    let current = null;
    let pending = null;
    let submitTimeout;
    let active = true;
    let generation = 0;
    let revision = -1;
    let lastRequest = -Infinity;
    const clock = createServerClock();
    const startupTimers = [];

    const publish = (state) => {
        current = { ...state, receivedAt: now() };
        onState(current);
    };
    const confirmSubmission = (url) => {
        if (!pending || pending.url !== url) return;
        const video = pending;
        pending = null;
        clearTimeout(submitTimeout);
        // The old server ignores start times on youtube-change and excludes
        // the sender when broadcasting state changes, so update both here.
        if (!modern) {
            publish({ ...current, timestamp: video.startTime, isPlaying: true });
            socket.emit('youtube-state-change', { roomId, timestamp: video.startTime, isPlaying: true });
        }
        onSubmitted();
    };
    const receiveSnapshot = (state) => {
        if (state === null) {
            if (revision < 0) { modern = true; current = null; onState(null); }
            return;
        }
        if (!state || typeof state.sessionId !== 'string') return;
        if (!Number.isFinite(state.timestamp) || state.timestamp < 0 || typeof state.isPlaying !== 'boolean') return;
        if (Number.isFinite(state.revision)) {
            if (state.revision < revision) return;
            revision = state.revision;
        } else if (revision >= 0) return;
        modern = true;
        const offset = clock.offset(now());
        const age = offset !== null && Number.isFinite(state.lastUpdate) ? Math.max(0, now() + offset - state.lastUpdate) / 1000 : 0;
        publish({ ...state, timestamp: state.timestamp + (state.isPlaying ? age : 0), serverTimeOffset: offset });
        confirmSubmission(state.url);
    };
    const receiveUrl = (url) => {
        if (modern) return;
        const video = url ? parseYouTubeUrl(url) : null;
        if (url && !video) return;
        const normalized = video?.url || null;
        if (!current || current.url !== normalized) {
            publish({ url: normalized, sessionId: `legacy:${normalized}`, isPlaying: !!normalized, timestamp: 0 });
        }
        confirmSubmission(normalized);
    };
    const receivePlayback = (state) => {
        if (modern || !state || typeof state.isPlaying !== 'boolean' || !Number.isFinite(state.timestamp) || state.timestamp < 0) return;
        if (Object.hasOwn(state, 'url')) receiveUrl(state.url);
        if (!current?.url) return;
        const elapsed = state.isPlaying && Number.isFinite(state.lastUpdate)
            ? Math.max(0, wallNow() - state.lastUpdate) / 1000 : 0;
        publish({ ...current, isPlaying: state.isPlaying, timestamp: state.timestamp + elapsed });
    };
    const requestSync = () => {
        if (!active || !socket.connected) return;
        const sentAt = now();
        const requestGeneration = generation;
        lastRequest = sentAt;
        const receiveReply = reply => {
            if (!active || requestGeneration !== generation || !socket.connected || !reply || !Object.hasOwn(reply, 'state')) return;
            if (clock.sample(sentAt, now(), reply.serverReceivedAt, reply.serverSentAt)) receiveSnapshot(reply.state);
        };
        if (typeof socket.timeout === 'function') {
            socket.timeout(3000).emit('sync-request', roomId, (error, reply) => { if (!error) receiveReply(reply); });
        } else socket.emit('sync-request', roomId, receiveReply);
    };
    const requestState = () => {
        generation++; modern = false; revision = -1; clock.reset();
        startupTimers.splice(0).forEach(clearTimeout);
        if (joinRoom) socket.emit('join-room', roomId, userName);
        requestSync();
        // Several early samples avoid keeping a cold connection's slow first RTT.
        for (const delay of [250, 1000]) startupTimers.push(setTimeout(requestSync, delay));
    };
    const disconnected = () => {
        generation++; clock.reset();
        startupTimers.splice(0).forEach(clearTimeout);
        if (!pending) return;
        clearTimeout(submitTimeout);
        pending = null;
        onError('The room disconnected. Reconnect and try the link again.');
    };

    socket.on('youtube-sync', receiveSnapshot);
    socket.on('youtube-change', receiveUrl);
    socket.on('youtube-state-change', receivePlayback);
    socket.on('connect', requestState);
    socket.on('disconnect', disconnected);
    if (socket.connected) requestState();
    const interval = setInterval(() => {
        if (current?.url || now() - lastRequest >= 10000) requestSync();
    }, 2000);
    const onVisible = () => { if (document.visibilityState === 'visible') requestSync(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

    return {
        sync: requestSync,
        submit(video) {
            if (!socket.connected) {
                onError('Reconnecting to the room. Try again when connected.');
                return;
            }
            pending = video;
            clearTimeout(submitTimeout);
            submitTimeout = setTimeout(() => {
                pending = null;
                onError('The room did not confirm the video. Please try again.');
            }, 8000);
            socket.emit('youtube-change', { roomId, url: video.url, timestamp: video.startTime });
        },
        close() {
            socket.emit('youtube-change', { roomId, url: null });
        },
        dispose() {
            active = false; generation++;
            startupTimers.splice(0).forEach(clearTimeout);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
            clearInterval(interval);
            clearTimeout(submitTimeout);
            socket.off('youtube-sync', receiveSnapshot);
            socket.off('youtube-change', receiveUrl);
            socket.off('youtube-state-change', receivePlayback);
            socket.off('connect', requestState);
            socket.off('disconnect', disconnected);
        }
    };
}
