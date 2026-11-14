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
  const application = createApplication({ config: config(options.config), store: options.store || new MemoryStore(), identity: options.identity || identity, mediaService: options.mediaService });
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
  let reply = await ack(socket, 'join-room', room, 'Viewer');
  t.roomHosts ||= new Map();
  if (reply.isOwner) t.roomHosts.set(room, socket);
  if (reply.pending) {
    const record = await application.store.get(`room:${room}`);
    const request = record.admissions.find(value => value.uid === user && value.clientId === socket.id);
    assert.equal((await ack(t.roomHosts.get(room), 'room-request-answer', room, request.id, true)).ok, true);
    reply = await ack(socket, 'join-room', room, 'Viewer');
  }
  return { socket, reply };
}

test('local responses disable picture-in-picture at the document level', async t => {
  const application = await start(t);
  const response = await fetch(application.url + '/api/config');
  assert.equal(response.headers.get('permissions-policy'), 'picture-in-picture=()');
});

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

test('room chat is unavailable and existing history is retained', async t => {
  const application = await start(t), host = (await join(t, application, 'movie', 'owner')).socket;
  const history = [{ id: 'past-message', text: 'Saved history' }];
  await application.store.set('chat:movie', history);
  const expected = { error: 'Room chat is currently unavailable.' };
  assert.deepEqual(await ack(host, 'chat-history', { roomId: 'movie' }), expected);
  assert.deepEqual(await ack(host, 'chat-send', { roomId: 'movie', id: randomUUID(), text: 'New message' }), expected);
  assert.deepEqual(await application.store.get('chat:movie'), history);
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

async function startJellyfinFixture(t) {
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
    if (url.pathname === '/Videos/movie/main.m3u8') {
      if (url.searchParams.get('VideoCodec') !== 'copy' || url.searchParams.get('SegmentContainer') !== 'mp4') return res.writeHead(400).end();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nsegment.m4s\n#EXT-X-ENDLIST\n');
    }
    if (['/Videos/movie/init.mp4', '/Videos/movie/segment.m4s'].includes(url.pathname)) {
      res.setHeader('Content-Type', 'video/mp4');
      return res.end(Buffer.from(url.pathname.endsWith('.mp4') ? [1, 2] : [3, 4]));
    }
    if (url.pathname === '/Videos/movie/stream.mp4') { res.setHeader('Content-Type', 'video/mp4'); return res.end(Buffer.from([1, 2, 3, 4])); }
    if (url.pathname === '/Sessions/Logout') return res.writeHead(204).end();
    return res.writeHead(404).end('{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  return `http://127.0.0.1:${upstream.address().port}`;
}

test('Redis: Jellyfin sign-in, credentials, native gateway and revocation work across separate services', { skip: !redisUrl }, async t => {
  const upstreamUrl = await startJellyfinFixture(t);
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
  const pending = await ack(guest, 'join-room', 'movie', 'Viewer');
  assert.equal(pending.pending, true);
  const room = await first.store.get('room:movie');
  const request = room.admissions.find(value => value.uid === 'guest' && value.clientId === guest.id);
  assert.equal((await ack(host, 'room-request-answer', 'movie', request.id, true)).ok, true);
  assert.equal((await ack(guest, 'join-room', 'movie', 'Viewer')).ok, true);
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

// Exercise fault paths without waiting for real 20/60-second heartbeat windows.
test('20 viewers survive brief storage faults; prolonged faults trigger recoverable transport closure', async t => {
  class FaultStore extends MemoryStore {
    fail = false; presenceWrites = 0;
    async set(...args) { if (this.fail) throw Error('temporary storage outage'); return super.set(...args); }
    async update(key, ...args) { if (key.startsWith('presence:')) this.presenceWrites++; return super.update(key, ...args); }
  }
  const store = new FaultStore();
  const application = await start(t, { store, config: { maxRoomSize: 25 } });
  const host = await join(t, application, 'crowded', 'viewer-0');
  const viewers = [host, ...await Promise.all(Array.from({ length: 19 }, (_, i) => join(t, application, 'crowded', `viewer-${i + 1}`)))];
  assert.ok(viewers.every(viewer => viewer.reply.ok));
  store.presenceWrites = 0;
  await application.renewMemberships();
  assert.equal(store.presenceWrites, 1, 'Renew presence once per room, not once per participant');
  store.fail = true; store.ready = false;
  await application.renewMemberships();
  assert.ok(viewers.every(viewer => viewer.socket.connected), 'A short Redis outage must not drop everyone');
  store.fail = false; store.ready = true;
  await application.renewMemberships();
  assert.equal((await ack(viewers[0].socket, 'sync-request', 'crowded')).state.revision, 0);
  const client = viewers[0].socket, serverSocket = application.io.sockets.sockets.get(client.id);
  serverSocket.membershipRenewedAt = Date.now() - 61000;
  const disconnect = next(client, 'disconnect');
  store.fail = true; store.ready = false; await application.renewMemberships();
  assert.notEqual(await disconnect, 'io server disconnect', 'Transport closure allows Socket.IO automatic recovery');
  store.fail = false; store.ready = true;
});

test('session expiration warns in advance and closes a recoverable transport after expiry', async t => {
  const application = await start(t), client = (await join(t, application)).socket;
  const serverSocket = application.io.sockets.sockets.get(client.id);
  serverSocket.data.expiresAt = Date.now() + 60000;
  const warning = next(client, 'session-expiring'); await application.renewMemberships(); await warning;
  assert.equal(client.connected, true);
  serverSocket.data.expiresAt = Date.now() - 1;
  const disconnected = next(client, 'disconnect'); await application.renewMemberships();
  assert.notEqual(await disconnected, 'io server disconnect');
});

test('a reconnect reclaims its authenticated tab seat in a full room without evicting another user', async t => {
  const app = await start(t, { config: { maxRoomSize: 2 } });
  await join(t, app, 'full-room', 'guest');
  const clientId = randomUUID();
  await app.store.update('presence:full-room', current => [...current, { id: 'crashed-socket', uid: 'owner', clientId, until: Date.now() + 90000 }]);
  await app.store.set('member:full-room:crashed-socket', { uid: 'owner' }, 90);
  const connectAs = async uid => {
    const socket = connect(app.url, { transports: ['websocket'], auth: { token: `test:${uid}`, clientId }, reconnection: false });
    t.after(() => socket.disconnect()); await next(socket, 'connect'); return socket;
  };
  const impostor = await connectAs('another-user');
  assert.equal((await ack(impostor, 'join-room', 'full-room', 'Other')).pending, true, 'Client ID alone cannot reclaim another identity’s seat');
  await app.store.update('room:full-room', room => { room.admissions.push({ id: randomUUID(), uid: 'owner', clientId, status: 'approved' }); return room; });
  const owner = await connectAs('owner');
  assert.equal((await ack(owner, 'join-room', 'full-room', 'Owner')).ok, true);
  assert.equal(await app.store.get('member:full-room:crashed-socket'), null);
  const presence = await app.store.get('presence:full-room');
  assert.equal(presence.length, 2); assert.ok(presence.some(member => member.uid === 'guest'));
});

test('all rooms require host acceptance for codes and invite links', async t => {
  const application = await start(t);
  const makeSocket = async user => {
    const socket = connect(application.url, { transports: ['websocket'], auth: { token: `test:${user}`, clientId: randomUUID() } });
    t.after(() => socket.disconnect()); await next(socket, 'connect'); return socket;
  };
  const [host, guest, outsider] = await Promise.all(['host', 'guest', 'outsider'].map(makeSocket));
  const room = await ack(host, 'generate-room', false);
  const other = await ack(host, 'generate-room', true);
  assert.match(room.invite, /^[a-f0-9]{48}$/);
  assert.notEqual(room.code, other.code);
  assert.equal((await ack(host, 'join-room', room.code, 'Host')).isOwner, true);
  assert.equal((await ack(guest, 'join-room', room.code, 'Guest', room.invite)).pending, true);
  assert.equal(await application.store.get(`member:${room.code}:${guest.id}`), null);
  let leakedToken = false;
  guest.emit('media-token', room.code, () => { leakedToken = true; });
  await ack(guest, 'join-room', room.code, 'Guest');
  assert.equal(leakedToken, false);
  const { requests } = await ack(host, 'room-requests', room.code);
  assert.equal(requests.length, 1); assert.equal(requests[0].name, 'Guest');
  assert.equal((await ack(outsider, 'room-requests', room.code)).status, 403);
  assert.equal((await ack(outsider, 'room-request-answer', room.code, requests[0].id, true)).status, 403);
  assert.equal((await ack(guest, 'join-room', room.code, 'Guest')).pending, true);
  assert.equal((await ack(host, 'room-requests', room.code)).requests.length, 1);
  assert.equal((await ack(host, 'room-request-answer', room.code, requests[0].id, true)).ok, true);
  assert.equal((await ack(guest, 'join-room', room.code, 'Guest')).ok, true);
  await ack(guest, 'leave-room', room.code);
  assert.equal((await ack(guest, 'join-room', room.code, 'Guest')).pending, true, 'Explicitly leaving requires fresh approval');
  await ack(guest, 'leave-room', room.code);
  assert.equal((await ack(outsider, 'join-room', room.code, 'Outsider')).pending, true);
  const pending = (await ack(host, 'room-requests', room.code)).requests[0];
  await ack(host, 'room-request-answer', room.code, pending.id, false);
  assert.equal((await ack(outsider, 'join-room', room.code, 'Outsider')).status, 403);
  await ack(outsider, 'leave-room', room.code);
  assert.equal((await ack(outsider, 'join-room', room.code, 'Outsider')).pending, true);
  await ack(outsider, 'leave-room', room.code);
  assert.equal((await ack(host, 'room-requests', room.code)).requests.length, 0, 'Canceled requests disappear');
  assert.equal((await ack(host, 'room-request-answer', room.code, pending.id, true)).status, 410);
});

test('the Jellyfin pilot admits only four participants across control replicas', {
  skip: !process.env.TEST_REDIS_URL,
}, async t => {
  const settings = configuration({
    JELLYFIN_RELAY_ENABLED: 'true',
    MAX_ROOM_SIZE: '25',
    MEDIA_PUBLIC_URL: 'https://media.example',
    REDIS_URL: process.env.TEST_REDIS_URL,
    DATA_ENCRYPTION_KEY: 'c'.repeat(64),
    REDIS_PREFIX: `samerow-pilot-test:${randomUUID()}`,
  });
  assert.equal(settings.maxRoomSize, 4);
  const first = await start(t, { store: await createStore(settings), config: settings });
  const second = await start(t, { store: await createStore(settings), config: settings });
  const room = 'pilot';
  const host = await join(t, first, room, 'pilot-host');
  const guest = await join(t, second, room, 'pilot-guest');
  const third = await join(t, first, room, 'pilot-third');
  assert.ok([host, guest, third].every(member => member.reply.ok));
  assert.equal(host.reply.maxRoomSize, 4);
  const contenders = await Promise.all([
    join(t, first, room, 'pilot-fourth'),
    join(t, second, room, 'pilot-fifth'),
  ]);
  assert.equal(contenders.filter(member => member.reply.ok).length, 1);
  const denied = contenders.find(member => !member.reply.ok);
  assert.equal(denied.reply.status, 409);
  assert.match(denied.reply.error, /room is full \(4 people\)/i);
  await ack(guest.socket, 'leave-room', room);
  assert.equal((await ack(denied.socket, 'join-room', room, 'Viewer')).ok, true);
});

test('production control acknowledges a generated room join and the media service advertises the same deployment', {
  skip: !process.env.TEST_REDIS_URL,
}, async t => {
  const settings = configuration({
    NODE_ENV: 'production',
    SERVICE_ROLE: 'control',
    CLIENT_ORIGINS: 'https://samerow.example',
    REDIS_URL: process.env.TEST_REDIS_URL,
    REDIS_PREFIX: `samerow-deploy-test:${randomUUID()}`,
    DATA_ENCRYPTION_KEY: 'd'.repeat(64),
    FIREBASE_PROJECT_ID: 'project',
    FIREBASE_SERVICE_ACCOUNT_JSON: '{}',
    LIVEKIT_URL: 'wss://livekit.example',
    LIVEKIT_API_KEY: 'example-key',
    LIVEKIT_API_SECRET: 'example-secret',
    MEDIA_PUBLIC_URL: 'https://media.example',
    JELLYFIN_RELAY_ENABLED: 'true',
  });
  const createdRooms = [];
  const mediaService = { createRoom: async options => { createdRooms.push(options); } };
  const control = await start(t, { config: settings, store: await createStore(settings), mediaService });
  const media = await start(t, {
    config: { ...settings, serviceRole: 'media' }, store: await createStore(settings), mediaService,
  });
  const origin = settings.origins[0];
  for (const [service, role] of [[control, 'control'], [media, 'media']]) {
    const headers = { Origin: origin };
    const ready = await fetch(service.url + '/health/ready', { headers });
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get('Access-Control-Allow-Origin'), origin);
    const response = await fetch(service.url + '/api/config', { headers });
    const result = await response.json();
    assert.equal(result.role, role);
    assert.equal(result.roomProtocol, 1);
    assert.equal(result.firebaseProjectId, 'project');
    assert.equal(result.mediaOrigin, settings.mediaOrigin);
    assert.equal(result.maxRoomSize, 4);
  }
  const socket = connect(control.url, {
    transports: ['websocket'], auth: { token: 'test:host' }, extraHeaders: { Origin: origin }, reconnection: false,
  });
  t.after(() => socket.disconnect());
  await next(socket, 'connect');
  const { code } = await ack(socket, 'generate-room', false);
  assert.match(code, /^[A-Z]{4}$/);
  const joined = await ack(socket, 'join-room', code, 'Host');
  assert.equal(joined.ok, true);
  assert.equal(joined.mediaBase, settings.mediaOrigin);
  const token = await ack(socket, 'media-token', code);
  assert.equal(token.mode, 'livekit');
  assert.match(token.token, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(createdRooms[0].maxParticipants, 4);
});

test('pairing claims are single-use under concurrency, expire, and tokens rotate with retry recovery', async t => {
  const { createHash } = require('node:crypto');
  const store = new MemoryStore();
  const app = await start(t, { store, config: { jellyfinRelay: true, mediaOrigin: 'https://media.example', encryptionKey: 'a'.repeat(64) } });
  const root = app.url + '/api/jellyfin-relay';
  const post = (path, body, headers = {}) => fetch(root + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const secret = 'b'.repeat(64);
  const { id } = await (await post('/approval/start', { claim: createHash('sha256').update(secret).digest('hex') })).json();
  assert.equal((await post('/approval/claim', { id, secret })).status, 202);
  assert.equal((await post('/approval/approve', { id }, { 'X-SameRow-Token': 'test:owner' })).status, 204);
  const claims = await Promise.all([post('/approval/claim', { id, secret }), post('/approval/claim', { id, secret })]);
  assert.deepEqual(claims.map(reply => reply.status).sort(), [200, 410]);
  const { token } = await claims.find(reply => reply.status === 200).json();
  assert.equal(store.read('connector:' + id).expires, 0, 'Claimed ownership must not expire with inactivity');
  assert.equal(store.read('user-connectors:owner').expires, 0);
  assert.equal((await post('/approval/approve', { id }, { 'X-SameRow-Token': 'test:owner' })).status, 410);
  const next = id + '.' + 'c'.repeat(64);
  const rotate = () => post('/rotate', { token: next }, { Authorization: 'Bearer ' + token });
  assert.equal((await rotate()).status, 204);
  assert.equal((await rotate()).status, 204);
  assert.equal((await fetch(root + '/account-binding', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
  assert.equal((await fetch(root + '/account-binding', { headers: { Authorization: 'Bearer ' + next } })).status, 200);
  assert.equal((await post('/rotate', { token: id + '.' + 'd'.repeat(64) }, { Authorization: 'Bearer ' + token })).status, 401);
  const expiring = await (await post('/approval/start', { claim: createHash('sha256').update(secret).digest('hex') })).json();
  await store.update('connector:' + expiring.id, current => ({ ...current, until: Date.now() - 1 }));
  assert.equal((await post('/approval/claim', { id: expiring.id, secret })).status, 410);
});


test('anonymous identities cannot connect, refresh sessions, or access account APIs', async t => {
  const application = await start(t, { identity: { verify: async token => {
    const user = await identity.verify(token);
    return { ...user, firebase: { sign_in_provider: token === 'test:anonymous' ? 'anonymous' : 'google.com' } };
  } } });
  const anonymous = connect(application.url, { transports: ['websocket'], auth: { token: 'test:anonymous' }, reconnection: false });
  t.after(() => anonymous.disconnect());
  assert.equal((await next(anonymous, 'connect_error')).data.code, 'UNAUTHENTICATED');
  assert.equal((await fetch(`${application.url}/api/jellyfin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SameRow-Token': 'test:anonymous' }, body: '{}' })).status, 401);
  const { socket } = await join(t, application, 'account-only', 'member');
  assert.equal((await ack(socket, 'auth-refresh', 'test:anonymous')).status, 401);
});


test('every member needs host approval, including invite holders and members returning after leaving', async t => {
  const application = await start(t);
  const { socket: host } = await join(t, application, 'approval', 'host');
  const { invite } = await application.store.get('room:approval');
  const member = connect(application.url, { transports: ['websocket'], auth: { token: 'test:member', clientId: randomUUID() }, reconnection: false });
  t.after(() => member.disconnect());
  await next(member, 'connect');
  assert.equal((await ack(member, 'join-room', 'approval', 'Member', invite)).pending, true);
  assert.equal(await application.store.get(`member:approval:${member.id}`), null);
  let leakedToken = false;
  member.emit('media-token', 'approval', () => { leakedToken = true; });
  await ack(member, 'join-room', 'approval', 'Member');
  assert.equal(leakedToken, false);
  let requests = (await ack(host, 'room-requests', 'approval')).requests;
  assert.equal(requests.length, 1);
  assert.equal((await ack(member, 'room-request-answer', 'approval', requests[0].id, true)).status, 403);
  assert.equal((await ack(member, 'room-requests', 'approval')).status, 403);
  await ack(host, 'room-request-answer', 'approval', requests[0].id, true);
  assert.equal((await ack(member, 'join-room', 'approval', 'Member', invite)).ok, true);
  assert.equal((await ack(member, 'join-room', 'approval', 'Member')).ok, true);
  await ack(member, 'leave-room', 'approval');
  assert.equal((await ack(member, 'join-room', 'approval', 'Member')).pending, true);
  requests = (await ack(host, 'room-requests', 'approval')).requests;
  await ack(host, 'room-request-answer', 'approval', requests[0].id, false);
  assert.equal((await ack(member, 'join-room', 'approval', 'Member')).status, 403);
  await ack(member, 'leave-room', 'approval');
  assert.equal((await ack(host, 'room-requests', 'approval')).requests.length, 0);
});

test('development authentication requires an explicit identity token', async () => {
  const { createIdentity } = require('../auth');
  const development = createIdentity({ authMode: 'development' });
  for (const token of [undefined, '', ' ', 'dev:']) await assert.rejects(development.verify(token));
  assert.equal((await development.verify('dev:member')).uid, 'member');
});
