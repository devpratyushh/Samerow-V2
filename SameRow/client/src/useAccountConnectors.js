import { useEffect, useState } from 'react';
import { sessionHeaders } from './session';

export function useAccountConnectors(serverUrl, uid) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!uid || serverUrl == null) return;
    const controller = new AbortController();
    let running = false, queued = false;
    const load = async () => {
      if (running) { queued = true; return; }
      running = true;
      try {
        const headers = await sessionHeaders();
        if (controller.signal.aborted) return;
        const get = async path => {
          const response = await fetch(`${serverUrl}${path}`, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]), cache: 'no-store' });
          if (response.status === 404) return {};
          if (!response.ok) throw new Error();
          return response.json();
        };
        const [servers, links] = await Promise.allSettled([get('/api/jellyfin-relay/connectors'), get('/api/jellyfin/connections')]);
        if (controller.signal.aborted) return;
        setResult(previous => {
          const old = previous?.uid === uid && previous.serverUrl === serverUrl ? previous : {};
          return { uid, serverUrl,
            connectors: servers.status === 'fulfilled' ? servers.value.connectors || [] : old.connectors || [],
            accounts: links.status === 'fulfilled' ? (links.value.connections || []).map(value => value.account) : old.accounts || [],
            accountsKnown: links.status === 'fulfilled',
            error: servers.status === 'rejected' || links.status === 'rejected' ? 'Could not check all connections. Open Manage connections to retry.' : '',
          };
        });
      } catch {
        // The identity may be refreshing; leave the last confirmed state intact.
      } finally { running = false; if (queued && !controller.signal.aborted) { queued = false; void load(); } }
    };
    void load();
    const timer = setInterval(load, 10000);
    window.addEventListener('focus', load);
    window.addEventListener('samerow:connections-changed', load);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', load); window.removeEventListener('samerow:connections-changed', load); };
  }, [serverUrl, uid]);
  return result?.uid === uid && result.serverUrl === serverUrl ? result : { connectors: [], accounts: [], accountsKnown: false, loading: Boolean(uid && serverUrl != null), error: '' };
}
