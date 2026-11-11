import { browserId, randomHex } from './browserId';
import { useState, useEffect, useSyncExternalStore } from 'react';
import io from 'socket.io-client';
import Lobby from './Lobby';
import Room from './Room';
import JellyfinPump from './JellyfinPump';
import './App.css';

import { auth } from './firebase';
import { onIdTokenChanged, signInAnonymously } from 'firebase/auth';
import { configureSession } from './session';
import { maintainSession } from './sessionRecovery';

const localEdition = import.meta.env.VITE_SAMEROW_LOCAL_EDITION === 'true';
const SOCKET_URL = localEdition
  ? window.location.origin
  : import.meta.env.VITE_SOCKET_URL || (import.meta.env.DEV ? window.location.origin : 'https://samerow-v2.onrender.com');
const clientId = browserId();

function localSessionToken() {
  const key = 'samerow.local.session';
  try {
    const saved = localStorage.getItem(key);
    if (/^[a-f0-9]{64}$/.test(saved || '')) return saved;
    const token = randomHex(32);
    localStorage.setItem(key, token);
    return token;
  } catch {
    return randomHex(32);
  }
}
let developmentToken = '';
configureSession(() => developmentToken || auth.currentUser?.getIdToken() || '');

const socket = io(SOCKET_URL, {
  transports: ['websocket'],
  autoConnect: false,
  auth: async callback => callback({ clientId, token: developmentToken || await auth.currentUser?.getIdToken() }),
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  randomizationFactor: 0.5,
  reconnectionDelayMax: 15000,
  timeout: 15000
});

socket.clientId = clientId;

socket.on('connect_error', (err) => {
  console.error("Socket Connection Error:", err.message);
});

function subscribeToConnection(callback) {
  socket.on('connect', callback);
  socket.on('disconnect', callback);
  return () => { socket.off('connect', callback); socket.off('disconnect', callback); };
}

function App() {
  const [hostedWebOrigin, setHostedWebOrigin] = useState('');
  const [roomInvite, setRoomInvite] = useState('');
  const [roomId, setRoomId] = useState(null);
  const [userName, setUserName] = useState('');
  const [user, setUser] = useState(null);
  const [connectionError, setConnectionError] = useState('');
  const serverConnected = useSyncExternalStore(subscribeToConnection, () => socket.connected);
  const [initialRoomFromUrl] = useState(() => new URLSearchParams(window.location.search).get('room') || '');

  // Media State
  const [userStream, setUserStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false); // Start unmuted
  const [isVideoOff, setIsVideoOff] = useState(false); // Start with video
  const [streamError, setStreamError] = useState(null);

  useEffect(() => {
    let disposed = false, signingIn = false;
    const connectDevelopmentGuest = async () => {
      // Local development must work without enabling a Firebase guest provider.
      // Production bundles and Firebase-mode servers never accept this fallback.
      if (!import.meta.env.DEV) return false;
      try {
        const response = await fetch(`${SOCKET_URL}/api/config`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok || (await response.json()).auth !== 'development' || disposed || auth.currentUser) return false;
        let uid = sessionStorage.getItem('samerow.development.uid');
        if (!uid) { uid = browserId(); sessionStorage.setItem('samerow.development.uid', uid); }
        developmentToken = `dev:${uid}`;
        socket.auth = { clientId, token: developmentToken }; socket.sessionUid = uid;
        setUser({ uid, isAnonymous: true }); setConnectionError(''); socket.connect();
        return true;
      } catch { return false; }
    };
    const stopRecovery = maintainSession({ socket,
      getToken: () => developmentToken || auth.currentUser?.getIdToken(true), onError: setConnectionError,
    });
    const connected = () => setConnectionError('');
    const failed = error => {
      setConnectionError(error.data?.code === 'UNAUTHENTICATED' ? 'Sign in again to connect.' : 'The room server is reconnecting.');
    };
    socket.on('connect', connected); socket.on('connect_error', failed);
    let unsubscribe = () => {};
    if (localEdition) {
      developmentToken ||= localSessionToken();
      socket.auth = { clientId, token: developmentToken };
      socket.connect();
      fetch('/api/config', { signal: AbortSignal.timeout(5000) }).then(response => response.json()).then(config => {
        if (!disposed) setHostedWebOrigin(config.hostedWebOrigin || '');
      }).catch(() => {});
    } else unsubscribe = onIdTokenChanged(auth, async currentUser => {
      if (disposed) return;
      if (!currentUser) {
        socket.disconnect(); setUser(null);
        if (!signingIn) {
          signingIn = true;
          try { if (!await connectDevelopmentGuest()) await signInAnonymously(auth); }
          catch { if (!await connectDevelopmentGuest() && !disposed) setConnectionError('Guest sign-in is unavailable. Sign in with Google to join.'); }
          finally { signingIn = false; }
        }
        return;
      }
      setUser(currentUser);
      developmentToken = '';
      if (currentUser.displayName) setUserName(currentUser.displayName);
      try {
        const token = await currentUser.getIdToken();
        if (disposed || auth.currentUser?.uid !== currentUser.uid) return;
        const previousUid = socket.sessionUid;
        socket.auth = { clientId, token }; socket.sessionUid = currentUser.uid;
        if (previousUid && previousUid !== currentUser.uid) socket.disconnect();
        if (socket.connected) socket.emit('auth-refresh', token);
        else socket.connect();
      } catch { setConnectionError('Could not verify your sign-in. Try again.'); }
    });
    return () => {
      disposed = true; stopRecovery(); unsubscribe(); socket.disconnect();
      socket.off('connect', connected); socket.off('connect_error', failed);
    };
  }, []);

  useEffect(() => {
    // Acquire stream immediately on load
    let cancelled = false;
    let acquiredStream;
    const getMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 360 },
            frameRate: { ideal: 20, max: 24 }
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

  const generateRoom = privateRoom => new Promise((resolve, reject) => {
    socket.timeout(10000).emit('generate-room', privateRoom, (error, reply) => {
      if (error || !reply?.code) reject(new Error(reply?.error || 'Could not generate a room code.'));
      else resolve(reply);
    });
  });

  const joinRoom = async (id, name, generatedInvite) => {
    const linkedInvite = id === initialRoomFromUrl ? new URLSearchParams(window.location.hash.slice(1)).get('invite') : '';
    const invite = generatedInvite || linkedInvite;
    const reply = await new Promise((resolve, reject) => socket.timeout(10000).emit('join-room', id, name, ...(invite ? [invite] : []), (error, result) => error ? reject(new Error('The room did not respond. Try again.')) : resolve(result)));
    if (!reply?.ok) throw new Error(reply?.error || 'Could not join this room.');
    socket.roomConfig = reply; setRoomInvite(reply.invite || ''); setRoomId(id); setUserName(name);
  };

  const leaveRoom = () => {
    socket.emit('leave-room', roomId);
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
          generateRoom={generateRoom}
          hostedWebOrigin={hostedWebOrigin}
          serverUrl={SOCKET_URL}
          initialRoom={initialRoomFromUrl}
          userStream={userStream}
          toggleMute={toggleMute}
          toggleVideo={toggleVideo}
          isMuted={isMuted}
          isVideoOff={isVideoOff}
          streamError={connectionError || streamError}
          authUser={user?.isAnonymous ? null : user}
          localEdition={localEdition}
          serverConnected={serverConnected}
        />
      ) : (
        <Room
          roomId={roomId}
          roomInvite={roomInvite}
          userName={userName}
          socket={socket}
          leaveRoom={leaveRoom}
          userStream={userStream} // Pass established stream
          initialMuted={isMuted}
          initialVideoOff={isVideoOff}
        />
      )}
    </>
  );
}

export default App;
