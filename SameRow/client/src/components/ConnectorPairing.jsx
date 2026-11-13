import { useEffect, useState } from 'react';
import { sessionHeaders } from '../session';
import { discoverAccountConnectors } from '../connectorDiscovery';
import './ConnectorPairing.css';

export default function ConnectorPairing({ serverUrl, onPrivateRoom, disabled }) {
  const [enabled, setEnabled] = useState(false);
  const [connectors, setConnectors] = useState([]);
  const [replaceId, setReplaceId] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    let relayEnabled = false;
    const load = async () => {
      if (running || !relayEnabled) return;
      running = true;
      try {
        const connectors = await discoverAccountConnectors(serverUrl, { signal: controller.signal });
        if (!controller.signal.aborted) setConnectors(connectors);
      } catch {
        // A transient refresh failure keeps the last known list available.
      } finally { running = false; }
    };
    fetch(`${serverUrl}/api/config`, { signal: controller.signal })
      .then(response => response.json())
      .then(config => {
        if (controller.signal.aborted) return;
        relayEnabled = config.jellyfinRelay === true;
        setEnabled(relayEnabled);
        void load();
      }).catch(() => {});
    const timer = setInterval(load, 10000);
    window.addEventListener('focus', load);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', load); };
  }, [serverUrl, refresh]);

  const revoke = async id => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`${serverUrl}/api/jellyfin-relay/pair/${id}`, { method: 'DELETE', headers: await sessionHeaders() });
      if (!response.ok) throw new Error('Could not disconnect this server. Try again.');
      setConnectors(previous => previous.filter(connector => connector.id !== id));
      setRefresh(value => value + 1);
      window.dispatchEvent(new Event('samerow:connections-changed'));
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  if (!enabled) return null;
  return <div className="connector-pairing">
    {error && <p role="alert">{error}</p>}
    {connectors.length > 0 && <section className="connector-pairing-section" aria-label="Connected Jellyfin servers">
      <h4>Your connected servers</h4>
      {connectors.map(connector => <div className="connector-pairing-server" key={connector.id}>
        <div><strong>{connector.name || `Jellyfin server ${connector.id.slice(0, 8)}`}</strong><small>{connector.online ? 'Relay reachable' : 'Offline'}</small></div>
        {confirmId === connector.id ? <div><p>Disconnect this server for your account on every device?</p><button type="button" className="sr-button" disabled={busy} onClick={() => revoke(connector.id)}>Confirm disconnect</button><button type="button" className="sr-button" onClick={() => setConfirmId('')}>Cancel</button></div> : <button type="button" className="sr-button" disabled={busy} onClick={() => setConfirmId(connector.id)}>Disconnect</button>}
        <button type="button" className="sr-button" onClick={() => setReplaceId(replaceId === connector.id ? '' : connector.id)}>Replace installation</button>
        {replaceId === connector.id && <p>Install SameRow Connect on the replacement server, approve its pairing with this SameRow account, then authorize your Jellyfin user. Keep this connection until the replacement shows Ready; then disconnect this old installation.</p>}
      </div>)}
      <p>Create a private room, then select your server in Share something → Your Jellyfin library.</p>
    </section>}
    <button type="button" className="sr-button" disabled={disabled} onClick={onPrivateRoom}>Generate private room code</button>
    <section className="connector-pairing-section">
      <h4>Jellyfin plugin</h4>
      <p>Install SameRow Connect on your Jellyfin server. In its plugin settings, select Connect SameRow and approve the connection here.</p>
      <a href="https://github.com/devpratyushh/Samerow-V2/tree/main/jellyfin-plugin-samerow" target="_blank" rel="noreferrer">Plugin installation guide</a>
    </section>
  </div>;
}
