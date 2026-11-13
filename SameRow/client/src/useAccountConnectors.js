import { useEffect, useState } from 'react';
import { sessionHeaders } from './session';

export function useAccountConnectors(serverUrl, uid) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!uid || serverUrl == null) return;
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const headers = await sessionHeaders();
        if (controller.signal.aborted) return;
        const response = await fetch(`${serverUrl}/api/jellyfin-relay/connectors`, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]), cache: 'no-store' });
        // Older and local servers may not support account connectors.
        if (response.status === 404) { setResult({ uid, serverUrl, connectors: [], error: '' }); return; }
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!controller.signal.aborted) setResult({ uid, serverUrl, connectors: Array.isArray(data.connectors) ? data.connectors : [], error: '' });
      } catch {
        if (!controller.signal.aborted) setResult(previous => ({ uid, serverUrl, connectors: previous?.uid === uid && previous.serverUrl === serverUrl ? previous.connectors : [], error: 'Could not check connected servers. Open Manage connections to retry.' }));
      } finally { running = false; }
    };
    void load();
    const timer = setInterval(load, 10000);
    window.addEventListener('focus', load);
    window.addEventListener('samerow:connections-changed', load);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', load); window.removeEventListener('samerow:connections-changed', load); };
  }, [serverUrl, uid]);
  return result?.uid === uid && result.serverUrl === serverUrl ? result : { connectors: [], loading: Boolean(uid && serverUrl != null), error: '' };
}
