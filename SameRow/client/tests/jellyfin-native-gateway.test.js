import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { io as connect } from 'socket.io-client';
const require = createRequire(new URL('../../server/index.js', import.meta.url));
const express = require('express');
const { Server } = require('socket.io');
const { installJellyfin } = require('./jellyfin');
const { upstreamRequest } = require('./jellyfinAccounts');
const next = (socket, event) => new Promise(resolve => socket.once(event, resolve));
const ack = (socket, event, ...args) => new Promise((resolve, reject) => socket.timeout(3000).emit(event, ...args, (error, reply) => error ? reject(error) : resolve(reply)));

test('native Jellyfin gateway limits guests to the shared item, rewrites credentials, isolates preferences and revokes access', async () => {
  const requests = [];
  const item = { Id: 'movie', Name: 'Room movie', Type: 'Movie', RunTimeTicks: 600000000, Path: '/private/library/movie.mp4', MediaSources: [{ Id: 'source', Container: 'mp4', RunTimeTicks: 600000000, MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264' }, { Index: 1, Type: 'Audio', Codec: 'aac' }] }] };
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (!req.headers.authorization?.includes('Token="owner-secret"')) { res.writeHead(401).end('{}'); return; }
    if (url.pathname === '/Users/user/Items/movie') { res.end(JSON.stringify(item)); return; }
    if (url.pathname === '/web/config.json') { res.end(JSON.stringify({ plugins: ['htmlVideoPlayer/plugin', 'chromecastPlayer/plugin'] })); return; }
    if (url.pathname === '/web/index.html') { res.setHeader('Content-Type', 'text/html'); res.end('<html><head><script defer src="runtime.bundle.js"></script></head><body></body></html>'); return; }
    if (url.pathname === '/Users/user') { res.end(JSON.stringify({ Id: 'user', Name: 'Owner', Policy: { IsAdministrator: true }, Configuration: { EnableNextEpisodeAutoPlay: true } })); return; }
    if (url.pathname === '/Items/movie/PlaybackInfo') { res.end(JSON.stringify({ MediaSources: [{ ...item.MediaSources[0], TranscodingUrl: '/Videos/movie/master.m3u8?ApiKey=owner-secret' }], PlaySessionId: 'encoding-session' })); return; }
    if (url.pathname === '/Videos/movie/master.m3u8') { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXTINF:4,\n/Videos/movie/segment.ts?api_key=owner-secret\n'); return; }
    if (url.pathname === '/Videos/movie/segment.ts') { res.setHeader('Content-Type', 'video/mp2t'); res.end(Buffer.from([0x47, 0, 0, 0])); return; }
    if (url.pathname === '/Videos/movie/stream.mp4') { res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Content-Range', 'bytes 0-3/100'); res.writeHead(206).end(Buffer.from([1, 2, 3, 4])); return; }
    if (url.pathname === '/Videos/ActiveEncodings' || url.pathname === '/Sessions/Playing') { res.writeHead(204).end(); return; }
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const connection = { token: 'remembered-connection', base: `http://127.0.0.1:${upstream.address().port}`, apiToken: 'owner-secret', userId: 'user', userName: 'Owner', serverId: 'server', serverName: 'Cinema', deviceId: 'owner-device' };
  let loggedIn = true;
  const accounts = { request: upstreamRequest, getConnection: token => loggedIn && token === connection.token ? connection : null };
  const app = express(); app.use(express.json());
  const server = http.createServer(app), io = new Server(server);
  const integration = installJellyfin(app, io, accounts);
  io.on('connection', socket => socket.on('join-room', room => socket.join(room)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  const join = async room => { const socket = connect(base, { transports: ['websocket'] }); sockets.push(socket); await next(socket, 'connect'); socket.emit('join-room', room); await ack(socket, 'jellyfin-sync-request', room); return socket; };
  try {
    const host = await join('room'), guest = await join('room');
    assert.equal((await ack(host, 'jellyfin-open', { roomId: 'room', connectionToken: connection.token, itemId: 'movie' })).ok, true);
    const state = (await ack(guest, 'jellyfin-sync-request', 'room')).state;
    assert.equal(state.native, true); assert.equal(state.itemId, 'movie');
    assert.ok(!JSON.stringify(state).includes('owner-secret')); assert.ok(!JSON.stringify(state).includes(connection.token));
    const gateway = `${base}/api/jellyfin-native/${state.accessToken}`;
    for (const route of ['/Users', '/System/Configuration', '/Items/other', '/Videos/other/stream.mp4', '/Items?Ids=movie,other', '/Videos/movie/stream.mp4?MediaSourceId=other']) assert.equal((await fetch(gateway + route)).status, 403, route);
    for (const route of ['/Users/user/Password', '/Sessions/another/Playing', '/Items/movie/Refresh']) assert.equal((await fetch(gateway + route, { method: 'POST' })).status, 403, route);
    assert.deepEqual((await (await fetch(`${gateway}/Items?Recursive=true`)).json()).Items, []);
    let response = await fetch(`${gateway}/web/index.html?channel=test-channel&parentOrigin=https%3A%2F%2Fsamerow.test`);
    const html = await response.text(); assert.equal(response.status, 200); assert.match(html, /SameRow|SAMEROW/); assert.match(html, /data-jellyfin-src/); assert.ok(!html.includes('owner-secret'));
    const config = await (await fetch(`${gateway}/web/config.json`)).json(); assert.ok(config.plugins.includes('SameRowBridge')); assert.ok(!config.plugins.some(plugin => plugin.includes('chromecast')));
    const user = await (await fetch(`${gateway}/Users/Me`)).json(); assert.equal(user.Policy.IsAdministrator, false); assert.equal(user.Configuration.EnableNextEpisodeAutoPlay, false);
    const data = await (await fetch(`${gateway}/Items/movie`)).json(); assert.ok(!JSON.stringify(data).includes('/private/library'));
    const playback = await (await fetch(`${gateway}/Items/movie/PlaybackInfo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ UserId: 'attacker', DeviceId: 'owner-device', MediaSourceId: 'source' }) })).json();
    assert.equal(playback.MediaSources[0].TranscodingUrl, `/Videos/movie/master.m3u8?ApiKey=${state.accessToken}`);
    const manifest = await (await fetch(`${gateway}/Videos/movie/master.m3u8?ApiKey=attacker&DeviceId=owner-device`)).text();
    assert.ok(!manifest.includes('owner-secret')); assert.ok(!manifest.includes(connection.base));
    assert.match(manifest, /api\/jellyfin-native/);
    const segment = manifest.split('\n').find(line => line.startsWith('http'));
    assert.equal((await fetch(segment)).status, 200);
    response = await fetch(`${gateway}/Videos/movie/stream.mp4`, { headers: { Range: 'bytes=0-3' } }); assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 0-3/100');
    const device = requests.find(request => request.path === '/Items/movie/PlaybackInfo').query.DeviceId;
    assert.notEqual(device, connection.deviceId); assert.ok(requests.every(request => request.authorization.includes('owner-secret')));
    const before = requests.length;
    await fetch(`${gateway}/Users/user/Configuration`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"SubtitleMode":"Always"}' });
    assert.equal(requests.length, before, 'A guest preference cannot overwrite the owner account');
    assert.equal((await fetch(`${gateway}/Sessions/Playing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ItemId":"other"}' })).status, 403);
    loggedIn = false; assert.equal((await fetch(`${gateway}/Items/movie`)).status, 401); loggedIn = true;
    const ended = next(host, 'jellyfin-sync'); guest.emit('jellyfin-command', { roomId: 'room', sessionId: state.sessionId, action: 'stop' }); assert.equal(await ended, null);
    assert.equal((await fetch(`${gateway}/Items/movie`)).status, 403);
  } finally { sockets.forEach(socket => socket.disconnect()); integration.close(); await new Promise(resolve => io.close(resolve)); await new Promise(resolve => upstream.close(resolve)); }
});
