export const legacyControlOrigin = 'https://samerow-v2.onrender.com';

export async function isLegacyRoomServer(origin, configResponse, request = fetch, options = {}) {
  if (origin !== legacyControlOrigin || configResponse.status !== 404) return false;
  const browserOrigin = options.headers?.Origin;
  const allowsBrowser = response => !browserOrigin ||
    ['*', browserOrigin].includes(response.headers.get('access-control-allow-origin'));
  if (!allowsBrowser(configResponse)) return false;
  try {
    const response = await request(origin + '/api/status', {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000), ...options,
    });
    return response.ok && allowsBrowser(response) && (await response.json()).message === 'Server is running';
  } catch { return false; }
}

export function joinLegacyRoom(socket, roomId, userName) {
  return new Promise((resolve, reject) => {
    const fail = () => {
      cleanup();
      reject(new Error('The room server did not confirm your join. Try again.'));
    };
    const confirmed = state => {
      if (typeof state?.sessionId !== 'string' || !Number.isFinite(state.timestamp) || typeof state.isPlaying !== 'boolean') return;
      cleanup();
      resolve({ ok: true, mediaMode: 'mesh' });
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('youtube-sync', confirmed);
      socket.off('disconnect', fail);
    };
    const timer = setTimeout(fail, 10000);
    socket.on('youtube-sync', confirmed);
    socket.on('disconnect', fail);
    socket.emit('join-room', roomId, userName);
    // This server only returns playback state to sockets that joined the room.
    socket.emit('sync-request', roomId);
  });
}
