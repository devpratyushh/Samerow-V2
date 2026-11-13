import { useEffect, useRef, useState } from 'react';
import { FaArrowLeft, FaFilm, FaPlay, FaSearch, FaSignOutAlt } from 'react-icons/fa';
import Dialog from './Dialog';
import { jellyfinRequest, rememberConnection, savedConnection } from '../jellyfinAccount';
import { sessionHeaders } from '../session';
import { discoverAccountConnectors } from '../connectorDiscovery';
import './JellyfinDialog.css';

function Poster({ base, token, item }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (!item.imageTag) return;
    const controller = new AbortController(); let objectUrl;
    sessionHeaders().then(headers => fetch(`${base}/api/jellyfin/images/${encodeURIComponent(item.id)}`, { headers: { ...headers, Authorization: `Bearer ${token}` }, signal: controller.signal }))
      .then(response => response.ok ? response.blob() : null).then(blob => { if (!blob || controller.signal.aborted) return; objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); }).catch(() => {});
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [base, token, item.id, item.imageTag]);
  return <div className="jellyfin-poster">{src ? <img src={src} alt="" loading="lazy" /> : <FaFilm aria-hidden="true" />}</div>;
}

export default function JellyfinDialog({ open, onClose, onShare, onCancel, base = '', initialServerUrl = '', onCreatePrivateRoom, connectOnly = false, sameRowAccount, onConnected, onPairServer }) {
  const [token, setToken] = useState(() => connectOnly ? '' : savedConnection(initialServerUrl));
  const [account, setAccount] = useState(null);
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordSignIn, setPasswordSignIn] = useState(false);
  const [remember, setRemember] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [roomError, setRoomError] = useState(false);
  const [quick, setQuick] = useState(null);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [trail, setTrail] = useState([]);
  const [refresh, setRefresh] = useState(0);
  const [availableConnectors, setAvailableConnectors] = useState([]);
  const [manualServer, setManualServer] = useState(false);
  const [connectorError, setConnectorError] = useState('');
  const [discoveryComplete, setDiscoveryComplete] = useState(false);
  const selectedConnector = availableConnectors.find(connector => connector.address === serverUrl);
  const canSignIn = !connectOnly || manualServer || Boolean(initialServerUrl || selectedConnector);
  const showPassword = !connectOnly || manualServer || passwordSignIn;
  const generation = useRef(0);
  const parentId = trail.at(-1)?.id || '';
  const authenticated = reply => {
    if (connectOnly && reply.accountLinked !== true) throw new Error('This SameRow server needs an update before it can save account links. Please try again after the server update.');
    rememberConnection(reply.token, remember, initialServerUrl); setToken(reply.token); setAccount(reply.account);
    onConnected?.(reply.account);
    window.dispatchEvent(new Event('samerow:connections-changed'));
    setPassword(''); setQuick(null); setPending(''); setError(''); setTrail([]); setPage(0); setSearch(''); setQuery('');
  };
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer;
    const discover = async () => {
      try {
        const connectors = await discoverAccountConnectors(base, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDiscoveryComplete(true);
        setAvailableConnectors(connectors);
        setConnectorError('');
        const preferred = connectors.find(connector => connector.online) || connectors[0];
        if (!initialServerUrl && !manualServer && preferred) {
          setServerUrl(previous => connectors.some(connector => connector.address === previous) ? previous : preferred.address);
        }
      } catch (err) {
        if (!controller.signal.aborted) { setDiscoveryComplete(true); setConnectorError(err.message); }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(discover, 5000);
      }
    };
    discover();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, base, initialServerUrl, manualServer]);
  useEffect(() => {
    if (!open || token || connectOnly) return;
    const controller = new AbortController();
    jellyfinRequest(base, '/connections', { signal: controller.signal }).then(reply => {
      if (controller.signal.aborted) return;
      const connection = reply.connections?.find(value => !initialServerUrl || value.account.serverUrl === initialServerUrl);
      if (connection) { rememberConnection(connection.token, true, initialServerUrl); setToken(connection.token); }
    }).catch(() => { /* Guests and older servers continue to use manual sign-in. */ });
    return () => controller.abort();
  }, [open, token, connectOnly, base, initialServerUrl]);
  useEffect(() => {
    if (!open || !token) return;
    const controller = new AbortController();
    jellyfinRequest(base, '/account', { token, signal: controller.signal }).then(reply => { setAccount(reply.account); setServerUrl(reply.account.serverUrl); }).catch(err => {
      if (controller.signal.aborted) return;
      if (err.status === 401) { rememberConnection('', false, initialServerUrl); setToken(''); setAccount(null); }
      setError(err.message);
    });
    return () => controller.abort();
  }, [open, token, base, initialServerUrl]);
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!open || !account || !token || connectOnly) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPending(previous => previous === 'share' ? previous : 'library'); setError('');
      const params = new URLSearchParams({ startIndex: String(page * 30), limit: '30', ...(parentId ? { parentId } : {}), ...(query ? { search: query } : {}) });
      jellyfinRequest(base, `/library?${params}`, { token, signal: controller.signal }).then(reply => {
        if (controller.signal.aborted) return;
        setItems(reply.items); setTotal(reply.total);
        setPending(previous => previous === 'library' ? '' : previous);
      }).catch(err => { if (!controller.signal.aborted) { setError(err.message); setPending(previous => previous === 'library' ? '' : previous); } });
    }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, account, token, base, page, parentId, query, refresh, connectOnly]);
  useEffect(() => {
    if (!open || !quick) return;
    const controller = new AbortController(); let timer;
    const poll = async () => {
      try {
        const reply = await jellyfinRequest(base, `/quick-connect/${encodeURIComponent(quick.id)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (reply.token) { authenticated(reply); return; }
        timer = setTimeout(poll, 1800);
      } catch (err) { if (!controller.signal.aborted) { setError(err.message); setQuick(null); setPending(''); } }
    };
    timer = setTimeout(poll, 1500);
    return () => { controller.abort(); clearTimeout(timer); };
    // Quick Connect keeps the remember preference chosen when it started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, quick, base]);
  useEffect(() => () => { generation.current += 1; }, []);
  const close = () => { generation.current += 1; if (pending === 'share') onCancel?.(); setPending(''); setQuick(null); setPassword(''); onClose(); };
  const signIn = async (event, quickConnect = false) => {
    event.preventDefault(); const request = ++generation.current;
    setPending('login'); setError('');
    try {
      const reply = await jellyfinRequest(base, quickConnect ? '/quick-connect' : '/login', { body: { serverUrl: serverUrl.trim(), username: username.trim(), password, remember, ...(connectOnly ? { linkAccount: true } : {}) } });
      if (generation.current !== request) return;
      if (quickConnect) { setQuick(reply); setPending('quick'); } else authenticated(reply);
    } catch (err) { if (generation.current === request) { setError(err.message); setPending(''); } }
  };
  const logout = async () => {
    setPending('logout'); setError('');
    try { await jellyfinRequest(base, '/logout', { token, method: 'POST' }); }
    catch (err) { setError(err.message); setPending(''); return; }
    rememberConnection('', false, initialServerUrl); window.dispatchEvent(new Event('samerow:connections-changed')); setToken(''); setAccount(null); setItems([]); setPending(''); setPassword('');
  };
  const choose = async item => {
    if (pending === 'share') return;
    if (['Series', 'Season', 'CollectionFolder', 'Folder', 'BoxSet'].includes(item.type)) { setTrail(previous => [...previous, item]); setSearch(''); setQuery(''); setPage(0); return; }
    const request = ++generation.current; setPending('share'); setError(''); setRoomError(false);
    try { await onShare({ connectionToken: token, itemId: item.id }); if (generation.current === request) { setPending(''); onClose(); } }
    catch (err) { if (generation.current === request) { setError(err.message); setRoomError(['JELLYFIN_PRIVATE_ROOM_REQUIRED', 'JELLYFIN_ROOM_OWNER_REQUIRED'].includes(err.code)); setPending(''); } }
  };
  const createPrivateRoom = async () => {
    setPending('room');
    try { await onCreatePrivateRoom(); }
    catch (err) { setError(err.message || 'Could not create a private room. Try again.'); setPending(''); }
  };
  return <Dialog open={open} title={connectOnly ? 'Connect your Jellyfin account' : 'Your Jellyfin library'} description={connectOnly ? `Link your Jellyfin user to ${sameRowAccount || 'your signed-in SameRow account'}. We’ll select the server paired with this SameRow account.` : account ? 'Choose something to watch together. Audio and subtitles stay personal.' : 'Connect once, then choose movies and episodes from your library.'} onClose={close} className={account && !connectOnly ? 'jellyfin-library-dialog' : ''}>
    {error && <div className="jellyfin-error" role="alert"><p>{error}</p>{roomError && onCreatePrivateRoom ? <button className="sr-button" disabled={!!pending} onClick={createPrivateRoom}>{pending === 'room' ? 'Creating room…' : 'Leave and create private room'}</button> : account && <button className="sr-button" onClick={() => setRefresh(value => value + 1)}>Try again</button>}</div>}
    {!account ? <form onSubmit={signIn} className="jellyfin-sign-in">
      {availableConnectors.length > 0 && !initialServerUrl && <label className="room-field">Connected Jellyfin server
        <select value={availableConnectors.some(connector => connector.address === serverUrl) ? serverUrl : ''} onChange={event => { setManualServer(!event.target.value); setServerUrl(event.target.value); setError(''); }} disabled={!!pending}>
          <option value="">Enter a server address</option>
          {availableConnectors.map(connector => <option key={connector.id} value={connector.address}>{connector.name || `Jellyfin server ${connector.id.slice(0, 8)}`} · {connector.online ? 'Online' : 'Offline'}</option>)}
        </select>
      </label>}
      {connectorError && !initialServerUrl && <p role="status">{connectorError}</p>}
      {connectOnly && !canSignIn && <div className="jellyfin-account-discovery">
        {!discoveryComplete && <p role="status">Finding Jellyfin servers paired with your SameRow account…</p>}
        {discoveryComplete && !connectorError && <p>No Jellyfin server is paired with this SameRow account yet. In the Jellyfin plugin, choose Connect SameRow and approve it with this same Google or GitHub account.</p>}
        {onPairServer && <button type="button" className="sr-button" onClick={onPairServer}>Pair a Jellyfin server</button>}
        <button type="button" className="sr-button" onClick={() => { setManualServer(true); setServerUrl(''); }}>Enter a server address instead</button>
      </div>}
      {!initialServerUrl && selectedConnector && !manualServer && <p className="jellyfin-form-note">Your paired Jellyfin server is selected. Sign in with your Jellyfin account below.</p>}
      {canSignIn && !initialServerUrl && (!selectedConnector || manualServer) && <label className="room-field">Server address<input type="url" data-autofocus value={serverUrl} onChange={e => { setManualServer(true); setServerUrl(e.target.value); }} placeholder="https://jellyfin.example.com" autoComplete="url" disabled={!!pending} required /></label>}
      {canSignIn && !quick && <>{showPassword && <><label className="room-field">Username<input data-autofocus={initialServerUrl ? '' : undefined} value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" disabled={!!pending} required /></label>
        <label className="room-field">Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" disabled={!!pending} /></label></>}
        {!connectOnly && <label className="jellyfin-remember"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} disabled={!!pending} />Remember this connection</label>}
        <div className="jellyfin-login-actions">{showPassword && <button className="sr-button sr-button--primary" type="submit" disabled={!!pending || !serverUrl.trim() || !username.trim()}>{pending === 'login' ? 'Connecting…' : connectOnly ? 'Connect accounts' : 'Sign in'}</button>}
          <button className={`sr-button ${!showPassword ? 'sr-button--primary' : ''}`} type="button" onClick={event => signIn(event, true)} disabled={!!pending || !serverUrl.trim()}>Use Quick Connect</button>{!showPassword && <button className="sr-button" type="button" onClick={() => setPasswordSignIn(true)}>Use Jellyfin username and password</button>}</div></>}
      {quick && <div className="jellyfin-quick-connect" role="status"><p>In Jellyfin, open <strong>Settings → Quick Connect</strong> and approve this code.</p><output aria-label="Quick Connect code">{quick.code}</output><p>Waiting for approval…</p><button type="button" className="sr-button" onClick={() => { setQuick(null); setPending(''); }}>Cancel Quick Connect</button></div>}
      <p className="jellyfin-form-note">{initialServerUrl ? 'SameRow connects through the Jellyfin server you selected before entering the room.' : connectOnly ? 'Your Jellyfin password is used only to sign in. The connection is saved securely to your SameRow account, so you can use it on other devices.' : 'Use an address the SameRow server can reach. Your password is used only to sign in.'}</p>
    </form> : connectOnly ? <div className="jellyfin-link-success" role="status">
      <h3>Accounts connected</h3><p><strong>{account.userName}</strong> on <strong>{account.serverName}</strong> is linked to {sameRowAccount || 'your SameRow account'}.</p>
      <p>Your library is ready to share when you start a room.</p><button className="sr-button sr-button--primary" onClick={close}>Done</button>
    </div> : <>
      <div className="jellyfin-account"><span><strong>{account.serverName}</strong><small>Signed in as {account.userName}</small></span><button className="sr-button" onClick={logout} disabled={!!pending && pending !== 'library'}><FaSignOutAlt />Disconnect</button></div>
      <label className="jellyfin-search"><FaSearch /><input aria-label="Search your library" type="search" placeholder="Search movies and shows" value={search} onChange={e => setSearch(e.target.value)} disabled={pending === 'share'} /></label>
      <nav className="jellyfin-breadcrumbs" aria-label="Library location"><button onClick={() => { setTrail([]); setPage(0); setSearch(''); setQuery(''); }} disabled={!trail.length}>Library</button>{trail.map((item, index) => <span key={item.id}> / <button onClick={() => { setTrail(trail.slice(0, index + 1)); setPage(0); }} aria-current={index === trail.length - 1 ? 'page' : undefined}>{item.name}</button></span>)}</nav>
      {pending === 'library' && <p className="jellyfin-loading" role="status">Loading your library…</p>}
      {pending === 'share' && <p role="status">Opening in the room…</p>}
      <div className="jellyfin-library-grid" aria-busy={pending === 'library'}>{items.map(item => {
        const folder = ['Series', 'Season', 'CollectionFolder', 'Folder', 'BoxSet'].includes(item.type);
        return <button className="jellyfin-library-item" key={item.id} aria-label={`${folder ? 'Open' : 'Watch'} ${item.name}`} onClick={() => choose(item)} disabled={pending === 'share'}>
          <Poster base={base} token={token} item={item} /><span className="jellyfin-card-action">{folder ? 'Browse' : <><FaPlay />Watch together</>}</span><strong>{item.name}</strong><small>{item.type === 'Episode' ? `${item.seriesName || ''} · S${item.seasonNumber ?? ''} E${item.episodeNumber ?? ''}` : [item.year, folder ? item.type === 'Series' ? 'Series' : '' : item.duration ? `${Math.round(item.duration / 60)} min` : ''].filter(Boolean).join(' · ')}</small>
        </button>;
      })}</div>
      {!pending && !items.length && <div className="jellyfin-library-empty"><FaFilm /><p>{query ? 'No matches. Try another title.' : 'There are no videos here yet.'}</p>{trail.length > 0 && <button className="sr-button" onClick={() => { setTrail(trail.slice(0, -1)); setPage(0); }}><FaArrowLeft />Back</button>}</div>}
      {total > 30 && <div className="jellyfin-pagination"><button className="sr-button" disabled={page === 0 || !!pending} onClick={() => setPage(value => value - 1)}>Previous</button><span>{page * 30 + 1}–{Math.min((page + 1) * 30, total)} of {total}</span><button className="sr-button" disabled={(page + 1) * 30 >= total || !!pending} onClick={() => setPage(value => value + 1)}>Next</button></div>}
    </>}
  </Dialog>;
}
