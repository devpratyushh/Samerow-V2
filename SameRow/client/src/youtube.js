const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

export function parseYouTubeUrl(input) {
    try {
        const url = new URL(input.trim());
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        let id;
        if (url.hostname === 'youtu.be') id = parts[0];
        else if (HOSTS.has(url.hostname)) {
            id = parts[0] === 'watch' ? url.searchParams.get('v')
                : ['embed', 'shorts', 'live'].includes(parts[0]) ? parts[1] : null;
        }
        if (!VIDEO_ID.test(id || '')) return null;
        const time = url.searchParams.get('t') || url.searchParams.get('start') || new URLSearchParams(url.hash.slice(1)).get('t') || '0';
        const duration = time.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
        const startTime = /^\d+(?:\.\d+)?$/.test(time) ? Number(time)
            : duration ? Number(duration[1] || 0) * 3600 + Number(duration[2] || 0) * 60 + Number(duration[3] || 0) : 0;
        return { url: `https://www.youtube.com/watch?v=${id}`, startTime };
    } catch {
        return null;
    }
}

// Use a local monotonic clock; clients and the server need not share wall clocks.
export function playbackTime(state, now = performance.now()) {
    return state.timestamp + (state.isPlaying ? Math.max(0, now - state.receivedAt) / 1000 : 0);
}

export function youtubeErrorMessage(error) {
    const code = Number(error?.target?.error?.code ?? error?.code ?? error?.data ?? error);
    if (code === 101 || code === 150) return 'The video owner has disabled playback on other sites. Choose another video or open it on YouTube.';
    if (code === 100) return 'This video is unavailable or private. Choose another video.';
    if (code === 153) return 'YouTube could not verify this site. Try your regular browser and allow the YouTube player to load.';
    return 'YouTube could not play this video here. It may require sign-in or have embedding, age, or regional restrictions. Try another video or open it on YouTube.';
}
