import { useEffect, useState } from 'react';
import { sessionHeaders } from '../session';

export default function ConnectorPairing({ serverUrl, onPrivateRoom, disabled }) {
  const [enabled, setEnabled] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${serverUrl}/api/config`, { signal: controller.signal })
      .then(response => response.json()).then(config => setEnabled(config.jellyfinRelay === true)).catch(() => {});
    return () => controller.abort();
  }, [serverUrl]);
  if (!enabled) return null;

  const pair = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${serverUrl}/api/jellyfin-relay/pair`, { method: 'POST', headers: await sessionHeaders() });
      if (!response.ok) throw new Error('Could not pair the connector. Check your sign-in or try again later.');
      setPairing(await response.json());
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };

  const revoke = async () => {
    setBusy(true);
    setError('');
    try {
      const id = pairing.token.split('.')[0];
      const response = await fetch(`${serverUrl}/api/jellyfin-relay/pair/${id}`, { method: 'DELETE', headers: await sessionHeaders() });
      if (!response.ok) throw new Error('Could not revoke this connector.');
      setPairing(null);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };

  return <details>
    <summary>Host from your Jellyfin Docker container</summary>
    <button type="button" className="sr-button" disabled={busy} onClick={pair}>Pair Docker connector</button>
    <button type="button" className="sr-button" disabled={disabled} onClick={onPrivateRoom}>Generate private room code</button>
    {error && <p role="alert">{error}</p>}
    {pairing && <>
      <p>Add these settings to your Docker Compose environment. Keep the connector token private.</p>
      <textarea aria-label="Docker connector settings" readOnly rows={3} value={`SAMEROW_CONNECTOR_GATEWAY=${pairing.gateway}\nSAMEROW_CONNECTOR_TOKEN=${pairing.token}`} />
      <label>Jellyfin address for SameRow Web<input readOnly value={pairing.address} /></label>
      <button type="button" className="sr-button" disabled={busy} onClick={revoke}>Revoke this connector</button>
    </>}
  </details>;
}
