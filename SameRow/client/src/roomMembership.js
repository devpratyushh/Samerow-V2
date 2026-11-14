import { joinLegacyRoom } from './legacyRooms.js';

// Transport connection is not room membership. Retry only idempotent joins;
// never replay chat or playback commands after a network interruption.
export function maintainRoomMembership({ socket, roomId, userName, invite, onReady, onWaiting, onError, onPending = () => {}, onPreparing = () => {}, retryDelay = attempt => Math.min(1000 * 2 ** Math.min(attempt, 5), 15000) * (0.75 + Math.random() * 0.5) }) {
  let disposed = false, generation = 0, timer, attempts = 0, preparing = false, confirming = false;
  const join = () => {
    if (disposed || !socket.connected) return;
    const current = ++generation, socketId = socket.id;
    clearTimeout(timer); onWaiting();
    const complete = (error, reply) => {
      if (disposed || current !== generation || !socket.connected || socket.id !== socketId) return;
      confirming = false;
      if (!error && reply?.preparing) {
        preparing = true;
        onPreparing(reply, playback => {
          if (disposed || current !== generation || !preparing || confirming || !socket.connected) return;
          confirming = true;
          socket.timeout(10000).emit('room-playback-ready', roomId, playback, complete);
        });
        return;
      }
      preparing = false;
      if (!error && reply?.pending) { onPending(); timer = setTimeout(join, 2000); return; }
      if (error || reply?.error || !reply?.ok) {
        onError(reply?.error || 'Reconnecting to the room…');
        if (reply?.status === 400 || reply?.status === 401 || reply?.status === 403) return;
        timer = setTimeout(join, retryDelay(attempts++)); return;
      }
      attempts = 0; socket.roomConfig = reply; onReady(reply);
    };
    if (socket.legacyRooms) {
      joinLegacyRoom(socket, roomId, userName).then(reply => complete(null, reply), complete);
    } else {
      socket.timeout(10000).emit('join-room', roomId, userName, ...(invite ? [invite] : []), complete);
    }
  };
  const disconnected = () => { generation++; preparing = false; confirming = false; clearTimeout(timer); onWaiting(); };
  socket.on('connect', join); socket.on('disconnect', disconnected);
  if (socket.connected) join();
  return () => { disposed = true; generation++; clearTimeout(timer); socket.off('connect', join); socket.off('disconnect', disconnected); };
}
