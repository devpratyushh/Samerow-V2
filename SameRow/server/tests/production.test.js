const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { io: connect } = require('socket.io-client');
const { createApplication } = require('../application');
const { configuration } = require('../config');
const { MemoryStore, createStore } = require('../store');
const { validateServerUrl, upstreamRequest } = require('../jellyfinAccounts');

const config = overrides => ({ ...configuration({}), ...overrides });
const identity = { verify: async token => {
  if (!/^test:[A-Za-z0-9_-]+$/.test(token || '')) throw Error('invalid token');
  return { uid: token.slice(5), exp: Math.floor(Date.now() / 1000) + 3600 };
} };
const ack = (socket, event, ...args) => new Promise((resolve, reject) => socket.timeout(4000).emit(event, ...args, (error, reply) => error ? reject(error) : resolve(reply)));
const next = (socket, event) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { socket.off(event, receive); reject(Error(`Timed out: ${event}`)); }, 4000);
  const receive = value => { clearTimeout(timeout); resolve(value); };
  socket.once(event, receive);
});
async function start(t, options = {}) {
  const application = createApplication({ config: config(options.config), store: options.store || new MemoryStore(), identity });
  await application.ready;
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  application.url = `http://127.0.0.1:${application.server.address().port}`;
  t.after(() => application.close());
  return application;
}
async function join(t, application, room = 'movie', user = randomUUID()) {
  const socket = connect(application.url, { transports: ['websocket'], auth: { token: `test:${user}` }, reconnection: false });
  t.after(() => socket.disconnect());
  await next(socket, 'connect');
  const reply = await ack(socket, 'join-room', room, 'Viewer');
  return { socket, reply };
}

test('production fails closed on missing services, development auth, unsafe origins and emulator configuration', () => {
  assert.throws(() => configuration({ NODE_ENV: 'production' }), /Production requires/);
  const env = { NODE_ENV: 'production', REDIS_URL: 'redis://localhost', DATA_ENCRYPTION_KEY: 'a'.repeat(64), CLIENT_ORIGINS: 'https://samerow.example', FIREBASE_PROJECT_ID: 'project', FIREBASE_SERVICE_ACCOUNT_JSON: '{}', LIVEKIT_URL: 'wss://sfu.example', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secret' };
  assert.equal(configuration(env).mediaMode, 'livekit');
  assert.throws(() => configuration({ ...env, AUTH_MODE: 'development' }));
  assert.throws(() => configuration({ ...env, CLIENT_ORIGINS: '*' }));
  assert.throws(() => configuration({ ...env, FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' }));
  assert.throws(() => configuration({ ...env, JELLYFIN_ALLOW_PRIVATE: 'true' }));
  assert.throws(() => configuration({ ...env, MEDIA_MODE: 'mesh' }));
  assert.throws(() => configuration({ ...env, SERVICE_ROLE: 'control' }), /MEDIA_PUBLIC_URL/);
});

test('private and metadata upstreams are rejected before credentials are sent', async () => {
  for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '[::1]', '[::ffff:7f00:1]', '169.254.169.254']) {
    assert.throws(() => validateServerUrl(`https://${host}`, { production: true }));
  }
  assert.throws(() => validateServerUrl('https://unapproved.example', { production: true, origins: ['https://approved.example'] }));
  await assert.rejects(upstreamRequest({ base: 'https://127.0.0.1', apiToken: 'secret' }, '/Users/Me', { networkPolicy: { production: true } }));
  // Even explicitly allowed private libraries cannot reach cloud metadata.
  assert.throws(() => validateServerUrl('http://169.254.169.254', { production: true, allowPrivate: true }));
});

test('authentication, origin restrictions, membership checks and room capacity are enforced', async t => {
  const application = await start(t, { config: { origins: ['https://samerow.example'], maxRoomSize: 2 } });
  const invalid = connect(application.url, { transports: ['websocket'], auth: { token: 'forged' }, reconnection: false });
  t.after(() => invalid.disconnect());
  assert.match((await next(invalid, 'connect_error')).message, /Sign in/);
  assert.equal((await fetch(`${application.url}/api/status`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${application.url}/api/config`, { headers: { Origin: 'null' } })).status, 403);
  const preflight = await fetch(`${application.url}/api/jellyfin-native/bridge.js`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'cache-control,x-emby-authorization' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
  assert.match(preflight.headers.get('access-control-allow-headers'), /cache-control/);
  assert.equal((await fetch(`${application.url}/api/jellyfin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const host = await join(t, application), guest = await join(t, application), full = await join(t, application);
  assert.equal(host.reply.ok, true); assert.equal(guest.reply.ok, true); assert.match(full.reply.error, /full/);
  assert.match((await ack(host.socket, 'join-room', 'other', 'Viewer')).error, /Leave/);
  assert.match((await ack(full.socket, 'join-room', null, null)).error, /valid room/);
  const outsider = await join(t, application, 'other');
  let leaked = false; outsider.socket.on('signal', () => { leaked = true; });
  host.socket.emit('signal', { to: outsider.socket.id, signal: { type: 'offer', sdp: 'invalid' } });
  await ack(host.socket, 'sync-request', 'movie');
  assert.equal(leaked, false);
  let updates = 0; guest.socket.on('user-state-updated', () => updates++);
  outsider.socket.emit('update-user-state', { roomId: 'movie', type: 'video', enabled: true });
  await ack(outsider.socket, 'sync-request', 'other');
  assert.equal(updates, 0);
  await ack(guest.socket, 'leave-room', 'movie');
  const joined = await ack(full.socket, 'join-room', 'movie', 'Viewer'); assert.equal(joined.ok, true);
});

test('host policy rejects guest playback commands, preserves state over reconnect, and isolates disconnect events', async t => {
  const application = await start(t, { config: { controlPolicy: 'host' } });
  const host = (await join(t, application, 'movie', 'owner')).socket;
  const guest = (await join(t, application, 'movie', 'guest')).socket;
  const outsider = (await join(t, application, 'other', 'other')).socket;
  const pushed = next(guest, 'youtube-sync');
  host.emit('youtube-change', { roomId: 'movie', url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE', timestamp: 30 });
  const state = await pushed;
  guest.emit('youtube-change', { roomId: 'movie', url: null });
  assert.equal((await ack(guest, 'sync-request', 'movie')).state.sessionId, state.sessionId);
  let leaked = false; outsider.on('user-disconnected', () => { leaked = true; });
  host.disconnect();
  const reconnected = (await join(t, application, 'movie', 'owner')).socket;
  const snapshot = (await ack(reconnected, 'sync-request', 'movie')).state;
  assert.equal(snapshot.sessionId, state.sessionId); assert.ok(snapshot.timestamp >= 30); assert.equal(leaked, false);
});

test('chat checks membership, limits history, paginates, authenticates senders and deduplicates retries', async t => {
  const application = await start(t), host = (await join(t, application, 'movie', 'owner')).socket;
  const guest = (await join(t, application, 'movie', 'guest')).socket;
  const id = randomUUID(), messageEvent = next(guest, 'chat-message');
  const sent = await ack(host, 'chat-send', { roomId: 'movie', id, text: 'Hello', sender: 'Forged' });
  const message = await messageEvent;
  assert.equal(message.senderId, 'owner'); assert.equal(message.sender, 'Viewer');
  assert.equal((await ack(host, 'chat-send', { roomId: 'movie', id, text: 'Changed retry' })).message.text, 'Hello');
  assert.equal((await ack(guest, 'chat-history', { roomId: 'movie' })).messages.length, 1);
  assert.match((await ack(host, 'chat-send', { roomId: 'movie', id: randomUUID(), text: 'a'.repeat(4001) })).error, /4,000/);
  const history = Array.from({ length: 80 }, (_, index) => ({ id: `message-${index}`, createdAt: index, text: 'Message' }));
  await application.store.set('chat:movie', history);
  const page = await ack(host, 'chat-history', { roomId: 'movie' });
  assert.equal(page.messages.length, 50); assert.equal(page.hasMore, true);
  assert.equal((await ack(host, 'chat-history', { roomId: 'movie', before: page.messages[0].id })).messages.length, 30);
  assert.equal(sent.message.id, message.id);
});

const redisUrl = process.env.TEST_REDIS_URL;
test('Redis: two instances share atomic playback, rate limits, encrypted credentials and restart recovery', { skip: !redisUrl }, async t => {
  const settings = config({ redisUrl, encryptionKey: 'a'.repeat(64), prefix: `samerow-test:${randomUUID()}`, maxRoomSize: 25 });
  const firstStore = await createStore(settings), secondStore = await createStore(settings);
  const first = await start(t, { store: firstStore, config: settings }), second = await start(t, { store: secondStore, config: settings });
  const host = (await join(t, first, 'movie', 'owner')).socket, guest = (await join(t, second, 'movie', 'guest')).socket;
  const update = next(guest, 'youtube-sync');
  host.emit('youtube-change', { roomId: 'movie', url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE', timestamp: 60 });
  const state = await update;
  await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? firstStore : secondStore).update('counter', current => (current || 0) + 1)));
  assert.equal(await firstStore.get('counter'), 40);
  assert.equal(await firstStore.limit('shared-limit', 1, 60), true); assert.equal(await secondStore.limit('shared-limit', 1, 60), false);
  await firstStore.set('credential', { apiToken: 'sensitive-owner-token' });
  const raw = await firstStore.client.get(firstStore.key('credential'));
  assert.ok(!raw.includes('sensitive-owner-token'));
  assert.equal((await secondStore.get('credential')).apiToken, 'sensitive-owner-token');
  await firstStore.client.set(firstStore.key('tampered'), raw);
  await assert.rejects(firstStore.get('tampered'));
  guest.emit('youtube-state-change', { roomId: 'movie', sessionId: state.sessionId, isPlaying: false, timestamp: 90, commandId: 'pause' });
  assert.equal((await ack(guest, 'sync-request', 'movie')).state.timestamp, 90);
  await first.close();
  const thirdStore = await createStore(settings), third = await start(t, { store: thirdStore, config: settings });
  const reconnected = (await join(t, third, 'movie', 'owner')).socket;
  const restored = (await ack(reconnected, 'sync-request', 'movie')).state;
  assert.equal(restored.sessionId, state.sessionId); assert.equal(restored.timestamp, 90); assert.equal(restored.isPlaying, false);
  assert.equal((await secondStore.get('credential')).apiToken, 'sensitive-owner-token');
});

test('readiness reports storage failure and graceful drain rejects new work', async t => {
  const application = await start(t);
  assert.equal((await fetch(`${application.url}/health/ready`)).status, 200);
  application.drain();
  assert.equal((await fetch(`${application.url}/health/ready`)).status, 503);
  assert.equal((await fetch(`${application.url}/health/live`)).status, 200);
});

test('Redis: Jellyfin sign-in, credentials, native gateway and revocation work across separate services', { skip: !redisUrl }, async t => {
  const http = require('node:http');
  const item = { Id: 'movie', Name: 'Room movie', Type: 'Movie', RunTimeTicks: 600000000, MediaSources: [{ Id: 'source', Container: 'mp4', RunTimeTicks: 600000000, MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264' }, { Index: 1, Type: 'Audio', Codec: 'aac' }] }] };
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/Users/AuthenticateByName') return res.end(JSON.stringify({ AccessToken: 'owner-secret', User: { Id: 'user', Name: 'Owner' }, ServerId: 'server' }));
    if (url.pathname === '/System/Info/Public') return res.end(JSON.stringify({ ServerName: 'Cinema', Id: 'server' }));
    if (!req.headers.authorization?.includes('Token="owner-secret"')) return res.writeHead(401).end('{}');
    if (url.pathname === '/Users/user/Items/movie') return res.end(JSON.stringify(item));
    if (url.pathname === '/web/config.json') return res.end('{"plugins":[]}');
    if (url.pathname === '/Users/Me') return res.end('{"Id":"user","Name":"Owner"}');
    if (url.pathname === '/Videos/movie/stream.mp4') { res.setHeader('Content-Type', 'video/mp4'); return res.end(Buffer.from([1, 2, 3, 4])); }
    if (url.pathname === '/Sessions/Logout') return res.writeHead(204).end();
    return res.writeHead(404).end('{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const settings = config({ redisUrl, encryptionKey: 'b'.repeat(64), prefix: `samerow-test:${randomUUID()}` });
  const first = await start(t, { store: await createStore(settings), config: settings });
  const second = await start(t, { store: await createStore(settings), config: settings });
  const media = await start(t, { store: await createStore(settings), config: { ...settings, serviceRole: 'media' } });
  const host = (await join(t, first, 'movie', 'owner')).socket, guest = (await join(t, second, 'movie', 'guest')).socket;
  const response = await fetch(`${media.url}/api/jellyfin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SameRow-Token': 'test:owner' }, body: JSON.stringify({ serverUrl: upstreamUrl, username: 'Owner', password: 'password', remember: true }) });
  assert.equal(response.status, 200); const login = await response.json();
  const check = user => fetch(`${first.url}/api/jellyfin/account`, { headers: { Authorization: `Bearer ${login.token}`, 'X-SameRow-Token': `test:${user}` } });
  assert.equal((await check('owner')).status, 200); assert.equal((await check('guest')).status, 401);
  const opened = await ack(host, 'jellyfin-open', { roomId: 'movie', connectionToken: login.token, itemId: 'movie' });
  assert.equal(opened.ok, true);
  const state = (await ack(guest, 'jellyfin-sync-request', 'movie')).state;
  assert.ok(!JSON.stringify(state).includes('owner-secret'));
  const gateway = `${media.url}/api/jellyfin-native/${state.accessToken}`;
  assert.equal((await fetch(`${gateway}/Items/movie`)).status, 200);
  assert.equal((await fetch(`${gateway}/Items/other`)).status, 403);
  assert.equal((await fetch(`${gateway}/Videos/movie/stream.mp4`)).status, 200);
  await ack(guest, 'leave-room', 'movie');
  assert.equal((await fetch(`${gateway}/Items/movie`)).status, 403);
  const rejoined = await ack(guest, 'join-room', 'movie', 'Viewer'); assert.equal(rejoined.ok, true);
  const nextState = (await ack(guest, 'jellyfin-sync-request', 'movie')).state;
  const nextGateway = `${media.url}/api/jellyfin-native/${nextState.accessToken}`;
  await fetch(`${second.url}/api/jellyfin/logout`, { method: 'POST', headers: { Authorization: `Bearer ${login.token}`, 'X-SameRow-Token': 'test:owner' } });
  assert.equal((await fetch(`${nextGateway}/Items/movie`)).status, 401);
  assert.equal((await ack(host, 'jellyfin-sync-request', 'movie')).state, null);
});

test('metadata reads are bounded even when the upstream omits Content-Length', async () => {
  const { readText, readJson } = require('../upstreamBody');
  await assert.rejects(readText(new Response('a'.repeat(100)), 20), { status: 502 });
  await assert.rejects(readJson(new Response('not-json')), { status: 502 });
  assert.deepEqual(await readJson(new Response('{"ok":true}')), { ok: true });
});
