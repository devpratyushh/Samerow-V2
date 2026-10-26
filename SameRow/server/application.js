const express = require('express');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const { configuration } = require('./config');
const { MemoryStore } = require('./store');
const { createIdentity, installIdentity } = require('./auth');
const { isVideoUrl, isTimestamp, createState, snapshot, updateState } = require('./youtube');

const validRoom = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const failure = (status, message) => Object.assign(new Error(message), { status });
const LEASE_SECONDS = 90;

function createApplication(options = {}) {
  const config = options.config || configuration();
  const store = options.store || new MemoryStore();
  if (config.production && !store.client) throw new Error('Production requires a connected Redis store.');
  const identity = options.identity || createIdentity(config);
  const mediaService = config.mediaMode === 'livekit' ? options.mediaService || new (require('livekit-server-sdk').RoomServiceClient)(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret) : null;
  const app = express(), server = http.createServer(app);
  let draining = false, redisPub, redisSub, closed = false;
  const infrastructureReady = () => store.ready && (!store.client || redisPub?.isReady && redisSub?.isReady);
  const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
  const stats = { startedAt: Date.now(), events: 0, rejected: 0, errors: 0 };
  const originAllowed = origin => !origin || config.origins.includes(origin) || !config.production && !config.origins.length;
  // The Jellyfin iframe deliberately has an opaque sandbox origin. Only its
  // scoped gateway accepts Origin:null; account APIs and signaling reject it.
  const sandboxOrigin = req => req.get('Origin') === 'null' && req.path.startsWith('/api/jellyfin-native/');
  app.disable('x-powered-by'); app.set('trust proxy', config.production ? 1 : false);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' }, frameguard: false }));
  app.use((req, res, next) => {
    const requestId = randomUUID(), started = Date.now(); res.set('X-Request-Id', requestId);
    res.on('finish', () => {
      // Raw URLs contain media bearer capabilities; never log them or headers.
      if (config.production && (res.statusCode >= 400 || process.env.ACCESS_LOGS === 'true')) console.log(JSON.stringify({ event: 'http', requestId, method: req.method, status: res.statusCode, durationMs: Date.now() - started }));
    });
    if (req.get('Origin') && !originAllowed(req.get('Origin')) && !sandboxOrigin(req)) return res.status(403).json({ error: 'This origin is not allowed.' });
    next();
  });
  if (config.serviceRole === 'control') {
    app.use('/api/jellyfin-native', (req, res) => res.sendStatus(404));
    app.use(/^\/api\/jellyfin\/[a-f0-9]{48}(?:\/|$)/, (req, res) => res.sendStatus(404));
  }
  app.use(cors((req, callback) => callback(null, { origin: originAllowed(req.get('Origin')) || sandboxOrigin(req),
    // Jellyfin Web sends additional cache/device headers. Reflect its preflight
    // headers only on the capability-protected native gateway.
    allowedHeaders: sandboxOrigin(req) ? undefined : ['Content-Type', 'Authorization', 'X-SameRow-Token', 'Range', 'If-Range'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'X-Request-Id'] })));
  app.use(express.json({ limit: '64kb', strict: true }));
  app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
  app.get(['/health/ready', '/api/status'], async (req, res) => {
    try { if (draining || !infrastructureReady() || !await store.ping()) throw Error(); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.get('/api/config', (req, res) => res.json({ auth: config.authMode, media: config.mediaMode, maxRoomSize: config.maxRoomSize }));
  app.get('/metrics', (req, res) => {
    if (!process.env.METRICS_TOKEN || req.get('Authorization') !== `Bearer ${process.env.METRICS_TOKEN}`) return res.sendStatus(404);
    res.json({ ...stats, sockets: io.engine.clientsCount, eventLoopP99Ms: eventLoop.percentile(99) / 1e6, rssBytes: process.memoryUsage().rss });
  });
  app.use((req, res, next) => {
    if (draining || !infrastructureReady()) return res.status(503).json({ error: 'Server is reconnecting. Try again shortly.' }); next();
  });
  const io = new Server(server, {
    cors: { origin: (origin, callback) => callback(null, originAllowed(origin)), methods: ['GET', 'POST'] },
    transports: config.production ? ['websocket'] : ['websocket', 'polling'], maxHttpBufferSize: 64 * 1024, serveClient: false,
    allowRequest: (req, callback) => {
      if (draining || !infrastructureReady() || config.serviceRole === 'media' || !originAllowed(req.headers.origin)) return callback('Unavailable', false);
      const ip = config.production ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
      store.limit(`connect:${ip}`, 120, 60).then(ok => callback(ok ? null : 'Too many connections', ok)).catch(() => callback('Unavailable', false));
    },
  });
  installIdentity(io, app, identity);
  const canControl = async (socket, roomId) => {
    if (!validRoom(roomId) || socket.data.roomId !== roomId || !socket.rooms.has(roomId)) return false;
    if (config.controlPolicy === 'everyone') return true;
    return (await store.get(`room:${roomId}`))?.ownerUid === socket.data.uid;
  };
  io.on('connection', socket => {
    socket.queue = Promise.resolve(); socket.pendingEvents = 0;
    // Preserve arrival order across asynchronous joins and Redis operations.
    socket.handle = (event, handler) => socket.on(event, (...args) => {
      if (++socket.pendingEvents > 100) { socket.disconnect(true); socket.pendingEvents--; return; }
      socket.queue = socket.queue.then(async () => {
        if (!socket.connected) return;
        if (!infrastructureReady()) throw failure(503, 'Room storage is reconnecting. Try again shortly.');
        if (event !== 'auth-refresh' && socket.data.expiresAt <= Date.now()) { socket.emit('session-expired'); socket.disconnect(true); return; }
        if (!await store.limit(`events:${socket.data.uid}`, 600, 60)) throw failure(429, 'Too many room actions. Please wait a moment.');
        stats.events++; await handler(...args);
      }).catch(error => {
        if (error.status && error.status < 500) stats.rejected++; else stats.errors++;
        const message = error.status ? error.message : 'The server could not complete that action. Try again.';
        const ack = args.at(-1);
        if (typeof ack === 'function') ack({ error: message }); else socket.emit('room-error', { error: message });
        if (!error.status || error.status >= 500) console.error(JSON.stringify({ level: 'error', event: 'socket_action_failed', action: event }));
      }).finally(() => socket.pendingEvents--);
    });
    socket.emit('me', socket.id);
    socket.handle('auth-refresh', async (token, ack) => {
      if (!await store.limit(`auth-refresh:${socket.data.uid}`, 10, 60)) throw failure(429, 'Please wait before refreshing your sign-in.');
      const user = await identity.verify(token);
      if (user.uid !== socket.data.uid) { socket.disconnect(true); return; }
      socket.identityToken = token; socket.data.expiresAt = user.exp * 1000; if (typeof ack === 'function') ack({ ok: true });
    });
    socket.handle('join-room', async (roomId, userName, ack) => {
      if (!validRoom(roomId) || typeof userName !== 'string' || !userName.trim() || userName.length > 80) throw failure(400, 'Use a valid room code and a name of at most 80 characters.');
      if (socket.data.roomId && socket.data.roomId !== roomId) throw failure(409, 'Leave the current room before joining another.');
      const name = userName.trim().replace(/[\u0000-\u001f\u007f]/g, '');
      const now = Date.now();
      await store.update(`presence:${roomId}`, current => {
        const live = (current || []).filter(value => value.until > now && value.id !== socket.id);
        if (live.length >= config.maxRoomSize) throw failure(409, `This room is full (${config.maxRoomSize} people).`);
        return [...live, { id: socket.id, uid: socket.data.uid, until: now + LEASE_SECONDS * 1000 }];
      }, LEASE_SECONDS * 2);
      const meta = await store.update(`room:${roomId}`, current => current || { ownerUid: socket.data.uid, createdAt: now }, config.roomTtl);
      await store.update(`youtube:${roomId}`, current => current || createState(), config.roomTtl);
      await store.set(`member:${roomId}:${socket.id}`, { uid: socket.data.uid }, LEASE_SECONDS);
      if (!socket.connected) {
        await store.set(`member:${roomId}:${socket.id}`, null);
        await store.update(`presence:${roomId}`, current => (current || []).filter(value => value.id !== socket.id), LEASE_SECONDS * 2);
        return;
      }
      const alreadyJoined = socket.rooms.has(roomId);
      socket.data.roomId = roomId; socket.data.userName = name; await socket.join(roomId);
      if (!alreadyJoined) socket.to(roomId).emit('user-connected', { userId: socket.id, userName: name });
      const reply = { ok: true, mediaMode: config.mediaMode, mediaBase: config.mediaOrigin, canControl: config.controlPolicy === 'everyone' || meta.ownerUid === socket.data.uid, maxRoomSize: config.maxRoomSize };
      if (typeof ack === 'function') ack(reply); socket.emit('room-ready', reply);
    });
    socket.handle('sync-request', async (roomId, ack) => {
      if (!validRoom(roomId) || !socket.rooms.has(roomId)) return;
      const state = await store.get(`youtube:${roomId}`); if (!state) return;
      const receivedAt = Date.now(), value = snapshot(state, receivedAt);
      if (typeof ack === 'function') ack({ state: value, serverReceivedAt: receivedAt, serverSentAt: Date.now() }); else socket.emit('youtube-sync', value);
    });
    socket.handle('youtube-change', async (payload = {}) => {
      if (!payload || !await canControl(socket, payload.roomId) || payload.url !== null && !isVideoUrl(payload.url) || !isTimestamp(payload.timestamp ?? 0)) return;
      const state = await store.update(`youtube:${payload.roomId}`, current => createState(payload.url, payload.url ? payload.timestamp || 0 : 0, Date.now(), (current?.revision || 0) + 1), config.roomTtl);
      io.to(payload.roomId).emit('youtube-sync', snapshot(state));
    });
    socket.handle('youtube-state-change', async (payload = {}) => {
      if (!payload || !await canControl(socket, payload.roomId)) return;
      const previous = await store.get(`youtube:${payload.roomId}`);
      if (!updateState(previous, payload) || payload.commandId && payload.commandId === previous?.commandId) return;
      const state = await store.update(`youtube:${payload.roomId}`, current => {
        if (payload.commandId && payload.commandId === current?.commandId) return current;
        return updateState(current, payload) || current;
      }, config.roomTtl);
      if (state?.sessionId === payload.sessionId) io.to(payload.roomId).emit('youtube-sync', snapshot(state));
    });
    socket.handle('update-user-state', async (payload = {}) => {
      if (!payload || !socket.rooms.has(payload.roomId) || !['audio', 'video'].includes(payload.type) || typeof payload.enabled !== 'boolean') return;
      socket.to(payload.roomId).emit('user-state-updated', { userId: socket.id, type: payload.type, enabled: payload.enabled });
    });
    socket.handle('signal', async (payload = {}) => {
      if (config.mediaMode !== 'mesh' || !payload || !socket.data.roomId || typeof payload.to !== 'string' || !payload.signal || typeof payload.signal !== 'object' || !await store.get(`member:${socket.data.roomId}:${payload.to}`)) return;
      io.to(payload.to).emit('signal', { signal: payload.signal, from: socket.id, userName: socket.data.userName, isScreenShare: !!payload.isScreenShare, screenOwner: payload.isScreenShare ? socket.id : null });
    });
    socket.handle('media-token', async (roomId, ack) => {
      if (socket.data.roomId !== roomId || !socket.rooms.has(roomId) || typeof ack !== 'function') return;
      if (config.mediaMode !== 'livekit') return ack({ mode: 'mesh' });
      const { AccessToken } = require('livekit-server-sdk');
      await mediaService.createRoom({ name: `${config.prefix}:${roomId}`, maxParticipants: config.maxRoomSize, emptyTimeout: 300 });
      const access = new AccessToken(config.livekitApiKey, config.livekitApiSecret, { identity: socket.id, name: socket.data.userName, ttl: '2m' });
      access.addGrant({ roomJoin: true, room: `${config.prefix}:${roomId}`, canPublish: true, canSubscribe: true, canPublishData: false });
      ack({ mode: 'livekit', url: config.livekitUrl, token: await access.toJwt() });
    });
    socket.handle('leave-room', async (roomId, ack) => {
      if (socket.data.roomId === roomId) { await removeMembership(socket); await socket.leave(roomId); delete socket.data.roomId; }
      if (typeof ack === 'function') ack({ ok: true });
    });
    socket.on('disconnecting', () => {
      const roomId = socket.data.roomId; if (roomId) socket.to(roomId).emit('user-disconnected', socket.id);
      removeMembership(socket).catch(() => {});
    });
  });
  async function removeMembership(socket) {
    const roomId = socket.data.roomId; if (!roomId) return;
    if (mediaService) mediaService.removeParticipant(`${config.prefix}:${roomId}`, socket.id).catch(() => {});
    await store.set(`member:${roomId}:${socket.id}`, null);
    await jellyfin.releaseSocket(socket, roomId);
    await store.update(`presence:${roomId}`, current => (current || []).filter(value => value.id !== socket.id && value.until > Date.now()), LEASE_SECONDS * 2);
  }
  const heartbeat = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.expiresAt <= Date.now()) { socket.emit('session-expired'); socket.disconnect(true); continue; }
      const roomId = socket.data.roomId; if (!roomId) continue;
      (async () => {
        try { await identity.verify(socket.identityToken); }
        catch { socket.emit('session-expired'); socket.disconnect(true); return; }
        await store.set(`member:${roomId}:${socket.id}`, { uid: socket.data.uid }, LEASE_SECONDS);
        if (!socket.connected || socket.data.roomId !== roomId) { await store.set(`member:${roomId}:${socket.id}`, null); return; }
        const now = Date.now();
        await store.update(`presence:${roomId}`, current => [...(current || []).filter(value => value.id !== socket.id && value.until > now), { id: socket.id, uid: socket.data.uid, until: now + LEASE_SECONDS * 1000 }], LEASE_SECONDS * 2);
        await Promise.all(['room', 'youtube', 'jellyfin-room'].map(kind => store.touch(`${kind}:${roomId}`, config.roomTtl)));
      })().catch(() => { socket.emit('room-error', { error: 'Room storage is reconnecting.' }); socket.disconnect(true); });
    }
  }, 20000); heartbeat.unref();
  const networkPolicy = { production: config.production, allowPrivate: config.allowPrivateJellyfin, origins: config.upstreamOrigins };
  const accounts = require('./jellyfinAccounts').installJellyfinAccounts(app, { ...(options.accountOptions || {}), ...(options.store ? { store } : {}), networkPolicy });
  const jellyfin = require('./jellyfin').installJellyfin(app, io, accounts, { store, canControl, production: config.production, networkPolicy, roomTtl: config.roomTtl, allowedOrigins: config.origins, publicOrigin: config.mediaOrigin, quality: config.jellyfinQuality });
  require('./chat').installChat(io, { store, identity });
  app.use((error, req, res, next) => {
    if (res.headersSent) { res.destroy(); return; }
    const status = error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : error.status || 500;
    res.status(status).json({ error: status === 413 ? 'Request is too large.' : status === 400 ? 'Send valid JSON.' : 'The server could not complete this request.' });
  });
  const ready = (async () => {
    if (store.client) {
      redisPub = store.client.duplicate(); redisSub = store.client.duplicate();
      redisPub.on('error', () => {}); redisSub.on('error', () => {});
      await Promise.all([redisPub.connect(), redisSub.connect()]);
      io.adapter(require('@socket.io/redis-adapter').createAdapter(redisPub, redisSub, { key: `${config.prefix}:socket`, requestsTimeout: 5000 }));
    }
  })();
  async function close({ closeStore = true } = {}) {
    if (closed) return; closed = true; draining = true;
    clearInterval(heartbeat); eventLoop.disable(); jellyfin.close(); accounts.close();
    await new Promise(resolve => io.close(resolve));
    await Promise.allSettled([redisPub?.isOpen && redisPub.quit(), redisSub?.isOpen && redisSub.quit()]);
    if (closeStore) await store.close(); await identity.close?.();
  }
  server.on('close', () => { clearInterval(heartbeat); eventLoop.disable(); accounts.close(); jellyfin.close(); });
  return { app, server, io, store, identity, config, ready, close, drain: () => { draining = true; } };
}
module.exports = { createApplication };
