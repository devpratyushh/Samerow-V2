import { useState, useEffect, useRef } from 'react';
import { FaArrowRight, FaGoogle, FaGithub, FaHistory, FaMicrophone, FaMicrophoneSlash, FaSignOutAlt, FaVideo, FaVideoSlash, FaFilm, FaPlus } from 'react-icons/fa';
import { accountActions } from './firebase';
import { accountAuthError } from './accountAuth';
import { useAccountConnectors } from './useAccountConnectors';
import './Lobby.css';
import ConnectorPairing from './components/ConnectorPairing';
import Dialog from './components/Dialog';
import JellyfinDialog from './components/JellyfinDialog';

const validRoomCode = (value) => /^[a-zA-Z0-9_-]{1,64}$/.test(value);

function readHistory(uid) {
  if (!uid) return [];
  try {
    const stored = JSON.parse(localStorage.getItem(`recent_rooms_${uid}`) || '[]');
    return Array.isArray(stored) ? stored.filter((entry) => validRoomCode(entry?.code) && Number.isFinite(entry?.timestamp)).slice(0, 3) : [];
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

const Lobby = ({ joinRoom, generateRoom, hostedWebOrigin, connectorHosting, hostedRoom, serverUrl, initialRoom, userStream, toggleMute, toggleVideo, isMuted, isVideoOff, streamError, connectionError, authUser, localEdition, serverConnected }) => {
  const identity = authUser?.uid || null;
  const [jellyfinOpen, setJellyfinOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const promptedAccount = useRef('');
  const [generated, setGenerated] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [roomDraft, setRoomDraft] = useState(null);
  const [nameDraft, setNameDraft] = useState({ identity: null, value: '' });
  const [recentRooms, setRecentRooms] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [linkedProviders, setLinkedProviders] = useState(null);
  const connections = useAccountConnectors(serverUrl, !localEdition ? identity : null);
  const connectedServers = connections.connectors;
  const linkedAccounts = connections.accounts || [];
  useEffect(() => {
    if (!identity || localEdition || connections.loading || !connections.accountsKnown || !connectedServers.length || linkedAccounts.length || promptedAccount.current === identity) return;
    const timer = setTimeout(() => { promptedAccount.current = identity; setLinkOpen(true); }, 0);
    return () => clearTimeout(timer);
  }, [identity, localEdition, connections.loading, connections.accountsKnown, connectedServers.length, linkedAccounts.length]);
  const providerIds = linkedProviders?.uid === identity ? linkedProviders.ids : (authUser?.providerData || []).map(provider => provider.providerId);
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

  const handleAuth = async (providerId = 'google.com', link = false) => {
    setAuthBusy(true);
    setFeedback('');
    try {
      const { user } = await accountActions.signIn(providerId, { link });
      setLinkedProviders({ uid: user.uid, ids: user.providerData.map(provider => provider.providerId) });
      if (!link && jellyfinOpen) { setJellyfinOpen(false); setLinkOpen(true); }
      if (link) setFeedback('Sign-in method linked. Both methods now use this SameRow account and its Jellyfin connections.');
    } catch (error) { setFeedback(accountAuthError(error)); }
    finally { setAuthBusy(false); }
  };
  const handleSignOut = async () => {
    setAuthBusy(true); setFeedback('');
    try { await accountActions.signOut(); setJellyfinOpen(false); setLinkOpen(false); }
    catch { setFeedback('Could not sign out. Please try again.'); }
    finally { setAuthBusy(false); }
  };

  const rememberAndJoin = async (code) => {
    if (!serverConnected || joining || !validRoomCode(code) || !trimmedName) return;
    setJoining(true);
    setJoinError('');
    if (authUser) {
      const entries = [{ code, timestamp: Date.now() }, ...history.filter((entry) => entry.code !== code)].slice(0, 3);
      setRecentRooms({ identity, entries });
      try { localStorage.setItem(`recent_rooms_${identity}`, JSON.stringify(entries)); } catch { /* Joining works if browser storage is unavailable. */ }
    }
    try {
      await joinRoom(code, trimmedName, generated?.code === code ? generated.invite : undefined);
    } catch (error) {
      if (hostedRoom && error.status === 403) {
        setGenerated(null);
        setRoomDraft(null);
        setJoinError('That room code expired. Select Host a room to create another.');
      } else {
        setJoinError(error.message || 'Could not join this room. Try again.');
      }
    } finally {
      setJoining(false);
    }
  };

  const makeRoom = async privateRoom => {
    if (generating || joining || !serverConnected) return;
    setGenerating(true);
    setJoinError('');
    setAttempted(false);
    setFeedback('');
    try {
      const next = await generateRoom(privateRoom);
      setGenerated(next);
      setRoomDraft(next.code);
      return true;
    } catch (error) { setFeedback(error.message); return false; }
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
        <section className="lobby-intro" aria-labelledby="lobby-heading"><h1 id="lobby-heading">{hostedRoom ? 'Host for friends online' : 'Your people. Your movie night.'}</h1><p className="lobby-description">{hostedRoom ? 'Enter your private room, then send friends the invite link.' : 'Start a room or enter a code to join a friend.'}</p></section>
        <div className="lobby-setup">
          <section className="lobby-preview-section" aria-labelledby="preview-heading">
            <div className="lobby-section-label"><h2 id="preview-heading">Your preview</h2><span>Only you can see this</span></div>
            <div className={`lobby-preview ${showVideo ? 'has-video' : ''}`}>
              <video ref={videoRef} className="lobby-preview-video" autoPlay playsInline disablePictureInPicture muted aria-label="Your camera preview" hidden={!showVideo} />
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
            <div className="lobby-join-heading"><span className="lobby-eyebrow">GET TOGETHER</span><h2 id="join-heading">Start or join a room</h2></div>
            <form className="lobby-form" onSubmit={handleSubmit} noValidate>
              <div className="lobby-field"><label htmlFor="lobby-name">Your name</label><input ref={nameRef} id="lobby-name" autoComplete="nickname" placeholder="Your name" maxLength={64} value={userName} onChange={(event) => setNameDraft({ identity, value: event.target.value })} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'lobby-name-error' : undefined} required />{nameError && <span className="lobby-field-error" id="lobby-name-error">{nameError}</span>}</div>
              {generateRoom && <><button className="lobby-host-button" type="button" onClick={() => makeRoom(!localEdition || Boolean(hostedRoom))} disabled={!serverConnected || generating || joining}><FaPlus aria-hidden="true" />{generating ? 'Creating room…' : 'Host a room'}</button><div className="lobby-divider"><span>or join with a code</span></div></>}
              <div className="lobby-field"><label htmlFor="lobby-room">Room code</label><input id="lobby-room" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Enter a room code" value={roomId} readOnly={hostedRoom && Boolean(generated)} onChange={(event) => setRoomDraft(event.target.value)} aria-invalid={Boolean(roomError)} aria-describedby={roomError ? 'lobby-room-error' : 'lobby-room-hint'} required />{roomError ? <span className="lobby-field-error" id="lobby-room-error">{roomError}</span> : <span className="lobby-field-hint" id="lobby-room-hint">{generated?.code === trimmedRoom ? 'Your room code is ready. Enter the room, then invite friends.' : 'Enter a code from your friend, or select Host a room.'}</span>}</div>
              <button className="lobby-join-button" type="submit" disabled={!canJoin}>{joining ? 'Joining…' : serverConnected ? 'Enter room' : 'Connecting…'}<FaArrowRight aria-hidden="true" /></button>
              {joinError && <p className="lobby-auth-feedback" role="alert">{joinError}</p>}
              {!serverConnected && <p className="lobby-server-help" role="status">{connectionError || 'Connecting to the room server…'}</p>}
            </form>
            {generated?.invite && generated.code === trimmedRoom && <p>Private room. Invite guests using the link inside the room.</p>}

          </section>
          <aside className="lobby-sidebar" aria-label="Jellyfin and account">
            <section className={`lobby-integration ${connectedServers.length || linkedAccounts.length ? 'is-linked' : ''}`}>
              <span className="lobby-integration-icon"><FaFilm aria-hidden="true" /></span>
              {linkedAccounts.length ? <>
                <span className="lobby-eyebrow">YOUR JELLYFIN</span>
                <h2>Library connected</h2>
                <p>{linkedAccounts.map(account => `${account.userName} · ${account.serverName}`).join(', ')}</p>
                <button className="lobby-jellyfin-button" type="button" onClick={() => setJellyfinOpen(true)}><FaFilm aria-hidden="true" /><span>Manage connections</span><FaArrowRight aria-hidden="true" /></button>
              </> : connectedServers.length ? <>
                <span className="lobby-eyebrow">YOUR JELLYFIN</span>
                <h2>{connectedServers.length === 1 ? 'Server paired' : `${connectedServers.length} servers paired`}</h2>
                <p>{connectedServers.filter(server => server.online).length} online · Connect your Jellyfin user to finish setup</p>
                <button className="lobby-jellyfin-button" type="button" onClick={() => setLinkOpen(true)}><FaFilm aria-hidden="true" /><span>Connect Jellyfin account</span><FaArrowRight aria-hidden="true" /></button>
              </> : connections.loading ? <p role="status">Checking your Jellyfin connections…</p> : <>
                <span className="lobby-eyebrow">BRING YOUR LIBRARY</span>
                <h2>Better together.</h2>
                <p>{connections.error || 'Connect Jellyfin once to your SameRow account, then find your paired server wherever you sign in.'}</p>
                <button className="lobby-jellyfin-button" type="button" onClick={() => authUser && !localEdition && serverUrl != null ? setLinkOpen(true) : setJellyfinOpen(true)}><FaFilm aria-hidden="true" /><span>{connections.error ? 'Manage connections' : 'Connect Jellyfin'}</span><FaArrowRight aria-hidden="true" /></button>
                <small>Plugin, Docker, or your server address</small>
              </>}

            </section>
            <div className="lobby-auth">
              {!localEdition && (authUser ? <div className="lobby-profile">{authUser.photoURL ? <img src={authUser.photoURL} alt="" referrerPolicy="no-referrer" /> : <span className="lobby-profile-avatar" aria-hidden="true">{initials}</span>}<div><strong>{authUser.displayName || 'Signed in'}</strong><span>Recent rooms saved to this browser</span><button className="lobby-account-button" type="button" onClick={() => setJellyfinOpen(true)}>Manage account</button></div><button className="lobby-signout" type="button" onClick={handleSignOut} disabled={authBusy} aria-label="Sign out" title="Sign out"><FaSignOutAlt aria-hidden="true" /></button></div> : <><div className="lobby-divider"><span>or save your recent rooms</span></div><button className="lobby-google-button" type="button" onClick={() => handleAuth('google.com')} disabled={authBusy}><FaGoogle aria-hidden="true" />{authBusy ? 'Opening sign-in…' : 'Continue with Google'}</button><button className="lobby-google-button" type="button" onClick={() => handleAuth('github.com')} disabled={authBusy}><FaGithub aria-hidden="true" />Continue with GitHub</button><p className="lobby-guest-note">No account needed to join.</p></>)}
              {feedback && !jellyfinOpen && <p className="lobby-auth-feedback" role="status">{feedback}</p>}
            </div>
          </aside>
        </div>
            {authUser && history.length > 0 && <section className="lobby-history" aria-labelledby="lobby-history-heading"><h3 id="lobby-history-heading"><FaHistory aria-hidden="true" />Recent rooms</h3><ul>{history.map((entry) => <li key={entry.code}><button type="button" onClick={() => joinRecentRoom(entry.code)} disabled={!serverConnected} title={`Join ${entry.code}`}><span className="lobby-history-code">{entry.code}</span><span className="lobby-history-time">{timeAgo(entry.timestamp, now)}</span><FaArrowRight aria-hidden="true" /></button></li>)}</ul></section>}
      </div>
      <Dialog open={jellyfinOpen} title={authUser ? "Your account & Jellyfin" : "Connect Jellyfin"} description={authUser ? "Manage sign-in methods and your connected servers." : "Bring your movie library to SameRow."} onClose={() => { setJellyfinOpen(false); setFeedback(''); }}>
        <div className="lobby-jellyfin-dialog">
          {!localEdition && authUser && <section aria-label="Account sign-in methods">
            <h3>Sign-in methods</h3><p>{authUser.email || authUser.displayName || 'Your SameRow account'} · Jellyfin servers stay with this account when you link another sign-in method.</p>
            {[['google.com', 'Google'], ['github.com', 'GitHub']].map(([id, name]) => <button key={id} className="lobby-google-button" type="button" disabled={authBusy || providerIds.includes(id)} onClick={() => handleAuth(id, true)}>{id === 'google.com' ? <FaGoogle aria-hidden="true" /> : <FaGithub aria-hidden="true" />}{providerIds.includes(id) ? `${name} linked` : `Link ${name}`}</button>)}
          </section>}

          {authUser && !localEdition && <section aria-label="Linked Jellyfin accounts"><h3>Jellyfin accounts</h3>
            {linkedAccounts.length ? linkedAccounts.map(account => <p key={`${account.serverUrl}:${account.userId}`}><strong>{account.serverName}</strong> · {account.userName}</p>) : <p>A paired server still needs your Jellyfin user sign-in.</p>}
            <button className="sr-button" onClick={() => { setJellyfinOpen(false); setLinkOpen(true); }}>Connect Jellyfin account</button>
          </section>}
          <p>Start a room, then choose <strong>Share something → Your Jellyfin library</strong> to sign in with your server address.</p>
          {!localEdition && !authUser && <><p>For a paired plugin or Docker connector, sign in to your SameRow account first.</p><button className="sr-button" onClick={() => handleAuth('google.com')} disabled={authBusy}><FaGoogle /> Continue with Google</button><button className="sr-button" onClick={() => handleAuth('github.com')} disabled={authBusy}><FaGithub /> Continue with GitHub</button></>}
          {!localEdition && authUser && serverUrl != null && <ConnectorPairing key={identity} serverUrl={serverUrl} onPrivateRoom={async () => { if (await makeRoom(true)) setJellyfinOpen(false); }} disabled={!serverConnected || generating} />}
          <a href="https://github.com/devpratyushh/Samerow-V2/tree/main/jellyfin-plugin-samerow" target="_blank" rel="noreferrer">Set up the Jellyfin plugin ↗</a>
            {connectorHosting && <a className="sr-button" href="/?host=online">Host for friends online</a>}
            {hostedRoom && <a href="/">Back to SameRow Local</a>}
            {!connectorHosting && hostedWebOrigin && <a href={hostedWebOrigin} target="_blank" rel="noreferrer">Share to SameRow Web</a>}


          {feedback && <p role="status">{feedback}</p>}
        </div>
      </Dialog>
      {authUser && !localEdition && serverUrl != null && <JellyfinDialog key={identity} open={linkOpen} onClose={() => { promptedAccount.current = identity; setLinkOpen(false); }} base={serverUrl} connectOnly onPairServer={() => { setLinkOpen(false); setJellyfinOpen(true); }} sameRowAccount={authUser.email || authUser.displayName} />}
    </main>
  );
};

export default Lobby;
