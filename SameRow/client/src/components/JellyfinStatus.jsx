import { useState } from 'react';
import { availabilityFor, availabilityLabels, lastSeenLabel } from '../jellyfinAvailability';
import { jellyfinRequest } from '../jellyfinAccount';
import './JellyfinStatus.css';
export default function JellyfinStatus({ connections, base, onConnect, onBrowse }) {
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  const chooseDefault = async id => {
    setBusy(id); setFailure('');
    try { await jellyfinRequest(base, '/preferences', { body: { defaultServerId: id } }); window.dispatchEvent(new Event('samerow:connections-changed')); }
    catch (error) { setFailure(error.message); }
    finally { setBusy(''); }
  };
  return <div className="jellyfin-status-list" aria-label="Jellyfin availability">
    {connections.servers.map(server => {
      const state = availabilityFor(server, { online: !connections.clientOffline, unavailable: !!connections.error });
      return <article className="jellyfin-status-card" key={server.id}>
        <div className="jellyfin-status-heading"><strong>{server.name}</strong><span className={`jellyfin-status-badge is-${state.status}`} role="status">{availabilityLabels[state.status]}</span></div>
        <p>{server.account ? `Jellyfin user: ${server.account.userName}` : 'Jellyfin user not authorized yet'}</p>
        <p className="jellyfin-status-meta">Bound to {server.sameRowEmail || 'your SameRow account'}</p>
        <p>{state.message}</p><small>{lastSeenLabel(server.lastSeen)}{connections.error && server.checkedAt ? ` · Last checked ${new Date(server.checkedAt).toLocaleTimeString()}` : ''}</small>
        <div className="jellyfin-status-actions">
          {state.status === 'sign_in_required' ? <button className="sr-button" onClick={() => onConnect(server.address)}>Authorize Jellyfin</button> : <button className="sr-button" disabled={state.status !== 'ready'} onClick={() => onBrowse(server.address)}>Browse library</button>}
          {connections.servers.length > 1 && <button className="sr-button" disabled={!!busy || connections.clientOffline || !!connections.error || connections.defaultServerId === server.id} onClick={() => chooseDefault(server.id)}>{connections.defaultServerId === server.id ? 'Default server' : 'Make default'}</button>}
        </div>
      </article>;
    })}
    {connections.clientOffline && !connections.servers.length && <p role="status">You’re offline. Reconnect this device to check your saved libraries.</p>}
    {failure && <p role="alert">{failure}</p>}
    <button className="sr-button" disabled={connections.clientOffline} onClick={() => window.dispatchEvent(new Event('samerow:connections-changed'))}>Check again</button>
  </div>;
}
