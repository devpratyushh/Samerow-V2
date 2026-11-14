import { useEffect, useState } from 'react';
import Dialog from './Dialog';

export default function RoomAdmission({ socket, roomId, isOwner, connected, waiting, preparing, playbackStatus, onLeave }) {
  const [requests, setRequests] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isOwner || !connected) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const reply = await socket.timeout(5000).emitWithAck('room-requests', roomId);
        if (!disposed && reply.requests) setRequests(reply.requests);
      } catch { /* The next poll recovers a dropped response. */ }
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [socket, roomId, isOwner, connected]);
  const answer = async accept => {
    if (busy || !requests[0]) return;
    setBusy(true); setError('');
    try {
      const reply = await socket.timeout(5000).emitWithAck('room-request-answer', roomId, requests[0].id, accept);
      if (!reply.ok) throw new Error(reply.error || 'Could not answer this request.');
      setRequests(previous => previous.filter(request => request.id !== requests[0].id));
    } catch (error) { setError(error.message || 'Try again.'); }
    finally { setBusy(false); }
  };
  return <>
    <Dialog open={!connected && Boolean(waiting)} title="Joining private room" onClose={onLeave}>
      <p role="status">{waiting}</p>
      {!preparing && <p>Your camera and microphone become available once you enter the room.</p>}
      {preparing && playbackStatus?.phase === 'error' && <>
        <p role="alert">Playback couldn’t load. Retry to finish joining.</p>
        <button type="button" className="sr-button sr-button--primary" onClick={playbackStatus.retry}>Retry playback</button>
      </>}
      {preparing && playbackStatus?.phase === 'blocked' && <button type="button" className="sr-button sr-button--primary" onClick={playbackStatus.retry}>Start playback to join</button>}
      <button type="button" className="sr-button" onClick={onLeave}>Cancel and leave</button>
    </Dialog>
    <Dialog open={isOwner && connected && requests.length > 0} title="Someone wants to join" description={`${requests[0]?.name || 'A member'} is waiting to enter your private room.`} onClose={() => answer(false)}>
      {requests.length > 1 && <p>{requests.length} members waiting</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" className="sr-button" disabled={busy} onClick={() => answer(false)}>Decline</button>{' '}
      <button type="button" className="sr-button sr-button--primary" disabled={busy} onClick={() => answer(true)}>Accept</button>
    </Dialog>
  </>;
}
