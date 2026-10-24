import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeUrl, playbackTime, youtubeErrorMessage } from '../src/youtube.js';
import youtube from '../../server/youtube.js';

const url = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';

test('normalizes watch, short, Shorts, embed and live links without tracking or playlists', () => {
    for (const input of [url, 'https://youtu.be/M7lc1UVf-VE?si=abc', 'https://m.youtube.com/shorts/M7lc1UVf-VE', 'https://www.youtube.com/live/M7lc1UVf-VE?list=abc', 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE']) {
        assert.deepEqual(parseYouTubeUrl(input), { url, startTime: 0 });
    }
});

test('preserves shared start times in seconds and h/m/s notation', () => {
    assert.equal(parseYouTubeUrl(`${url}&t=1h2m3s`).startTime, 3723);
    assert.equal(parseYouTubeUrl(`${url}&start=42`).startTime, 42);
    assert.equal(parseYouTubeUrl(`${url}#t=90s`).startTime, 90);
    assert.equal(parseYouTubeUrl(`${url}&t=-4`).startTime, 0);
});

test('rejects non-YouTube sources, spoofed domains, credentials and invalid IDs', () => {
    for (const input of ['', 'https://vimeo.com/123', 'https://youtube.com.attacker.test/watch?v=M7lc1UVf-VE', 'https://youtube.com@attacker.test/watch?v=M7lc1UVf-VE', 'https://user:secret@youtube.com/watch?v=M7lc1UVf-VE', 'https://youtu.be/invalid', 'javascript:alert(1)', 'https://youtube.com/playlist?list=abc']) {
        assert.equal(parseYouTubeUrl(input), null, input);
    }
});

test('projects active playback across loading time, but holds paused playback still', () => {
    const state = { timestamp: 30, isPlaying: true, receivedAt: 1000 };
    assert.equal(playbackTime(state, 6000), 35);
    assert.equal(playbackTime({ ...state, isPlaying: false }, 6000), 30);
    assert.equal(playbackTime(state, 500), 30);
});

test('explains embedding restrictions and referrer errors from v3 media error events', () => {
    assert.match(youtubeErrorMessage({ target: { error: { code: 150 } } }), /disabled playback/);
    assert.match(youtubeErrorMessage({ data: 153 }), /verify this site/);
    assert.match(youtubeErrorMessage(100), /unavailable or private/);
    assert.match(youtubeErrorMessage({}), /restrictions/);
});

test('server advances active room position for late joiners without mutating stored state', () => {
    const state = youtube.createState(url, 12, 1000);
    assert.equal(youtube.snapshot(state, 6000).timestamp, 17);
    assert.equal(state.timestamp, 12);
    const paused = youtube.updateState(state, { sessionId: state.sessionId, isPlaying: false, timestamp: 19 }, 7000);
    assert.equal(youtube.snapshot(paused, 17000).timestamp, 19);
});

test('server rejects stale player events and invalid playback state', () => {
    const state = youtube.createState(url);
    for (const update of [
        { sessionId: 'old', isPlaying: true, timestamp: 1 },
        { sessionId: state.sessionId, isPlaying: 'true', timestamp: 1 },
        ...[-1, NaN, Infinity, '4'].map(timestamp => ({ sessionId: state.sessionId, isPlaying: true, timestamp }))
    ]) assert.equal(youtube.updateState(state, update), null);
    assert.equal(youtube.updateState(youtube.createState(), { sessionId: state.sessionId, isPlaying: true, timestamp: 0 }), null);
});
