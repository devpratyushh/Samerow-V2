const clientKey = socket => `${socket.data.uid}:${socket.data.clientId}`;

// Keep the room clock parked while the current viewers buffer the opening frame.
// A stalled player gets a grace period before ready viewers can continue.
async function prepareStart(io, roomId, socket) {
  if (!socket.data.initialBuffer) return null;
  const viewers = await io.in(roomId).fetchSockets();
  return { viewers: [...new Set([clientKey(socket), ...viewers.filter(viewer => viewer.data.initialBuffer).map(clientKey)])],
    ready: [], deadline: Date.now() + 15000 };
}

async function markStartReady({ store, key, ttl, socket, sessionId, revision, getId, start }) {
  const viewer = clientKey(socket);
  const now = Date.now();
  const needsReport = current => current?.startup && getId(current) === sessionId && current.revision === revision &&
    current.startup.viewers.includes(viewer) && (!current.startup.ready.includes(viewer) || now >= current.startup.deadline);
  if (typeof sessionId !== 'string' || !Number.isSafeInteger(revision) || !needsReport(await store.get(key))) return null;
  let started;
  const state = await store.update(key, current => {
    // Redis may retry the callback if another viewer updates this session first.
    started = false;
    if (!needsReport(current)) return current;
    const pending = current?.startup;
    const ready = pending.ready.includes(viewer) ? pending.ready : [...pending.ready, viewer];
    if (ready.length === pending.viewers.length || now >= pending.deadline) {
      started = true;
      return start({ ...current, startup: null, revision: revision + 1 }, now);
    }
    return { ...current, startup: { ...pending, ready } };
  }, ttl);
  return started ? state : null;
}

module.exports = { prepareStart, markStartReady };
