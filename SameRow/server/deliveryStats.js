const { Transform } = require('node:stream');

// Count media at the gateway boundary, shared by direct, Docker and plugin routes.
// Redis-backed store updates make snapshots work across control/media replicas.
function createDeliveryStats(store) {
  const key = (viewer, state) => `delivery:${state.id}:${viewer.socketId}`;
  function meter(viewer, state) {
    let bytes = 0, timer, queue = Promise.resolve();
    const flush = () => {
      clearTimeout(timer); timer = null;
      const count = bytes; bytes = 0;
      if (count) queue = queue.catch(() => {}).then(() => store.update(key(viewer, state), previous => ({
        bytes: (previous?.bytes || 0) + count, updatedAt: Date.now(),
      }), 86400));
      return queue;
    };
    const stream = new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (!timer) { timer = setTimeout(() => { void flush().catch(() => {}); }, 1000); timer.unref(); }
      done(null, chunk);
    }, flush(done) { flush().then(() => done(), () => done()); } });
    stream.once('close', () => { void flush().catch(() => {}); });
    return stream;
  }
  async function snapshot(state, members) {
    const viewers = await Promise.all(members.map(async member => {
      const value = await store.get(key({ socketId: member.id }, state));
      const playback = await store.get(`playback:${state.id}:${member.id}`);
      return { id: member.id, name: member.data?.userName || member.data?.name || 'Guest', bytes: value?.bytes || 0, updatedAt: value?.updatedAt || null, playback };
    }));
    return { sessionId: state.id, sampledAt: Date.now(), viewers, bytes: viewers.reduce((sum, viewer) => sum + viewer.bytes, 0) };
  }
  async function report(state, socketId, stats) {
    if (!stats || typeof stats !== 'object') return;
    const clean = { reportedAt: Date.now(), paused: stats.paused === true };
    for (const [field, maximum] of Object.entries({ width: 16384, height: 16384, buffer: 86400, frames: 1e12, dropped: 1e12, readyState: 4 })) {
      clean[field] = Number.isFinite(stats[field]) && stats[field] >= 0 && stats[field] <= maximum ? stats[field] : null;
    }
    await store.set(`playback:${state.id}:${socketId}`, clean, 20);
  }
  return { meter, snapshot, report };
}
module.exports = { createDeliveryStats };
