// Keep local capture and desired settings while replacing a failed SFU session.
// The SDK handles short ICE outages first; this runs only after terminal failure.
export function maintainCall({ open, signal, onError, onPeers, retryDelay = attempt => Math.min(1000 * 2 ** Math.min(attempt, 5), 15000) * (0.75 + Math.random() * 0.5) }) {
  let active, pending, timer, closed = false, attempts = 0, epoch = 0;
  let screen = null, screenApplied = null, stateVersion = 0;
  const muted = { audio: false, video: false };
  let queue = Promise.resolve();
  const reconcile = () => {
    queue = queue.catch(() => {}).then(async () => {
      const call = active;
      if (!call || closed) return;
      await call.syncTracks();
      if (call !== active || closed) return;
      for (const kind of ['audio', 'video']) await call.setMuted(kind, muted[kind]);
      const desired = screen?.getVideoTracks().some(track => track.readyState === 'live') ? screen : null;
      if (call !== active || closed || screenApplied === desired) return;
      await call.stopScreen();
      if (desired && call === active && !closed) await call.publishScreen(desired);
      if (call === active) screenApplied = desired;
    });
    return queue;
  };
  const retry = current => {
    if (closed || current !== epoch) return;
    epoch++; pending?.abort(); pending = null; active?.close(); active = null; screenApplied = null; queue = Promise.resolve();
    onPeers([]);
    if (attempts === 0) onError('The call was interrupted. Reconnecting automatically…');
    clearTimeout(timer); timer = setTimeout(start, retryDelay(attempts++));
  };
  async function start() {
    if (closed) return;
    const current = ++epoch;
    pending = new AbortController();
    try {
      const call = await open({ signal: pending.signal, onDisconnected: () => retry(current) });
      if (closed || epoch !== current) { call?.close(); return; }
      active = call; screenApplied = null;
      // Settings may change while publish calls are awaiting the network.
      let version;
      do { version = stateVersion; await reconcile(); } while (!closed && current === epoch && version !== stateVersion);
      if (current === epoch) attempts = 0;
    } catch { retry(current); }
  }
  const close = () => {
    if (closed) return;
    closed = true; epoch++; clearTimeout(timer); pending?.abort(); active?.close(); active = null;
    signal.removeEventListener('abort', close);
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close(); else void start();
  return {
    close,
    syncTracks: reconcile,
    setMuted(kind, value) { muted[kind] = value; stateVersion++; return reconcile(); },
    publishScreen(value) { screen = value; stateVersion++; return reconcile(); },
    stopScreen() { screen = null; stateVersion++; return reconcile(); },
  };
}
