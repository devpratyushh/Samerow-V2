import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import backend from '../../server/index.js';

const next = (socket, event) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, receive); reject(new Error(`Timed out: ${event}`)); }, 3000);
    function receive(value) { clearTimeout(timer); resolve(value); }
    socket.once(event, receive);
});

test('room synchronizes start, seek, pause, late join, replace and close; rejects outsiders', async () => {
    const { server, io } = backend;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${server.address().port}`;
    const users = [];
    const join = async (room) => {
        const user = connect(address, { transports: ['websocket'], forceNew: true });
        users.push(user);
        await next(user, 'connect');
        user.emit('join-room', room, 'Test user');
        const state = next(user, 'youtube-sync');
        user.emit('sync-request', room);
        await state;
        return user;
    };
    try {
        const host = await join('movie');
        const guest = await join('movie');
        const outsider = await join('other');
        const url = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';
        let update = next(guest, 'youtube-sync');
        host.emit('youtube-change', { roomId: 'movie', url, timestamp: 60 });
        let state = await update;
        assert.equal(state.url, url);
        assert.equal(state.isPlaying, true);
        assert.ok(state.timestamp >= 60);
        const firstSession = state.sessionId;

        update = next(guest, 'youtube-sync');
        host.emit('youtube-state-change', { roomId: 'movie', sessionId: firstSession, isPlaying: false, timestamp: 90 });
        state = await update;
        assert.equal(state.timestamp, 90);
        assert.equal(state.isPlaying, false);

        const late = await join('movie');
        update = next(late, 'youtube-sync');
        late.emit('sync-request', 'movie');
        assert.equal((await update).timestamp, 90);

        // Invalid messages are ordered before this sync request on the same connection.
        for (const timestamp of [-1, '20', null]) {
            host.emit('youtube-state-change', { roomId: 'movie', sessionId: firstSession, isPlaying: true, timestamp });
        }
        host.emit('youtube-change', { roomId: 'movie', url: 'https://attacker.test/video' });
        outsider.emit('youtube-change', { roomId: 'movie', url: null });
        outsider.emit('sync-request', 'movie');
        update = next(host, 'youtube-sync');
        host.emit('sync-request', 'movie');
        state = await update;
        assert.equal(state.timestamp, 90);
        assert.equal(state.url, url);

        update = next(guest, 'youtube-sync');
        host.emit('youtube-change', { roomId: 'movie', url });
        state = await update;
        assert.notEqual(state.sessionId, firstSession);
        assert.ok(state.timestamp < 1);

        host.emit('youtube-state-change', { roomId: 'movie', sessionId: firstSession, isPlaying: false, timestamp: 500 });
        update = next(host, 'youtube-sync');
        host.emit('sync-request', 'movie');
        assert.equal((await update).isPlaying, true);

        // Late joins receive elapsed playback time rather than the old start timestamp.
        await new Promise(resolve => setTimeout(resolve, 100));
        update = next(late, 'youtube-sync');
        late.emit('sync-request', 'movie');
        assert.ok((await update).timestamp >= 0.1);

        update = next(guest, 'youtube-sync');
        host.emit('youtube-change', { roomId: 'movie', url: null });
        state = await update;
        assert.equal(state.url, null);
        assert.equal(state.isPlaying, false);
        update = next(late, 'youtube-sync');
        late.emit('sync-request', 'movie');
        assert.equal((await update).url, null);
    } finally {
        users.forEach(user => user.disconnect());
        await new Promise(resolve => io.close(resolve));
    }
});
