const { Transform } = require('node:stream');

// Count media at the gateway boundary, shared by direct and plugin routes.
// Redis-backed store updates make snapshots work across control/media replicas.
function createDeliveryStats(store, dailyBytes = 0) {
  const key = (viewer, state) => `delivery:${state.id}:${viewer.socketId}`;
  const budgetKey = () => `jellyfin-relay-budget:${Math.floor(Date.now() / 86400000)}`;
  const exhausted = () => Object.assign(new Error('The HTTPS relay has reached its daily bandwidth limit.'), { status: 429 });
  async function checkBudget() {
    if (dailyBytes && (await store.get(budgetKey()) || 0) >= dailyBytes) throw exhausted();
  }
  async function reserveBudget(key, bytes) {
    await store.update(key, current => {
      const used = current || 0;
      if (used + bytes > dailyBytes) throw exhausted();
      return used + bytes;
    }, 172800);
  }
  function meter(viewer, state) {
    let bytes = 0, timer, queue = Promise.resolve(), allowance = 0, day;
    const flush = () => {
      clearTimeout(timer); timer = null;
      const count = bytes; bytes = 0;
      if (count) queue = queue.catch(() => {}).then(() => store.update(key(viewer, state), previous => ({
        bytes: (previous?.bytes || 0) + count, updatedAt: Date.now(),
      }), 86400));
      return queue;
    };
    const forward = (chunk, done) => {
      bytes += chunk.length;
      if (!timer) { timer = setTimeout(() => { void flush().catch(() => {}); }, 1000); timer.unref(); }
      done(null, chunk);
    };
    const stream = new Transform({ transform(chunk, encoding, done) {
      if (!dailyBytes) return forward(chunk, done);
      const currentDay = budgetKey();
      if (day !== currentDay) { allowance = 0; day = currentDay; }
      if (allowance >= chunk.length) { allowance -= chunk.length; return forward(chunk, done); }
      const needed = chunk.length - allowance;
      // Reserve in bounded blocks to avoid a Redis round trip for every chunk.
      const block = Math.max(needed, Math.min(dailyBytes, 256 * 1024));
      reserveBudget(currentDay, block).catch(error => {
        if (error.status !== 429 || block === needed) throw error;
        return reserveBudget(currentDay, needed).then(() => needed);
      }).then(reserved => {
        allowance += (reserved ?? block) - chunk.length;
        forward(chunk, done);
      }, done);
    }, flush(done) { flush().then(() => done(), () => done()); } });
    stream.once('close', () => {
      void flush().catch(() => {});
      if (allowance) {
        void store.update(day, current => current == null ? null : Math.max(0, current - allowance), 172800).catch(() => {});
      }
    });
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
  return { meter, checkBudget, snapshot, report };
}
module.exports = { createDeliveryStats };
