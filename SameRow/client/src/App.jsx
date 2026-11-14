import { browserId } from './browserId';
import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import io from 'socket.io-client';
import Lobby from './Lobby';
import PluginAccountBinding from './PluginAccountBinding';
import Room from './Room';
import JellyfinPump from './JellyfinPump';
import './App.css';

import { auth, accountActions } from './firebase';
import { accountAuthError } from './accountAuth';
import { onIdTokenChanged } from 'firebase/auth';
import { configureSession } from './session';
import { maintainSession } from './sessionRecovery';
import { legacyControlOrigin } from './legacyRooms';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || (import.meta.env.DEV ? window.location.origin : legacyControlOrigin);
const clientId = browserId();

configureSession(forceRefresh => auth.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.getIdToken(forceRefresh) : '');

function createRoomSocket(origin) {
  const socket = io(origin, {
    transports: ['websocket'],
    autoConnect: false,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    randomizationFactor: 0.5,
    reconnectionDelayMax: 15000,
    timeout: 15000
  });
  socket.clientId = clientId;
  socket.on('connect_error', error => console.error('Room connection:', error.message));
  return socket;
}

const defaultSocket = createRoomSocket(SOCKET_URL);

function subscribeToConnection(socket, callback) {
  socket.on('connect', callback);
  socket.on('disconnect', callback);
  return () => { socket.off('connect', callback); socket.off('disconnect', callback); };
}

function generateRoom(socket, privateRoom) {
  if (socket.legacyRooms) return Promise.reject(new Error('Update the room server to create private rooms.'));
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit('generate-room', privateRoom, (error, reply) => {
      if (error || !reply?.code) reject(new Error(reply?.error || 'Could not generate a room code.'));
      else resolve(reply);
    });
  });
}

function RoomApp({ socket = defaultSocket }) {
  const [roomInvite, setRoomInvite] = useState('');
  const [roomId, setRoomId] = useState(null);
  const [userName, setUserName] = useState('');
  const [user, setUser] = useState(null);
  const [connectionError, setConnectionError] = useState('');
  const subscribe = useCallback(callback => subscribeToConnection(socket, callback), [socket]);
  const serverConnected = useSyncExternalStore(subscribe, () => socket.connected);
  const reserveRoom = useCallback(() => generateRoom(socket, true), [socket]);
  const [initialRoomFromUrl] = useState(() => new URLSearchParams(window.location.search).get('room') || '');

  // Media State
  const [userStream, setUserStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false); // Start unmuted
  const [isVideoOff, setIsVideoOff] = useState(false); // Start with video
  const [streamError, setStreamError] = useState(null);

  useEffect(() => {
    let disposed = false, stopRecovery = () => {};
    const connected = () => setConnectionError('');
    const failed = error => {
      setConnectionError(error.data?.code === 'UNAUTHENTICATED' ? 'Sign in again to connect.' : 'The room server is reconnecting.');
    };
    socket.on('connect', connected); socket.on('connect_error', failed);
    let unsubscribe = () => {};
    const connectHosted = async () => {
      if (disposed) return;
      unsubscribe = onIdTokenChanged(auth, async currentUser => {
        if (disposed) return;
        stopRecovery();
        if (!currentUser || currentUser.isAnonymous) {
          socket.disconnect(); socket.auth = {}; delete socket.sessionUid;
          setUser(null); setRoomId(null); setRoomInvite('');
          setConnectionError('Sign in with Google or GitHub to host or join a room.');
          return;
        }
        setUser(currentUser);
        setConnectionError('');
        stopRecovery = maintainSession({ socket, getToken: async () => {
          const account = auth.currentUser;
          return account && !account.isAnonymous ? account.getIdToken(true) : '';
        }, onError: setConnectionError });
        if (currentUser.displayName) setUserName(currentUser.displayName);
        try {
          const token = await currentUser.getIdToken();
          if (disposed || auth.currentUser?.uid !== currentUser.uid) return;
          const previousUid = socket.sessionUid;
          socket.auth = { clientId, token, prepareJellyfin: true }; socket.sessionUid = currentUser.uid;
          if (previousUid && previousUid !== currentUser.uid) socket.disconnect();
          if (socket.connected) socket.emit('auth-refresh', token);
          else socket.connect();
        } catch { setConnectionError('Could not verify your sign-in. Try again.'); }
      });
    };
    void connectHosted();
    return () => {
      disposed = true; stopRecovery(); unsubscribe(); socket.disconnect();
      socket.off('connect', connected); socket.off('connect_error', failed);
    };
  }, [socket]);

  useEffect(() => {
    // Acquire stream immediately on load
    let cancelled = false;
    let acquiredStream;
    const getMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30, max: 30 }
          },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        acquiredStream = stream;
        if (cancelled) stream.getTracks().forEach(track => track.stop());
        else setUserStream(stream);
      } catch (err) {
        console.error("Media Error:", err);
        setStreamError("Camera/Mic not found or denied. You can still join.");
        // If denied, we will generate a dummy stream later in joinRoom handled by Room or here? 
        // Better to handle in logic: If userStream is null when joining, create dummy.
      }
    };
    getMedia();
    return () => { cancelled = true; acquiredStream?.getTracks().forEach(track => track.stop()); };
  }, []);

  const toggleMute = () => {
    setIsMuted(prev => {
      const newState = !prev;
      if (userStream) userStream.getAudioTracks().forEach(t => t.enabled = !newState);
      return newState;
    });
  };

  const toggleVideo = () => {
    setIsVideoOff(prev => {
      const newState = !prev;
      if (userStream) userStream.getVideoTracks().forEach(t => t.enabled = !newState);
      return newState;
    });
  };

  const joinRoom = async (id, name, generatedInvite) => {
    const linkedInvite = id === initialRoomFromUrl ? new URLSearchParams(window.location.hash.slice(1)).get('invite') : '';
    const invite = generatedInvite || linkedInvite;
    if (socket.legacyRooms) throw new Error('Update the room server to use private rooms with host approval.');
    let reply;
    try {
      reply = await socket.timeout(10000).emitWithAck('join-room', id, name, ...(invite ? [invite] : []));
    } catch {
      const config = await fetch(`${SOCKET_URL}/api/config`, { signal: AbortSignal.timeout(3000), cache: 'no-store' }).catch(() => null);
      if (config?.status === 404) throw new Error('This room server needs an update before you can join.');
      if (config?.status === 503 || !socket.connected) throw new Error('Lost connection to the room server. Try again when it reconnects.');
      throw new Error('The room server did not confirm your join. Try again.');
    }
    if (!reply?.ok && !reply?.pending && !reply?.preparing) throw Object.assign(new Error(reply?.error || 'Could not join this room.'), { status: reply?.status });
    Object.assign(socket, { roomConfig: reply });
    setRoomInvite(reply.invite || ''); setRoomId(id); setUserName(name);
  };

  const createPrivateRoom = async () => {
    const next = await reserveRoom(true);
    const url = new URL('/', window.location.origin);
    url.searchParams.set('room', next.code);
    url.hash = new URLSearchParams({ invite: next.invite }).toString();
    window.location.assign(url.href);
  };

  const leaveRoom = async () => {
    if (socket.connected) await socket.timeout(2000).emitWithAck('leave-room', roomId).catch(() => {});
    setRoomId(null);
    setUserName('');
    window.location.reload();
  };

  // Check if we want to run the test pump route
  if (import.meta.env.DEV && window.location.pathname === '/test-pump') {
    return <JellyfinPump />;
  }

  return (
    <>
      {!roomId ? (
        <Lobby
          joinRoom={joinRoom}
          generateRoom={reserveRoom}
          serverUrl={socket.legacyRooms ? undefined : SOCKET_URL}
          initialRoom={initialRoomFromUrl}
          userStream={userStream}
          toggleMute={toggleMute}
          toggleVideo={toggleVideo}
          isMuted={isMuted}
          isVideoOff={isVideoOff}
          streamError={streamError}
          connectionError={connectionError}
          authUser={user?.isAnonymous ? null : user}
          serverConnected={serverConnected}
        />
      ) : (
        <Room
          roomId={roomId}
          roomInvite={roomInvite}
          userName={userName}
          socket={socket}
          leaveRoom={leaveRoom}
          onCreatePrivateRoom={createPrivateRoom}
          userStream={userStream} // Pass established stream
          initialMuted={isMuted}
          initialVideoOff={isVideoOff}
        />
      )}
    </>
  );
}

function ConnectorApproval({ id }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [approved, setApproved] = useState(false);
  const [account, setAccount] = useState(undefined);
  useEffect(() => onIdTokenChanged(auth, setAccount), []);
  const valid = /^[a-f0-9]{32}$/.test(id);
  const approve = async (providerId = 'google.com') => {
    setBusy(true);
    setError('');
    try {
      const user = account && !account.isAnonymous ? account : (await accountActions.signIn(providerId)).user;
      const response = await fetch(`${SOCKET_URL}/api/jellyfin-relay/approval/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SameRow-Token': await user.getIdToken() },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(response.status === 410 || response.status === 409
        ? 'This connection request is no longer available. Start again from your Jellyfin server.'
        : 'Could not approve this connection. Try again.');
      setApproved(true);
    } catch (failure) { setError(failure.code?.startsWith('auth/') ? accountAuthError(failure) : failure.message); }
    finally { setBusy(false); }
  };
  return <main className="lobby"><section className="lobby-content">
    <h1>Connect SameRow</h1>
    {approved ? <>
      <p role="status">Connection approved.</p>
      <p>Return to the SameRow Connect settings in Jellyfin and wait for Connected. Then open the SameRow lobby to create a private room.</p>
      <a href="/" className="sr-button sr-button--primary">Go to SameRow Lobby</a>
    </> : valid ? <>
      <p>Approve this request to connect your Jellyfin server to your SameRow account.</p>
      <button type="button" className="sr-button sr-button--primary" disabled={busy || account === undefined} onClick={() => approve()}>
        {busy ? 'Approving…' : account && !account.isAnonymous ? 'Approve connection' : 'Sign in with Google and approve'}
      </button>
      {account !== undefined && (!account || account.isAnonymous) && <button type="button" className="sr-button" disabled={busy} onClick={() => approve('github.com')}>Sign in with GitHub and approve</button>}
    </> : <p role="alert">Invalid connection approval link.</p>}
    {error && <p role="alert">{error}</p>}
  </section></main>;
}

export default function App() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (/^[a-f0-9]{32}$/.test(hash.get('bind') || '')) return <PluginAccountBinding id={hash.get('bind')} base={SOCKET_URL} />;
  if (hash.has('connector')) return <ConnectorApproval id={hash.get('connector')} />;
  return <RoomApp />;
}
