// Refresh credentials on a live socket, or reconnect with them after expiry.
// A failed refresh must not permanently suppress later recovery attempts.
export function maintainSession({ socket, getToken, onError, retryDelay = attempt => Math.min(1000 * 2 ** Math.min(attempt, 5), 30000) * (0.75 + Math.random() * 0.5) }) {
  let disposed = false, refreshing = false, timer, attempts = 0;
  const refresh = async () => {
    if (disposed || refreshing) return;
    refreshing = true; clearTimeout(timer);
    try {
      const token = await getToken();
      if (disposed) return;
      if (!token) throw Error('Sign in again to reconnect.');
      socket.auth = { token, ...(socket.clientId ? { clientId: socket.clientId } : {}) };
      if (socket.connected) {
        await new Promise((resolve, reject) => socket.timeout(10000).emit('auth-refresh', token, (error, reply) => error || reply?.error ? reject(Error('Sign-in refresh interrupted. Retrying…')) : resolve()));
      } else socket.connect();
      if (socket.connected) attempts = 0;
    } catch {
      if (!disposed) { onError('Refreshing your connection…'); timer = setTimeout(refresh, retryDelay(attempts++)); }
    } finally { refreshing = false; }
  };
  const failed = error => {
    if (disposed || refreshing) return;
    clearTimeout(timer);
    if (error.data?.code === 'UNAUTHENTICATED') timer = setTimeout(refresh, retryDelay(attempts++));
    else if (!socket.active) timer = setTimeout(() => { if (!disposed) socket.connect(); }, retryDelay(attempts++));
  };
  const connected = () => { attempts = 0; };
  const online = () => { if (!socket.connected) void refresh(); };
  socket.on('connect', connected); globalThis.addEventListener?.('online', online);
  const disconnected = reason => { if (reason === 'io server disconnect') void refresh(); };
  socket.on('session-expiring', refresh); socket.on('session-expired', refresh);
  socket.on('connect_error', failed); socket.on('disconnect', disconnected);
  return () => {
    disposed = true; clearTimeout(timer);
    socket.off('connect', connected); globalThis.removeEventListener?.('online', online);
    socket.off('session-expiring', refresh); socket.off('session-expired', refresh);
    socket.off('connect_error', failed); socket.off('disconnect', disconnected);
  };
}
