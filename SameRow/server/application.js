const express = require('express');
const http = require('node:http');
const { randomUUID, randomBytes, randomInt } = require('node:crypto');
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
  const membershipRemovals = new Set();
  let draining = false, redisPub, redisSub, closed = false;
  const infrastructureReady = () => store.ready && (!store.client || redisPub?.isReady && redisSub?.isReady);
  const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
  const stats = { startedAt: Date.now(), events: 0, rejected: 0, errors: 0, storageFailures: 0, disconnects: {} };
  const localHosts = new Set(config.origins.map(origin => new URL(origin).host));
  const hostAllowed = req => !config.localEdition || localHosts.has(req.headers.host);
  const originAllowed = origin => !origin || config.origins.includes(origin) || !config.production && !config.origins.length;
  // The Jellyfin iframe deliberately has an opaque sandbox origin. Only its
  // scoped gateway accepts Origin:null; account APIs and signaling reject it.
  const sandboxOrigin = req => req.get('Origin') === 'null' && req.path.startsWith('/api/jellyfin-native/');
  app.disable('x-powered-by'); app.set('trust proxy', config.production ? 1 : false);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' }, frameguard: false }));
  app.use((req, res, next) => {
    if (!hostAllowed(req)) return res.status(403).send('Open SameRow using its configured local address.');
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
  app.get('/api/config', (req, res) => res.set('Cache-Control', 'no-store').json({
    auth: config.authMode,
    media: config.mediaMode,
    maxRoomSize: config.maxRoomSize,
    role: config.serviceRole,
    roomProtocol: 1,
    ...(config.production ? { firebaseProjectId: config.firebaseProjectId, mediaOrigin: config.mediaOrigin } : {}),
    ...(config.jellyfinRelay ? { jellyfinRelay: true } : {}),
    ...(config.hostedWebOrigin ? { hostedWebOrigin: config.hostedWebOrigin } : {}),
  }));
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
    pingInterval: 25000, pingTimeout: 30000,
    allowRequest: (req, callback) => {
      if (draining || !infrastructureReady() || config.serviceRole === 'media' || !hostAllowed(req) || !originAllowed(req.headers.origin)) return callback('Unavailable', false);
      const ip = config.production ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
      store.limit(`connect:${ip}`, config.maxConnectionsPerIp || 600, 60).then(ok => callback(ok ? null : 'Too many connections', ok)).catch(() => callback('Unavailable', false));
    },
  });
  installIdentity(io, app, identity);
  io.use(async (socket, next) => {
    try {
      if (!await store.limit(`authenticated-connect:${socket.data.uid}`, 60, 60)) return next(new Error('Too many reconnect attempts. Please wait.'));
      next();
    } catch { next(new Error('Shared storage is reconnecting.')); }
  });
  const canControl = async (socket, roomId) => {
    if (!validRoom(roomId) || socket.data.roomId !== roomId || !socket.rooms.has(roomId)) return false;
    if (config.controlPolicy === 'everyone') return true;
    return (await store.get(`room:${roomId}`))?.ownerUid === socket.data.uid;
  };
  io.on('connection', socket => {
    socket.data.clientId = typeof socket.handshake.auth?.clientId === 'string' && /^[a-f0-9-]{36}$/i.test(socket.handshake.auth.clientId) ? socket.handshake.auth.clientId : socket.id;
    socket.queue = Promise.resolve(); socket.pendingEvents = 0;
    // Preserve arrival order across asynchronous joins and Redis operations.
    socket.handle = (event, handler) => socket.on(event, (...args) => {
      if (++socket.pendingEvents > 100) { socket.disconnect(true); socket.pendingEvents--; return; }
      socket.queue = socket.queue.then(async () => {
        if (!socket.connected) return;
        if (!infrastructureReady()) throw failure(503, 'Room storage is reconnecting. Try again shortly.');
        if (event !== 'auth-refresh' && socket.data.expiresAt <= Date.now()) { socket.emit('session-expired'); socket.conn.close(); return; }
        if (!await store.limit(`events:${socket.data.uid}`, 600, 60)) throw failure(429, 'Too many room actions. Please wait a moment.');
        stats.events++; await handler(...args);
      }).catch(error => {
        if (error.status && error.status < 500) stats.rejected++; else stats.errors++;
        const message = error.status ? error.message : 'The server could not complete that action. Try again.';
        const ack = args.at(-1);
        if (typeof ack === 'function') ack({ error: message, status: error.status || 500 }); else socket.emit('room-error', { error: message });
        if (!error.status || error.status >= 500) console.error(JSON.stringify({ level: 'error', event: 'socket_action_failed', action: event }));
      }).finally(() => socket.pendingEvents--);
    });
    socket.on('disconnect', reason => { stats.disconnects[reason] = (stats.disconnects[reason] || 0) + 1; });
    socket.emit('me', socket.id);
    socket.handle('auth-refresh', async (token, ack) => {
      if (!await store.limit(`auth-refresh:${socket.data.uid}`, 10, 60)) throw failure(429, 'Please wait before refreshing your sign-in.');
      const user = await identity.verify(token);
      if (user.uid !== socket.data.uid) { socket.disconnect(true); return; }
      socket.identityToken = token; socket.data.expiresAt = user.exp * 1000; if (typeof ack === 'function') ack({ ok: true });
    });
    socket.handle('generate-room', async (privateRoom, ack) => {
      if (typeof ack !== 'function') return;
      if (!await store.limit(`generate-room:${socket.data.uid}`, 10, 60)) throw failure(429, 'Wait before generating another room code.');
      const invite = privateRoom === true ? randomBytes(24).toString('hex') : undefined;
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = Array.from({ length: 4 }, () => String.fromCharCode(65 + randomInt(26))).join('');
        try {
          await store.update(`room:${code}`, current => {
            if (current) throw failure(409, 'Room code is in use.');
            return { ownerUid: socket.data.uid, createdAt: Date.now(), invite };
          }, 300);
          return ack({ code, invite });
        } catch (error) {
          if (error.status !== 409) throw error;
        }
      }
      throw failure(503, 'Could not reserve a room code. Try again.');
    });
    socket.handle('join-room', async (roomId, userName, invite, ack) => {
      if (typeof invite === 'function') { ack = invite; invite = undefined; }
      if (!validRoom(roomId) || typeof userName !== 'string' || !userName.trim() || userName.length > 80) throw failure(400, 'Use a valid room code and a name of at most 80 characters.');
      if (socket.data.roomId && socket.data.roomId !== roomId) throw failure(409, 'Leave the current room before joining another.');
      const reserved = await store.update(`room:${roomId}`, current => {
        if (current?.invite && current.ownerUid !== socket.data.uid && current.invite !== invite) {
          throw failure(403, 'This room requires an invite link.');
        }
        return current || { ownerUid: socket.data.uid, createdAt: Date.now() };
      }, config.roomTtl);
      const name = userName.trim().replace(/[\u0000-\u001f\u007f]/g, '');
      const now = Date.now();
      const sameClient = value => value.uid === socket.data.uid && value.clientId === socket.data.clientId;
      const previousPresence = await store.get(`presence:${roomId}`) || [];
      await store.update(`presence:${roomId}`, current => {
        const live = (current || []).filter(value => value.until > now && value.id !== socket.id && !sameClient(value));
        if (live.length >= config.maxRoomSize) throw failure(409, `This room is full (${config.maxRoomSize} people).`);
        return [...live, { id: socket.id, uid: socket.data.uid, clientId: socket.data.clientId, until: now + LEASE_SECONDS * 1000 }];
      }, LEASE_SECONDS * 2);
      // A reconnect reclaims this authenticated tab's seat even when the old
      // process crashed before releasing its lease. Other tabs keep their seats.
      for (const previous of previousPresence.filter(value => value.id !== socket.id && sameClient(value))) {
        await removeMembership({ id: previous.id, data: { roomId } });
        io.in(previous.id).disconnectSockets(true);
      }
      await store.update(`youtube:${roomId}`, current => current || createState(), config.roomTtl);
      await store.set(`member:${roomId}:${socket.id}`, { uid: socket.data.uid }, LEASE_SECONDS);
      if (!socket.connected) {
        await store.set(`member:${roomId}:${socket.id}`, null);
        await store.update(`presence:${roomId}`, current => (current || []).filter(value => value.id !== socket.id), LEASE_SECONDS * 2);
        return;
      }
      const alreadyJoined = socket.rooms.has(roomId);
      socket.data.roomId = roomId; socket.data.userName = name; socket.membershipRenewedAt = now; await socket.join(roomId);
      if (!alreadyJoined) socket.to(roomId).emit('user-connected', { userId: socket.id, userName: name });
      const reply = { ok: true, mediaMode: config.mediaMode, mediaBase: config.mediaOrigin, canControl: config.controlPolicy === 'everyone' || reserved.ownerUid === socket.data.uid, invite: reserved.invite, maxRoomSize: config.maxRoomSize };
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
      const removal = removeMembership(socket).catch(() => {}).finally(() => membershipRemovals.delete(removal));
      membershipRemovals.add(removal);
    });
  });
  async function removeMembership(socket) {
    const roomId = socket.data.roomId; if (!roomId) return;
    if (mediaService) mediaService.removeParticipant(`${config.prefix}:${roomId}`, socket.id).catch(() => {});
    await store.set(`member:${roomId}:${socket.id}`, null);
    await jellyfin.releaseSocket(socket, roomId);
    await store.update(`presence:${roomId}`, current => (current || []).filter(value => value.id !== socket.id && value.until > Date.now()), LEASE_SECONDS * 2);
  }
  let heartbeatRunning = false;
  async function renewMemberships() {
    if (heartbeatRunning || closed) return;
    heartbeatRunning = true;
    try {
      const rooms = new Map();
      const sockets = [...io.sockets.sockets.values()];
      // Bound Firebase/Redis concurrency and avoid N competing CAS updates of
      // the same room presence array every heartbeat.
      for (let offset = 0; offset < sockets.length; offset += 16) {
        await Promise.all(sockets.slice(offset, offset + 16).map(async socket => {
          if (!socket.connected) return;
          if (socket.data.expiresAt <= Date.now()) { socket.emit('session-expired'); socket.conn.close(); return; }
          if (socket.data.expiresAt - Date.now() < 120000 && socket.warnedExpiry !== socket.data.expiresAt) {
            socket.warnedExpiry = socket.data.expiresAt; socket.emit('session-expiring');
          }
          const roomId = socket.data.roomId; if (!roomId) return;
          try { await identity.verify(socket.identityToken); }
          catch { socket.emit('session-expired'); socket.conn.close(); return; }
          if (!rooms.has(roomId)) rooms.set(roomId, []);
          rooms.get(roomId).push(socket);
        }));
      }
      for (const [roomId, members] of rooms) {
        try {
          const now = Date.now();
          await Promise.all(members.map(async socket => {
            await store.set(`member:${roomId}:${socket.id}`, { uid: socket.data.uid }, LEASE_SECONDS);
            if (!socket.connected || socket.data.roomId !== roomId) await store.set(`member:${roomId}:${socket.id}`, null);
          }));
          const live = members.filter(socket => socket.connected && socket.data.roomId === roomId);
          const ids = new Set(members.map(socket => socket.id));
          await store.update(`presence:${roomId}`, current => [
            ...(current || []).filter(value => !ids.has(value.id) && value.until > now),
            ...live.filter(socket => socket.connected && socket.data.roomId === roomId).map(socket => ({ id: socket.id, uid: socket.data.uid, clientId: socket.data.clientId, until: now + LEASE_SECONDS * 1000 })),
          ], LEASE_SECONDS * 2);
          await Promise.all(['room', 'youtube', 'jellyfin-room'].map(kind => store.touch(`${kind}:${roomId}`, config.roomTtl)));
          live.forEach(socket => { socket.membershipRenewedAt = now; });
        } catch {
          stats.storageFailures++;
          // Preserve live transports through short Redis interruptions. If the
          // lease is near expiry, close the transport so Socket.IO retries.
          for (const socket of members) if (Date.now() - socket.membershipRenewedAt >= 60000) socket.conn.close();
        }
      }
    } finally { heartbeatRunning = false; }
  }
  const heartbeat = setInterval(() => { renewMemberships().catch(() => { stats.errors++; }); }, 20000); heartbeat.unref();
  const relay = require('./jellyfinRelay').installJellyfinRelay(app, { config, store, identity });
  const networkPolicy = { production: config.production, allowPrivate: config.allowPrivateJellyfin, origins: config.upstreamOrigins };
  const accounts = require('./jellyfinAccounts').installJellyfinAccounts(app, { ...(options.accountOptions || {}), relay, ...(options.store ? { store } : {}), networkPolicy });
  const jellyfin = require('./jellyfin').installJellyfin(app, io, accounts, { store, canControl, production: config.production, networkPolicy, roomTtl: config.roomTtl, allowedOrigins: config.origins, publicOrigin: config.mediaOrigin, quality: config.jellyfinQuality });
  require('./chat').installChat(io, { store, identity });
  if (config.localEdition) {
    const webRoot = require('node:path').resolve(__dirname, '../client/dist');
    app.use(express.static(webRoot));
  }
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
    clearInterval(heartbeat); eventLoop.disable(); relay?.close(); jellyfin.close(); accounts.close();
    // io.close() alone sends a namespace disconnect, which disables client
    // auto-reconnection. A deployment must close transports instead.
    for (const socket of io.sockets.sockets.values()) socket.conn.close(true);
    await new Promise(resolve => io.close(resolve));
    await Promise.allSettled([...membershipRemovals]);
    await Promise.allSettled([redisPub?.isOpen && redisPub.quit(), redisSub?.isOpen && redisSub.quit()]);
    if (closeStore) await store.close(); await identity.close?.();
  }
  server.on('close', () => { clearInterval(heartbeat); eventLoop.disable(); accounts.close(); jellyfin.close(); });
  return { app, server, io, store, identity, config, ready, close, renewMemberships, drain: () => { draining = true; } };
}
module.exports = { createApplication };
