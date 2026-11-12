import { browserId, randomHex } from './browserId';
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import io from 'socket.io-client';
import Lobby from './Lobby';
import Room from './Room';
import JellyfinPump from './JellyfinPump';
import './App.css';

import { auth, googleProvider } from './firebase';
import { onIdTokenChanged, signInAnonymously, signInWithPopup } from 'firebase/auth';
import { configureSession } from './session';
import { maintainSession } from './sessionRecovery';
import { isLegacyRoomServer, joinLegacyRoom, legacyControlOrigin } from './legacyRooms';

const localEdition = import.meta.env.VITE_SAMEROW_LOCAL_EDITION === 'true';
const SOCKET_URL = localEdition
  ? window.location.origin
  : import.meta.env.VITE_SOCKET_URL || (import.meta.env.DEV ? window.location.origin : legacyControlOrigin);
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

async function connectorRequest(action, body) {
  const response = await fetch(`/api/connector-host/${action}`, {
    method: 'POST',
    headers: { 'X-SameRow-Local-Host': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(action === 'settings' ? 5000 : 75000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Online hosting is unavailable from this address.'), { status: response.status });
  return data;
}
const getConnectorSession = () => connectorRequest('session');

function subscribeToConnection(socket, callback) {
  socket.on('connect', callback);
  socket.on('disconnect', callback);
  return () => { socket.off('connect', callback); socket.off('disconnect', callback); };
}

function generateRoom(socket, privateRoom) {
  if (socket.legacyRooms) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const random = crypto.getRandomValues(new Uint8Array(4));
    return Promise.resolve({ code: Array.from(random, value => alphabet[value % alphabet.length]).join('') });
  }
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit('generate-room', privateRoom, (error, reply) => {
      if (error || !reply?.code) reject(new Error(reply?.error || 'Could not generate a room code.'));
      else resolve(reply);
    });
  });
}

function RoomApp({ socket = defaultSocket, hosted = null }) {
  const [hostedWebOrigin, setHostedWebOrigin] = useState('');
  const [connectorHosting, setConnectorHosting] = useState(false);
  const [roomInvite, setRoomInvite] = useState('');
  const [roomId, setRoomId] = useState(null);
  const [userName, setUserName] = useState('');
  const [user, setUser] = useState(null);
  const [connectionError, setConnectionError] = useState('');
  const subscribe = useCallback(callback => subscribeToConnection(socket, callback), [socket]);
  const serverConnected = useSyncExternalStore(subscribe, () => socket.connected);
  const reserveRoom = useCallback(privateRoom => generateRoom(socket, hosted ? true : privateRoom), [socket, hosted]);
  const [initialRoomFromUrl] = useState(() => hosted ? '' : new URLSearchParams(window.location.search).get('room') || '');

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
    let hostToken = hosted?.token;
    const defaultToken = () => developmentToken || auth.currentUser?.getIdToken() || '';
    if (hosted) configureSession(() => hostToken);
    const stopRecovery = maintainSession({ socket,
      getToken: async () => {
        if (!hosted) return developmentToken || auth.currentUser?.getIdToken(true);
        hostToken = (await getConnectorSession()).token;
        return hostToken;
      },
      onError: setConnectionError,
    });
    const connected = () => setConnectionError('');
    const failed = error => {
      setConnectionError(error.data?.code === 'UNAUTHENTICATED' ? 'Sign in again to connect.' : 'The room server is reconnecting.');
    };
    socket.on('connect', connected); socket.on('connect_error', failed);
    let unsubscribe = () => {};
    if (hosted) {
      socket.auth = { clientId, token: hostToken };
      socket.connect();
    } else if (localEdition) {
      developmentToken ||= localSessionToken();
      socket.auth = { clientId, token: developmentToken };
      socket.connect();
      fetch('/api/config', { signal: AbortSignal.timeout(5000) }).then(response => response.json()).then(config => {
        if (!disposed) {
          setHostedWebOrigin(config.hostedWebOrigin || '');
          setConnectorHosting(config.connectorHosting === true && ['localhost:8080', '127.0.0.1:8080'].includes(window.location.host));
        }
      }).catch(() => {});
    }
    const connectHosted = async () => {
      if (SOCKET_URL === legacyControlOrigin) {
        const config = await fetch(SOCKET_URL + '/api/config', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (config && await isLegacyRoomServer(SOCKET_URL, config)) {
          if (disposed) return;
          socket.legacyRooms = true;
          socket.auth = {};
          unsubscribe = onIdTokenChanged(auth, setUser);
          socket.connect();
          return;
        }
      }
      if (disposed) return;
      unsubscribe = onIdTokenChanged(auth, async currentUser => {
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
    };
    if (!localEdition) void connectHosted();
    return () => {
      disposed = true; stopRecovery(); unsubscribe(); socket.disconnect();
      if (hosted) configureSession(defaultToken);
      socket.off('connect', connected); socket.off('connect_error', failed);
    };
  }, [socket, hosted]);

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

  const joinRoom = async (id, name, generatedInvite) => {
    const linkedInvite = id === initialRoomFromUrl ? new URLSearchParams(window.location.hash.slice(1)).get('invite') : '';
    const invite = generatedInvite || linkedInvite;
    if (socket.legacyRooms && invite) throw new Error('Private rooms need the updated room server.');
    let reply;
    if (socket.legacyRooms) reply = await joinLegacyRoom(socket, id, name);
    else try {
      reply = await socket.timeout(10000).emitWithAck('join-room', id, name, ...(invite ? [invite] : []));
    } catch {
      const config = !hosted && await fetch(`${SOCKET_URL}/api/config`, { signal: AbortSignal.timeout(3000), cache: 'no-store' }).catch(() => null);
      if (config?.status === 404) throw new Error('This room server needs an update before you can join.');
      if (config?.status === 503 || !socket.connected) throw new Error('Lost connection to the room server. Try again when it reconnects.');
      throw new Error('The room server did not confirm your join. Try again.');
    }
    if (!reply?.ok) throw Object.assign(new Error(reply?.error || 'Could not join this room.'), { status: reply?.status });
    socket.roomConfig = reply; setRoomInvite(reply.invite || ''); setRoomId(id); setUserName(name);
  };

  const leaveRoom = () => {
    socket.emit('leave-room', roomId);
    setRoomId(null);
    setUserName('');
    if (hosted) window.location.assign('/');
    else window.location.reload();
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
          connectorHosting={connectorHosting}
          hostedRoom={Boolean(hosted)}
          hostedWebOrigin={hostedWebOrigin}
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
          localEdition={localEdition}
          serverConnected={serverConnected}
        />
      ) : (
        <Room
          roomId={roomId}
          roomInvite={roomInvite}
          inviteOrigin={hosted?.webOrigin}
          jellyfinAddress={hosted?.jellyfinAddress}
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

function ConnectorHostApp() {
  const [connection, setConnection] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(null);
  const [jellyfinUrl, setJellyfinUrl] = useState('');
  const preparedSession = useRef(null);
  useEffect(() => {
    let cancelled = false;
    async function prepare() {
      const id = new URLSearchParams(window.location.hash.slice(1)).get('approved');
      if (id) {
        await connectorRequest('complete', { id });
        window.history.replaceState(null, '', '/?host=online');
      }
      const local = await connectorRequest('settings');
      if (cancelled) return;
      setSettings(local);
      setJellyfinUrl(local.jellyfinUrl || '');
      if (local.paired) {
        const session = getConnectorSession();
        preparedSession.current = { started: Date.now(), session };
        void session.catch(() => {});
        if (id) {
          setBusy(true);
          const hosted = await session;
          if (!cancelled) setConnection({ hosted, socket: createRoomSocket(hosted.controlOrigin) });
        }
      }
    }
    prepare().catch(failure => {
      if (!cancelled) { setError(failure); setBusy(false); }
    });
    return () => { cancelled = true; };
  }, []);

  const start = async event => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const selected = jellyfinUrl.trim();
    try {
      const reconnect = error?.status === 401;
      if (reconnect || !settings.paired || selected !== settings.jellyfinUrl) {
        const { approvalUrl } = await connectorRequest('start', { jellyfinUrl: selected, reconnect });
        if (approvalUrl) { window.location.assign(approvalUrl); return; }
      }
      const prepared = preparedSession.current;
      preparedSession.current = null;
      const hosted = prepared && Date.now() - prepared.started < 90000
        ? await prepared.session : await getConnectorSession();
      setConnection({ hosted, socket: createRoomSocket(hosted.controlOrigin) });
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };
  if (connection) return <RoomApp {...connection} />;
  const needsApproval = !settings?.paired || jellyfinUrl.trim() !== settings.jellyfinUrl || error?.status === 401;
  return <main className="lobby"><section className="lobby-content">
    <h1>Host for friends online</h1>
    {error && <p role="alert">{error.message}</p>}
    {busy && <p role="status">Connecting to SameRow Web. This may take up to a minute if the server was asleep.</p>}
    {settings && <form className="lobby-form" onSubmit={start}>
      <label className="room-field">Jellyfin address<input type="url" value={jellyfinUrl} placeholder="http://your-server:8096" required disabled={busy} onChange={event => setJellyfinUrl(event.target.value)} /></label>
      <button type="submit" className="sr-button sr-button--primary" disabled={busy}>
        {busy ? 'Connecting…' : needsApproval ? 'Connect to SameRow Web' : 'Continue to room'}
      </button>
    </form>}
    {!settings && (error ? <a href={window.location.href}>Try again</a> : <p role="status">Loading your Jellyfin settings…</p>)}
    <p><a href="/">Back to SameRow Local</a></p>
  </section></main>;
}

function ConnectorApproval({ id, returnOrigin }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [account, setAccount] = useState(undefined);
  useEffect(() => onIdTokenChanged(auth, setAccount), []);
  const valid = /^[a-f0-9]{32}$/.test(id) && ['http://localhost:8080', 'http://127.0.0.1:8080'].includes(returnOrigin);
  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      const user = account && !account.isAnonymous ? account : (await signInWithPopup(auth, googleProvider)).user;
      const response = await fetch(`${SOCKET_URL}/api/jellyfin-relay/approval/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SameRow-Token': await user.getIdToken() },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(response.status === 410 || response.status === 409
        ? 'This connection request is no longer available. Start again from SameRow Local.'
        : 'Could not approve this connection. Try again.');
      window.location.assign(`${returnOrigin}/?host=online#approved=${id}`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <main className="lobby"><section className="lobby-content">
    <h1>Connect SameRow Local</h1>
    {valid ? <>
      <p>Approve this request if you just clicked Connect to SameRow Web in your Docker app.</p>
      <button type="button" className="sr-button sr-button--primary" disabled={busy || account === undefined} onClick={approve}>
        {busy ? 'Approving…' : account && !account.isAnonymous ? 'Approve connection' : 'Sign in with Google and approve'}
      </button>
    </> : <p role="alert">Open SameRow Local to start a connection.</p>}
    {error && <p role="alert">{error}</p>}
  </section></main>;
}

export default function App() {
  if (localEdition && new URLSearchParams(window.location.search).get('host') === 'online') return <ConnectorHostApp />;
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (!localEdition && hash.has('connector')) return <ConnectorApproval id={hash.get('connector')} returnOrigin={hash.get('return')} />;
  return <RoomApp />;
}
