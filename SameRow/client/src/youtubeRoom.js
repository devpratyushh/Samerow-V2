import { parseYouTubeUrl } from './youtube.js';

// Hosted rooms may still use the original change/state events during rollout.
export function connectYouTubeRoom({ socket, roomId, userName, onState, onSubmitted, onError, joinRoom = true }) {
    let modern = false;
    let current = null;
    let pending = null;
    let submitTimeout;

    const publish = (state) => {
        current = { ...state, receivedAt: performance.now() };
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
        if (!state || typeof state.sessionId !== 'string') return;
        modern = true;
        publish(state);
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
            ? Math.max(0, Date.now() - state.lastUpdate) / 1000 : 0;
        publish({ ...current, isPlaying: state.isPlaying, timestamp: state.timestamp + elapsed });
    };
    const requestState = () => {
        modern = false;
        if (joinRoom) socket.emit('join-room', roomId, userName);
        socket.emit('sync-request', roomId);
    };
    const disconnected = () => {
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
        if (socket.connected) socket.emit('sync-request', roomId);
    }, 10000);

    return {
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
