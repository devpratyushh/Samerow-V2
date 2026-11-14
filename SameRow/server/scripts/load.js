// Signaling-only load probe. It does not claim to measure WebRTC or movie egress.
// Run only against your staging service with an explicit URL and valid identity.
const { io } = require('socket.io-client');
const { performance } = require('node:perf_hooks');
const target = process.env.LOAD_URL;
const localIdentities = process.env.LOAD_DEV_IDENTITIES === 'true';
const tokens = process.env.LOAD_TOKENS_FILE ? JSON.parse(require('node:fs').readFileSync(process.env.LOAD_TOKENS_FILE, 'utf8')) : process.env.LOAD_TOKEN ? [process.env.LOAD_TOKEN] : [];
const count = Number(process.env.LOAD_USERS || (localIdentities ? 100 : tokens.length));
if (!Array.isArray(tokens) || !localIdentities && tokens.length < count) throw Error('Supply one valid identity per simulated user with LOAD_TOKENS_FILE.');
if (localIdentities && target && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) throw Error('Development identities are restricted to localhost.');
const roomSize = Number(process.env.LOAD_ROOM_SIZE || 4);
const seconds = Number(process.env.LOAD_SECONDS || 30);
if (!target || !localIdentities && !tokens.length || !Number.isInteger(count) || count < 1 || count > 1000 || !Number.isInteger(roomSize) || roomSize < 1 || seconds < 1 || seconds > 600) throw Error('Set LOAD_URL, LOAD_TOKENS_FILE and valid LOAD_USERS, LOAD_ROOM_SIZE, LOAD_SECONDS.');
const sockets = [], latencies = [], errors = [];
const start = performance.now();
const acknowledge = (socket, event, ...args) => new Promise((resolve, reject) => socket.timeout(10000).emit(event, ...args, (error, reply) => error || reply?.error ? reject(Error(reply?.error || 'timeout')) : resolve(reply)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    for (let i = 0; i < count; i++) {
      const socket = io(target, { transports: ['websocket'], auth: { token: localIdentities ? `dev:load-${i}` : tokens[i] }, forceNew: true, reconnection: false }); sockets.push(socket);
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      const roomId = `load-${Math.floor(start)}-${Math.floor(i / roomSize)}`;
      let reply = await acknowledge(socket, 'join-room', roomId, `Load ${i}`);
      if (reply.pending) {
        const host = sockets[Math.floor(i / roomSize) * roomSize];
        const { requests } = await acknowledge(host, 'room-requests', roomId);
        const request = requests.find(value => value.name === `Load ${i}`);
        if (!request) throw Error('Missing join request');
        await acknowledge(host, 'room-request-answer', roomId, request.id, true);
        reply = await acknowledge(socket, 'join-room', roomId, `Load ${i}`);
      }
      if (!reply.ok) throw Error('Room admission was not confirmed');
      // Stagger connection attempts instead of triggering the anti-abuse burst limit.
      await delay(550);
    }
    const deadline = performance.now() + seconds * 1000;
    while (performance.now() < deadline) {
      await Promise.all(sockets.map(async (socket, i) => {
        const sent = performance.now();
        try { await acknowledge(socket, 'sync-request', `load-${Math.floor(start)}-${Math.floor(i / roomSize)}`); latencies.push(performance.now() - sent); }
        catch { errors.push('sync'); }
      }));
      await delay(5000);
    }
    latencies.sort((a, b) => a - b);
    console.log(JSON.stringify({ users: count, roomSize, requests: latencies.length, errors: errors.length, p50Ms: latencies[Math.floor(latencies.length * .5)], p95Ms: latencies[Math.floor(latencies.length * .95)], p99Ms: latencies[Math.floor(latencies.length * .99)] }));
    if (errors.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { sockets.forEach(socket => socket.disconnect()); }
})();
