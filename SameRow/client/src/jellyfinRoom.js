import { browserId } from './browserId';
import { useEffect, useRef, useState } from 'react';
import { createServerClock } from './playbackSync';

export function jellyfinTime(state, now = performance.now()) {
  if (!state) return 0;
  const elapsed = state.playing ? Math.max(0, (now - state.receivedAt) / 1000) : 0;
  return Math.min(state.duration, Math.max(0, state.timestamp + elapsed));
}

export function useJellyfinRoom(socket, roomId) {
  const [state, setState] = useState(null);
  const current = useRef(null);
  useEffect(() => {
    if (socket.legacyRooms) return;
    let disposed = false;
    let generation = 0;
    const clock = createServerClock();
    let latestRevision = -1;
    const receive = (incoming, revision = incoming?.revision) => {
      if (Number.isFinite(revision)) { if (revision < latestRevision) return; latestRevision = revision; }
      if (disposed) return;
      if (!incoming) { current.current = null; setState(null); return; }
      const previous = current.current;
      if (previous?.sessionId === incoming.sessionId && previous.revision > incoming.revision) return;
      const now = performance.now();
      const offset = clock.offset(now);
      const age = offset === null ? 0 : Math.max(0, Math.min(10, (now + offset - incoming.updatedAt) / 1000));
      const next = { ...incoming, timestamp: Math.min(incoming.duration, incoming.timestamp + (incoming.playing ? age : 0)), receivedAt: now };
      current.current = next; setState(next);
    };
    const sync = () => {
      if (!socket.connected || disposed) return;
      const sent = performance.now();
      const requestGeneration = generation;
      socket.timeout?.(5000).emit('jellyfin-sync-request', roomId, (error, reply) => {
        if (error || disposed || !reply || requestGeneration !== generation) return;
        clock.sample(sent, performance.now(), reply.serverReceivedAt, reply.serverSentAt);
        receive(reply.state, reply.revision ?? reply.state?.revision);
      });
    };
    const pushed = (incoming, metadata) => { generation += 1; receive(incoming, metadata?.revision ?? incoming?.revision); };
    const connected = () => { generation += 1; clock.reset(); setTimeout(sync, 0); };
    socket.on('jellyfin-sync', pushed); socket.on('connect', connected);
    // Room joins in a sibling effect; defer the first snapshot until then.
    const initial = setTimeout(sync, 0);
    const timer = setInterval(sync, 5000);
    const onVisible = () => { if (!document.hidden) sync(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { disposed = true; clearTimeout(initial); clearInterval(timer); socket.off('jellyfin-sync', pushed); socket.off('connect', connected); document.removeEventListener('visibilitychange', onVisible); };
  }, [socket, roomId]);
  const command = (action, time) => {
    if (!socket.connected || !current.current) return;
    socket.emit('jellyfin-command', { roomId, sessionId: current.current.sessionId, action, time, commandId: browserId() });
  };
  const open = details => new Promise((resolve, reject) => {
    if (!socket.connected) { reject(new Error('Wait for the room to reconnect.')); return; }
    if (!socket.timeout) { reject(new Error('Update the room server to enable Jellyfin sharing.')); return; }
    socket.timeout(25000).emit('jellyfin-open', { roomId, ...details }, (error, reply) => {
      if (error) reject(new Error('Jellyfin did not respond. Check the connection and that the room server is up to date.'));
      else if (reply?.error) reject(new Error(reply.error));
      else resolve();
    });
  });
  const base = new URL(socket.roomConfig?.mediaBase || socket.io?.uri || window.location.origin, window.location.origin).origin;
  return { state, command, open, cancel: () => socket.emit('jellyfin-cancel-open', roomId), base };
}
