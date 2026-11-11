import { useState, useEffect, useRef } from 'react';
import { FaArrowRight, FaGoogle, FaHistory, FaMicrophone, FaMicrophoneSlash, FaSignOutAlt, FaVideo, FaVideoSlash } from 'react-icons/fa';
import { signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleProvider } from './firebase';
import './Lobby.css';
import ConnectorPairing from './components/ConnectorPairing';

const validRoomCode = (value) => /^[a-zA-Z0-9_-]{1,64}$/.test(value);

function readHistory(uid) {
  if (!uid) return [];
  try {
    const stored = JSON.parse(localStorage.getItem(`recent_rooms_${uid}`) || '[]');
    return Array.isArray(stored) ? stored.filter((entry) => validRoomCode(entry?.code) && Number.isFinite(entry?.timestamp)).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function timeAgo(timestamp, now) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

const Lobby = ({ joinRoom, generateRoom, hostedWebOrigin, serverUrl, initialRoom, userStream, toggleMute, toggleVideo, isMuted, isVideoOff, streamError, connectionError, authUser, localEdition, serverConnected }) => {
  const identity = authUser?.uid || null;
  const [generated, setGenerated] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [roomDraft, setRoomDraft] = useState(null);
  const [nameDraft, setNameDraft] = useState({ identity: null, value: '' });
  const [recentRooms, setRecentRooms] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [now] = useState(() => Date.now());
  const videoRef = useRef(null);
  const nameRef = useRef(null);

  const roomId = roomDraft ?? initialRoom ?? '';
  const userName = nameDraft.identity === identity ? nameDraft.value : (authUser?.displayName || '');
  const history = recentRooms?.identity === identity ? recentRooms.entries : readHistory(identity);
  const trimmedRoom = roomId.trim();
  const trimmedName = userName.trim();
  const roomError = trimmedRoom && !validRoomCode(trimmedRoom) ? 'Use 1–64 letters, numbers, hyphens or underscores.' : attempted && !trimmedRoom ? 'Enter a room code to continue.' : '';
  const nameError = attempted && !trimmedName ? 'Enter the name others will see.' : '';
  const hasAudio = Boolean(userStream?.getAudioTracks().some((track) => track.readyState === 'live'));
  const hasVideo = Boolean(userStream?.getVideoTracks().some((track) => track.readyState === 'live'));
  const showVideo = hasVideo && !isVideoOff;
  const initials = trimmedName ? trimmedName.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase() : 'YOU';
  const canJoin = serverConnected && !joining && validRoomCode(trimmedRoom) && Boolean(trimmedName);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.srcObject = userStream || null;
    return () => { if (video) video.srcObject = null; };
  }, [userStream]);

  useEffect(() => {
    if (!serverConnected || !generateRoom || initialRoom || roomDraft !== null || generating) return;
    let cancelled = false;
    generateRoom(false).then(({ code }) => {
      if (!cancelled) setRoomDraft(current => current ?? code);
    }).catch(() => {
      // The user can still type a code or request another from the lobby.
    });
    return () => { cancelled = true; };
  }, [generateRoom, generating, initialRoom, roomDraft, serverConnected]);

  const handleAuth = async () => {
    setAuthBusy(true);
    setFeedback('');
    try {
      if (authUser) await signOut(auth);
      else await signInWithPopup(auth, googleProvider);
    } catch (error) {
      if (error.code === 'auth/popup-closed-by-user') setFeedback('Sign-in closed. You can try again or join as a guest.');
      else if (error.code === 'auth/popup-blocked') setFeedback('Allow the sign-in popup, then try again. You can also join as a guest.');
      else setFeedback(authUser ? 'Could not sign out. Please try again.' : 'Could not sign in. Please try again or join as a guest.');
    } finally { setAuthBusy(false); }
  };

  const rememberAndJoin = async (code) => {
    if (!serverConnected || joining || !validRoomCode(code) || !trimmedName) return;
    setJoining(true);
    setJoinError('');
    if (authUser) {
      const entries = [{ code, timestamp: Date.now() }, ...history.filter((entry) => entry.code !== code)].slice(0, 5);
      setRecentRooms({ identity, entries });
      try { localStorage.setItem(`recent_rooms_${identity}`, JSON.stringify(entries)); } catch { /* Joining works if browser storage is unavailable. */ }
    }
    try {
      await joinRoom(code, trimmedName, generated?.code === code ? generated.invite : undefined);
    } catch (error) {
      setJoinError(error.message || 'Could not join this room. Try again.');
    } finally {
      setJoining(false);
    }
  };

  const makeRoom = async privateRoom => {
    setGenerating(true);
    setFeedback('');
    try {
      const next = await generateRoom(privateRoom);
      setGenerated(next);
      setRoomDraft(next.code);
    } catch (error) { setFeedback(error.message); }
    finally { setGenerating(false); }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    setAttempted(true);
    if (!trimmedName) nameRef.current?.focus();
    rememberAndJoin(trimmedRoom);
  };

  const joinRecentRoom = (code) => {
    setRoomDraft(code);
    setAttempted(true);
    if (!trimmedName) nameRef.current?.focus();
    rememberAndJoin(code);
  };

  return (
    <main className="lobby">
      <header className="lobby-header">
        <a className="lobby-brand" href="/" aria-label="SameRow home">SameRow</a>
        <span className={`lobby-connection ${serverConnected ? 'is-connected' : ''}`} role="status"><span aria-hidden="true" />{serverConnected ? 'Ready to connect' : 'Connecting to server'}</span>
      </header>
      <div className="lobby-content">
        <section className="lobby-intro" aria-labelledby="lobby-heading"><h1 id="lobby-heading">Join a room</h1><p className="lobby-description">Check your camera, then enter a room code to join or create a room.</p></section>
        <div className="lobby-setup">
          <section className="lobby-preview-section" aria-labelledby="preview-heading">
            <div className="lobby-section-label"><h2 id="preview-heading">Your preview</h2><span>Only you can see this</span></div>
            <div className={`lobby-preview ${showVideo ? 'has-video' : ''}`}>
              <video ref={videoRef} className="lobby-preview-video" autoPlay playsInline muted aria-label="Your camera preview" hidden={!showVideo} />
              {!showVideo && <div className="lobby-preview-placeholder"><div className="lobby-avatar" aria-hidden="true">{initials}</div><span>{hasVideo ? 'Camera is off' : streamError ? 'Join with your camera off' : 'Getting your camera ready…'}</span></div>}
              <div className="lobby-preview-topline"><span className="lobby-preview-tag">{trimmedName || 'You'}</span><span className="lobby-preview-tag">Preview</span></div>
              <div className="lobby-device-controls" aria-label="Preview controls">
                <button className={`lobby-device-button ${isMuted || !hasAudio ? 'is-off' : ''}`} type="button" onClick={toggleMute} disabled={!hasAudio} aria-pressed={isMuted || !hasAudio} aria-label={!hasAudio ? 'Microphone unavailable' : isMuted ? 'Turn microphone on' : 'Turn microphone off'} title={!hasAudio ? 'Microphone unavailable' : isMuted ? 'Turn microphone on' : 'Turn microphone off'}>{isMuted || !hasAudio ? <FaMicrophoneSlash aria-hidden="true" /> : <FaMicrophone aria-hidden="true" />}<span>{isMuted || !hasAudio ? 'Mic off' : 'Mic on'}</span></button>
                <button className={`lobby-device-button ${isVideoOff || !hasVideo ? 'is-off' : ''}`} type="button" onClick={toggleVideo} disabled={!hasVideo} aria-pressed={isVideoOff || !hasVideo} aria-label={!hasVideo ? 'Camera unavailable' : isVideoOff ? 'Turn camera on' : 'Turn camera off'} title={!hasVideo ? 'Camera unavailable' : isVideoOff ? 'Turn camera on' : 'Turn camera off'}>{isVideoOff || !hasVideo ? <FaVideoSlash aria-hidden="true" /> : <FaVideo aria-hidden="true" />}<span>{isVideoOff || !hasVideo ? 'Camera off' : 'Camera on'}</span></button>
              </div>
            </div>
            <p className={`lobby-preview-help ${streamError ? 'has-error' : ''}`} role={streamError ? 'status' : undefined}>{streamError || 'You can change these settings after joining.'}</p>
          </section>
          <section className="lobby-join-card" aria-labelledby="join-heading">
            <div className="lobby-join-heading"><h2 id="join-heading">Room details</h2></div>
            <form className="lobby-form" onSubmit={handleSubmit} noValidate>
              <div className="lobby-field"><label htmlFor="lobby-name">Your name</label><input ref={nameRef} id="lobby-name" autoComplete="nickname" placeholder="Your name" maxLength={64} value={userName} onChange={(event) => setNameDraft({ identity, value: event.target.value })} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'lobby-name-error' : undefined} required />{nameError && <span className="lobby-field-error" id="lobby-name-error">{nameError}</span>}</div>
              <div className="lobby-field"><label htmlFor="lobby-room">Room code</label><input id="lobby-room" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="e.g. friday-movie" value={roomId} onChange={(event) => setRoomDraft(event.target.value)} aria-invalid={Boolean(roomError)} aria-describedby={roomError ? 'lobby-room-error' : 'lobby-room-hint'} required />{roomError ? <span className="lobby-field-error" id="lobby-room-error">{roomError}</span> : <span className="lobby-field-hint" id="lobby-room-hint">Use the same code as your friends.</span>}</div>
              {generateRoom && <button className="sr-button" type="button" disabled={!serverConnected || generating} onClick={() => makeRoom(false)}>Generate room code</button>}
              <button className="lobby-join-button" type="submit" disabled={!canJoin}>{joining ? 'Joining…' : serverConnected ? 'Enter room' : 'Connecting…'}<FaArrowRight aria-hidden="true" /></button>
              {joinError && <p className="lobby-auth-feedback" role="alert">{joinError}</p>}
              {!serverConnected && <p className="lobby-server-help" role="status">{connectionError || 'Connecting to the room server…'}</p>}
            </form>
            {hostedWebOrigin && <a href={hostedWebOrigin} target="_blank" rel="noreferrer">Share to SameRow Web</a>}
            {!localEdition && authUser && serverUrl && <ConnectorPairing serverUrl={serverUrl} onPrivateRoom={() => makeRoom(true)} disabled={!serverConnected || generating} />}
            {generated?.invite && generated.code === trimmedRoom && <p>Private room. Invite guests using the link inside the room.</p>}
            <div className="lobby-auth">
              {!localEdition && (authUser ? <div className="lobby-profile">{authUser.photoURL ? <img src={authUser.photoURL} alt="" referrerPolicy="no-referrer" /> : <span className="lobby-profile-avatar" aria-hidden="true">{initials}</span>}<div><strong>{authUser.displayName || 'Signed in'}</strong><span>Recent rooms saved to this browser</span></div><button className="lobby-signout" type="button" onClick={handleAuth} disabled={authBusy} aria-label="Sign out" title="Sign out"><FaSignOutAlt aria-hidden="true" /></button></div> : <><div className="lobby-divider"><span>or save your recent rooms</span></div><button className="lobby-google-button" type="button" onClick={handleAuth} disabled={authBusy}><FaGoogle aria-hidden="true" />{authBusy ? 'Opening sign-in…' : 'Continue with Google'}</button><p className="lobby-guest-note">No account needed to join.</p></>)}
              {feedback && <p className="lobby-auth-feedback" role="status">{feedback}</p>}
            </div>
            {authUser && history.length > 0 && <section className="lobby-history" aria-labelledby="lobby-history-heading"><h3 id="lobby-history-heading"><FaHistory aria-hidden="true" />Recent rooms</h3><ul>{history.map((entry) => <li key={entry.code}><button type="button" onClick={() => joinRecentRoom(entry.code)} disabled={!serverConnected} title={`Join ${entry.code}`}><span className="lobby-history-code">{entry.code}</span><span className="lobby-history-time">{timeAgo(entry.timestamp, now)}</span><FaArrowRight aria-hidden="true" /></button></li>)}</ul></section>}
          </section>
        </div>
      </div>
          </main>
  );
};

export default Lobby;
