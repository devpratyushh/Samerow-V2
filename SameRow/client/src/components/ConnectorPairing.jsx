import { useEffect, useState } from 'react';
import { sessionHeaders } from '../session';
import { discoverAccountConnectors } from '../connectorDiscovery';
import './ConnectorPairing.css';

export default function ConnectorPairing({ serverUrl, onPrivateRoom, disabled }) {
  const [enabled, setEnabled] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [connectors, setConnectors] = useState([]);
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

  const pair = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`${serverUrl}/api/jellyfin-relay/pair`, { method: 'POST', headers: await sessionHeaders() });
      if (!response.ok) throw new Error('Could not pair the connector. Sign in to your SameRow account and try again.');
      setPairing(await response.json());
      setRefresh(value => value + 1);
      window.dispatchEvent(new Event('samerow:connections-changed'));
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const revoke = async id => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`${serverUrl}/api/jellyfin-relay/pair/${id}`, { method: 'DELETE', headers: await sessionHeaders() });
      if (!response.ok) throw new Error('Could not disconnect this server. Try again.');
      if (pairing?.token?.startsWith(`${id}.`)) setPairing(null);
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
        <div><strong>{connector.name || `Jellyfin server ${connector.id.slice(0, 8)}`}</strong><small>{connector.online ? 'Online' : 'Offline'}</small></div>
        <button type="button" className="sr-button" disabled={busy} onClick={() => revoke(connector.id)}>Disconnect</button>
      </div>)}
      <p>Create a private room, then select your server in Share something → Your Jellyfin library.</p>
    </section>}
    <button type="button" className="sr-button" disabled={disabled} onClick={onPrivateRoom}>Generate private room code</button>
    <section className="connector-pairing-section">
      <h4>Jellyfin plugin</h4>
      <p>Install SameRow Connect on your Jellyfin server. In its plugin settings, select Connect SameRow and approve the connection here.</p>
      <a href="https://github.com/devpratyushh/Samerow-V2/tree/main/jellyfin-plugin-samerow" target="_blank" rel="noreferrer">Plugin installation guide</a>
    </section>
    <section className="connector-pairing-section">
      <h4>Docker connector</h4>
      <button type="button" className="sr-button" disabled={busy || !!pairing} onClick={pair}>Pair Docker connector</button>
      {pairing && <>
        <p>Add these settings to your Docker Compose environment. Keep the connector token private.</p>
        <textarea aria-label="Docker connector settings" readOnly rows={3} value={`SAMEROW_CONNECTOR_GATEWAY=${pairing.gateway}\nSAMEROW_CONNECTOR_TOKEN=${pairing.token}`} />
        <label>Jellyfin address for SameRow Web<input readOnly value={pairing.address} /></label>
        <button type="button" className="sr-button" disabled={busy} onClick={() => revoke(pairing.token.split('.')[0])}>Revoke this connector</button>
      </>}
    </section>
  </div>;
}
