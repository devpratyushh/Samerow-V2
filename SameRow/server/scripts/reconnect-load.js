// Local-only fault probe: real Redis + two app instances behind a TCP router.
// Measures signaling recovery, not SFU media throughput or public-network quality.
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { io } = require('socket.io-client');
const { createApplication } = require('../application');
const { configuration } = require('../config');
const { createStore } = require('../store');
const count = Number(process.env.LOAD_USERS || 100), roomSize = Number(process.env.LOAD_ROOM_SIZE || 20);
if (!Number.isInteger(count) || count < 2 || count > 500 || !Number.isInteger(roomSize) || roomSize < 2 || roomSize > 25) throw Error('Use 2–500 users and 2–25 per room.');
const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(redisUrl).hostname)) throw Error('TEST_REDIS_URL must point to disposable local Redis.');
const waitFor = async (predicate, details = () => ({})) => {
  const deadline = performance.now() + 30000;
  while (!predicate()) { if (performance.now() > deadline) throw Error('Recovery timed out: ' + JSON.stringify(details())); await new Promise(resolve => setTimeout(resolve, 25)); }
};
const ack = (socket, event, ...args) => new Promise((resolve, reject) => socket.timeout(10000).emit(event, ...args, (error, reply) => error || reply?.error ? reject(Error(reply?.error || 'timeout')) : resolve(reply)));
(async () => {
  const { maintainRoomMembership } = await import('../../client/src/roomMembership.js');
  const prefix = `reconnect-probe:${randomUUID()}`, servers = [], sockets = [], stops = [], pipes = new Set(), ready = new Set();
  let ports = [], cursor = 0;
  const router = net.createServer(client => {
    const upstream = net.connect(ports[cursor++ % ports.length], '127.0.0.1');
    pipes.add(client); pipes.add(upstream);
    client.pipe(upstream); upstream.pipe(client);
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => { pipes.delete(client); upstream.destroy(); });
    upstream.on('close', () => { pipes.delete(upstream); client.destroy(); });
  });
  try {
    for (let i = 0; i < 2; i++) {
      const config = { ...configuration({}), redisUrl, encryptionKey: 'c'.repeat(64), prefix, maxRoomSize: 25 };
      const app = createApplication({ config, store: await createStore(config) }); await app.ready;
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); servers.push(app); ports.push(app.server.address().port);
    }
    await new Promise(resolve => router.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${router.address().port}`;
    let reconnects = 0; const reasons = {}, joinErrors = {};
    for (let i = 0; i < count; i++) {
      const socket = io(address, { transports: ['websocket'], forceNew: true, auth: { token: `dev:viewer-${i}`, clientId: randomUUID() }, reconnectionDelay: 250, reconnectionDelayMax: 2000 });
      socket.on('disconnect', reason => { reasons[reason] = (reasons[reason] || 0) + 1; });
      socket.on('connect_error', error => { joinErrors[error.message] = (joinErrors[error.message] || 0) + 1; });
      socket.on('connect', () => reconnects++); sockets.push(socket);
      stops.push(maintainRoomMembership({ socket, roomId: `room-${Math.floor(i / roomSize)}`, userName: `Viewer ${i}`,
        onPending: () => {
          const host = sockets[Math.floor(i / roomSize) * roomSize], roomId = `room-${Math.floor(i / roomSize)}`;
          if (!ready.has(Math.floor(i / roomSize) * roomSize)) return;
          ack(host, 'room-requests', roomId).then(({ requests }) => {
            const request = requests.find(value => value.name === `Viewer ${i}`);
            if (request) return ack(host, 'room-request-answer', roomId, request.id, true);
          }).catch(error => { joinErrors[error.message] = (joinErrors[error.message] || 0) + 1; });
        },
        onReady: () => ready.add(i), onWaiting: () => ready.delete(i), onError: message => { joinErrors[message] = (joinErrors[message] || 0) + 1; }, retryDelay: attempt => Math.min(100 * 2 ** attempt, 1000) }));
    }
    await waitFor(() => ready.size === count);
    console.log(JSON.stringify({ phase: 'joined', users: ready.size }));
    const snapshots = await Promise.all(sockets.map((socket, i) => ack(socket, 'sync-request', `room-${Math.floor(i / roomSize)}`)));
    const started = performance.now();
    ports = [servers[1].server.address().port];
    await servers[0].close(); // a rolling restart sends transport closure
    await waitFor(() => ready.size === count && reconnects > count, () => ({ ready: ready.size, connected: sockets.filter(socket => socket.connected).length, reconnects, reasons, joinErrors }));
    const recoveredMs = performance.now() - started;
    const latencies = [];
    for (let round = 0; round < 5; round++) await Promise.all(sockets.map(async (socket, i) => {
      const sent = performance.now();
      const reply = await ack(socket, 'sync-request', `room-${Math.floor(i / roomSize)}`);
      if (reply.state.sessionId !== snapshots[i].state.sessionId) throw Error('Shared movie state was lost');
      latencies.push(performance.now() - sent);
    }));
    latencies.sort((a, b) => a - b);
    console.log(JSON.stringify({ users: count, roomSize, recovered: ready.size, reconnects: reconnects - count, recoveredMs, postRecoveryRequests: latencies.length, p95Ms: latencies[Math.floor(latencies.length * .95)] }));
  } finally {
    stops.forEach(stop => stop()); sockets.forEach(socket => socket.disconnect()); pipes.forEach(pipe => pipe.destroy());
    if (router.listening) await new Promise(resolve => router.close(resolve));
    const surviving = servers.find(app => app.store.ready);
    if (surviving) { const keys = await surviving.store.client.keys(`${prefix}:*`); if (keys.length) await surviving.store.client.del(keys); }
    await Promise.allSettled(servers.map(app => app.close()));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
