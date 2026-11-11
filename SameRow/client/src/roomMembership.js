// Transport connection is not room membership. Retry only idempotent joins;
// never replay chat or playback commands after a network interruption.
export function maintainRoomMembership({ socket, roomId, userName, onReady, onWaiting, onError, retryDelay = attempt => Math.min(1000 * 2 ** Math.min(attempt, 5), 15000) * (0.75 + Math.random() * 0.5) }) {
  let disposed = false, generation = 0, timer, attempts = 0;
  const join = () => {
    if (disposed || !socket.connected) return;
    const current = ++generation, socketId = socket.id;
    clearTimeout(timer); onWaiting();
    socket.timeout(10000).emit('join-room', roomId, userName, (error, reply) => {
      if (disposed || current !== generation || !socket.connected || socket.id !== socketId) return;
      if (error || reply?.error || !reply?.ok) {
        onError(reply?.error || 'Reconnecting to the room…');
        if (reply?.status === 400 || reply?.status === 401 || reply?.status === 403) return;
        timer = setTimeout(join, retryDelay(attempts++)); return;
      }
      attempts = 0; socket.roomConfig = reply; onReady(reply);
    });
  };
  const disconnected = () => { generation++; clearTimeout(timer); onWaiting(); };
  socket.on('connect', join); socket.on('disconnect', disconnected);
  if (socket.connected) join();
  return () => { disposed = true; generation++; clearTimeout(timer); socket.off('connect', join); socket.off('disconnect', disconnected); };
}
