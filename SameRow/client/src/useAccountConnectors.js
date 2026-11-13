import { useEffect, useState } from 'react';
import { jellyfinRequest } from './jellyfinAccount';
import { discoverAccountConnectors } from './connectorDiscovery';

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
        if (controller.signal.aborted) return;
        const [servers, links] = await Promise.allSettled([discoverAccountConnectors(serverUrl, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) }), jellyfinRequest(serverUrl, '/connections', { signal: controller.signal })]);
        if (controller.signal.aborted) return;
        setResult(previous => {
          const old = previous?.uid === uid && previous.serverUrl === serverUrl ? previous : {};
          return { uid, serverUrl,
            connectors: servers.status === 'fulfilled' ? servers.value : old.connectors || [],
            accounts: links.status === 'fulfilled' ? (links.value.connections || []).map(value => value.account) : old.accounts || [],
            accountsKnown: links.status === 'fulfilled',
            error: servers.status === 'rejected' || links.status === 'rejected' ? [servers, links].filter(value => value.status === 'rejected').map(value => value.reason.message).join(' ') : '',
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
