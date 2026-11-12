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
  const application = createApplication({ config: config(options.config), store: options.store || new MemoryStore(), identity, mediaService: options.mediaService });
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

// Exercise fault paths without waiting for real 20/60-second heartbeat windows.
test('20 viewers survive brief storage faults; prolonged faults trigger recoverable transport closure', async t => {
  class FaultStore extends MemoryStore {
    fail = false; presenceWrites = 0;
    async set(...args) { if (this.fail) throw Error('temporary storage outage'); return super.set(...args); }
    async update(key, ...args) { if (key.startsWith('presence:')) this.presenceWrites++; return super.update(key, ...args); }
  }
  const store = new FaultStore();
  const application = await start(t, { store, config: { maxRoomSize: 25 } });
  const viewers = await Promise.all(Array.from({ length: 20 }, (_, i) => join(t, application, 'crowded', `viewer-${i}`)));
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
  assert.equal((await ack(impostor, 'join-room', 'full-room', 'Other')).status, 409, 'Client ID alone cannot reclaim another identity’s seat');
  const owner = await connectAs('owner');
  assert.equal((await ack(owner, 'join-room', 'full-room', 'Owner')).ok, true);
  assert.equal(await app.store.get('member:full-room:crashed-socket'), null);
  const presence = await app.store.get('presence:full-room');
  assert.equal(presence.length, 2); assert.ok(presence.some(member => member.uid === 'guest'));
});

test('a paired Docker host can open a private web room and relay Jellyfin to a guest', async t => {
  const origin = 'http://localhost:8080';
  const web = 'https://samerow.example';
  const store = new MemoryStore();
  const shared = { jellyfinRelay: true, mediaOrigin: 'https://media.example', encryptionKey: 'a'.repeat(64), origins: [web] };
  const media = await start(t, { config: { ...shared, serviceRole: 'media' }, store });
  const application = await start(t, { config: { ...shared, mediaOrigin: media.url, serviceRole: 'control' }, store });
  const pairUrl = `${application.url}/api/jellyfin-relay/pair`;
  const pair = async () => {
    const response = await fetch(pairUrl, { method: 'POST', headers: { 'X-SameRow-Token': 'test:owner' } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const pairing = await pair();
  const otherPairing = await pair();
  const sessionUrl = `${media.url}/api/jellyfin-relay/host-session`;
  assert.equal((await fetch(sessionUrl, { method: 'POST' })).status, 401);
  const sessionResponse = await fetch(sessionUrl, { method: 'POST', headers: { Authorization: `Bearer ${pairing.token}` } });
  assert.equal(sessionResponse.status, 200);
  const { token } = await sessionResponse.json();
  const makeSocket = (token, origin) => {
    const socket = connect(application.url, { transports: ['websocket'], extraHeaders: { Origin: origin }, auth: { token }, reconnection: false });
    t.after(() => socket.disconnect());
    return socket;
  };
  const ordinaryLocal = makeSocket('test:owner', origin);
  assert.match((await next(ordinaryLocal, 'connect_error')).message, /Sign in/);
  const host = makeSocket(token, origin);
  await next(host, 'connect');
  assert.equal((await ack(host, 'generate-room', false)).status, 403);
  assert.equal((await ack(host, 'join-room', 'public-room', 'Host')).status, 403);
  const { code, invite } = await ack(host, 'generate-room', true);
  assert.match(code, /^[A-Z]{4}$/);
  assert.ok(invite);
  assert.equal((await ack(host, 'join-room', code, 'Host', invite)).ok, true);
  const guest = makeSocket('test:guest', web);
  await next(guest, 'connect');
  assert.equal((await ack(guest, 'join-room', code, 'Guest')).status, 403);
  assert.equal((await ack(guest, 'join-room', code, 'Guest', invite)).ok, true);
  const wrongLibrary = await fetch(`${media.url}/api/jellyfin/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-SameRow-Token': token },
    body: JSON.stringify({ serverUrl: otherPairing.address, username: 'host', password: 'test' }),
  });
  assert.equal(wrongLibrary.status, 403);

  const upstreamUrl = await startJellyfinFixture(t);
  const relay = `${media.url}/api/jellyfin-relay`;
  const signal = AbortSignal.timeout(4000);
  // Use the connector's actual relay endpoints to deliver the fixture responses.
  const connector = async () => {
    for (let index = 0; index < 5; index++) {
      const headers = { Authorization: `Bearer ${pairing.token}` };
      const request = await fetch(`${relay}/poll`, { headers, signal });
      assert.equal(request.status, 200);
      const job = await request.json();
      const response = await upstreamRequest(
        { base: upstreamUrl, apiToken: job.apiToken, deviceId: job.deviceId }, job.resource,
        { method: job.method, headers: job.headers, body: job.body, signal },
      );
      const uploaded = await fetch(`${relay}/response/${job.job}`, {
        method: 'POST', body: await response.arrayBuffer(), signal,
        headers: { ...headers, 'X-Relay-Status': response.status, 'X-Relay-Headers': JSON.stringify(Object.fromEntries(response.headers)) },
      });
      assert.equal(uploaded.status, 204);
    }
  };
  await Promise.all([connector(), (async () => {
    const response = await fetch(`${media.url}/api/jellyfin/login`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-SameRow-Token': token }, signal,
      body: JSON.stringify({ serverUrl: pairing.address, username: 'host', password: 'test' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    const login = await response.json();
    assert.equal((await ack(host, 'jellyfin-open', { roomId: code, connectionToken: login.token, itemId: 'movie' })).ok, true);
    const hostState = (await ack(host, 'jellyfin-sync-request', code)).state;
    const guestState = (await ack(guest, 'jellyfin-sync-request', code)).state;
    assert.notEqual(hostState.accessToken, guestState.accessToken);
    assert.ok(!JSON.stringify(guestState).includes('owner-secret'));
    const stream = await fetch(`${media.url}/api/jellyfin-native/${guestState.accessToken}/Videos/movie/stream.mp4`, { signal });
    assert.equal(stream.status, 200);
    assert.deepEqual(new Uint8Array(await stream.arrayBuffer()), Uint8Array.of(1, 2, 3, 4));
  })()]);
  assert.equal((await fetch(pairUrl, { method: 'POST', headers: { 'X-SameRow-Token': token } })).status, 403);
  assert.equal((await fetch(`${pairUrl}/${pairing.token.split('.')[0]}`, { method: 'DELETE', headers: { 'X-SameRow-Token': 'test:owner' } })).status, 204);
  await assert.rejects(application.identity.verify(token), /revoked/);
});

test('the Docker session endpoint only forwards requests from the local app', async t => {
  const express = require('express');
  const { installLocalHostSession } = require('../connectorHost');
  const app = express();
  const connectorToken = `${'a'.repeat(32)}.${'b'.repeat(64)}`;
  const shortToken = `srhost.${'c'.repeat(64)}`;
  let calls = 0;
  installLocalHostSession(app, { token: connectorToken, gateway: 'https://media.example', controlOrigin: 'https://control.example', webOrigin: 'https://web.example' }, async (url, options) => {
    calls++;
    assert.equal(url, 'https://media.example/api/jellyfin-relay/host-session');
    assert.equal(options.headers.Authorization, `Bearer ${connectorToken}`);
    return Response.json({ token: shortToken });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/connector-host/session`;
  const request = headers => new Promise((resolve, reject) => {
    const outgoing = require('node:http').request(url, { method: 'POST', headers: { Host: 'localhost:8080', ...headers } }, incoming => {
      let body = '';
      incoming.setEncoding('utf8').on('data', chunk => { body += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
  assert.equal((await request({ Origin: 'https://evil.example', 'X-SameRow-Local-Host': '1' })).status, 403);
  assert.equal((await request({ Origin: 'http://localhost:8080' })).status, 403);
  assert.equal(calls, 0);
  const response = await request({ Origin: 'http://localhost:8080', 'X-SameRow-Local-Host': '1' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = JSON.parse(response.body);
  assert.equal(body.token, shortToken);
  assert.equal(body.jellyfinAddress, `https://${'a'.repeat(32)}.samerow-connector.invalid`);
  assert.ok(!JSON.stringify(body).includes(connectorToken));
});

test('browser approval connects only the requesting Docker instance and survives restart', async t => {
  const { mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { installConnectorSetup } = require('../connectorSetup');
  const express = require('express');
  const dataDir = mkdtempSync(join(tmpdir(), 'samerow-pairing-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const settings = { controlOrigin: 'https://control.example', webOrigin: 'https://web.example', jellyfinUrl: 'http://jellyfin:8096', upstreamOrigins: ['http://jellyfin:8096'] };
  const control = await start(t, { config: { jellyfinRelay: true, mediaOrigin: 'https://media.example', encryptionKey: 'a'.repeat(64), serviceRole: 'control', origins: [settings.webOrigin] } });
  const relay = `${control.url}/api/jellyfin-relay/approval`;
  const post = (url, body, headers) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  let worker;
  const app = express();
  app.use(express.json());
  const dependencies = {
    request: (url, options) => fetch(url.replace(settings.controlOrigin, control.url), options),
    startWorker: env => { worker = env; return () => {}; },
  };
  const local = app.listen(0, '127.0.0.1');
  await new Promise(resolve => local.once('listening', resolve));
  t.after(() => new Promise(resolve => local.close(resolve)));
  const localOrigin = `http://127.0.0.1:${local.address().port}`;
  const request = (action, body) => new Promise((resolve, reject) => {
    const outgoing = require('node:http').request(`${localOrigin}/api/connector-host/${action}`, {
      method: 'POST', headers: { Host: 'localhost:8080', Origin: 'http://localhost:8080', 'X-SameRow-Local-Host': '1', 'Content-Type': 'application/json' },
    }, incoming => {
      let data = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { data += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, data }));
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify(body));
  });
  const stop = installConnectorSetup(app, settings, { SAMEROW_DATA_DIR: dataDir }, dependencies);
  t.after(stop);
  assert.equal((await request('session', {})).status, 428);
  assert.deepEqual(JSON.parse((await request('settings', {})).data), { paired: false, jellyfinUrl: settings.jellyfinUrl });
  assert.equal((await request('start', { jellyfinUrl: 'http://user:password@other:8096' })).status, 400);
  const started = await request('start', { jellyfinUrl: 'http://other:8096/jellyfin/web/index.html' });
  assert.equal(started.status, 200);
  const approval = new URL(JSON.parse(started.data).approvalUrl);
  assert.equal(approval.origin, settings.webOrigin);
  const params = new URLSearchParams(approval.hash.slice(1)), id = params.get('connector');
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.deepEqual([...params.keys()], ['connector', 'return']);
  assert.equal((await request('complete', { id })).status, 410);
  assert.equal((await post(`${relay}/approve`, { id })).status, 401);
  assert.equal((await post(`${relay}/approve`, { id }, { Origin: settings.webOrigin, 'X-SameRow-Token': 'test:owner' })).status, 204);
  assert.equal((await post(`${relay}/approve`, { id }, { 'X-SameRow-Token': 'test:other' })).status, 409);
  assert.equal((await post(`${relay}/claim`, { id, secret: 'f'.repeat(64) })).status, 410);
  assert.equal((await request('complete', { id })).status, 204);
  assert.equal((await request('complete', { id })).status, 204);
  const file = join(dataDir, 'connector-pairing.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(worker.SAMEROW_CONNECTOR_TOKEN, saved.token);
  assert.equal(worker.SAMEROW_CONNECTOR_JELLYFIN_URL, 'http://other:8096/jellyfin');
  assert.equal(worker.JELLYFIN_ALLOWED_ORIGINS, 'http://other:8096');
  assert.deepEqual(JSON.parse((await request('settings', {})).data), { paired: true, jellyfinUrl: saved.jellyfinUrl });
  assert.deepEqual(JSON.parse((await request('start', { jellyfinUrl: saved.jellyfinUrl })).data), { alreadyPaired: true });
  const nextApproval = new URL(JSON.parse((await request('start', { jellyfinUrl: settings.jellyfinUrl })).data).approvalUrl);
  assert.notEqual(new URLSearchParams(nextApproval.hash.slice(1)).get('connector'), id);
  assert.equal(worker.SAMEROW_CONNECTOR_TOKEN, saved.token);
  worker = null;
  const stopRestored = installConnectorSetup(express(), settings, { SAMEROW_DATA_DIR: dataDir }, dependencies);
  t.after(stopRestored);
  assert.equal(worker.SAMEROW_CONNECTOR_TOKEN, saved.token);
});

test('generated codes are reserved and private rooms require the full invite link', async t => {
  const application = await start(t);
  const makeSocket = async user => {
    const socket = connect(application.url, { transports: ['websocket'], auth: { token: `test:${user}` } });
    t.after(() => socket.disconnect());
    await next(socket, 'connect');
    return socket;
  };
  const [host, guest] = await Promise.all([makeSocket('host'), makeSocket('guest')]);
  const privateRoom = await ack(host, 'generate-room', true);
  const publicRoom = await ack(host, 'generate-room', false);
  assert.match(privateRoom.code, /^[A-Z]{4}$/);
  assert.match(publicRoom.code, /^[A-Z]{4}$/);
  assert.notEqual(privateRoom.code, publicRoom.code);
  assert.match(privateRoom.invite, /^[a-f0-9]{48}$/);
  assert.equal(publicRoom.invite, undefined);
  assert.equal((await ack(guest, 'join-room', privateRoom.code, 'Guest')).status, 403);
  assert.equal((await ack(guest, 'join-room', privateRoom.code, 'Guest', 'wrong-secret')).status, 403);
  assert.equal((await ack(host, 'join-room', privateRoom.code, 'Host')).ok, true);
  assert.equal((await ack(guest, 'join-room', privateRoom.code, 'Guest', privateRoom.invite)).ok, true);
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
