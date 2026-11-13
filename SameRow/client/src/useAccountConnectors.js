import { useEffect, useState } from 'react';
import { jellyfinRequest } from './jellyfinAccount';

export function useAccountConnectors(serverUrl, uid) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!uid || serverUrl == null) return;
    const controller = new AbortController();
    const cacheKey = `samerow.jellyfin.status:${uid}:${serverUrl}`;
    const cached = () => { try { return JSON.parse(sessionStorage.getItem(cacheKey) || 'null'); } catch { return null; } };
    let running = false;
    const load = async () => {
      if (running || controller.signal.aborted) return;
      if (!navigator.onLine) {
        setResult(previous => ({ ...(previous?.uid === uid ? previous : cached() || {}), uid, serverUrl, clientOffline: true, loading: false }));
        return;
      }
      running = true;
      try {
        const reply = await jellyfinRequest(serverUrl, '/status', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
        if (controller.signal.aborted) return;
        const value = { uid, serverUrl, servers: reply.servers || [], defaultServerId: reply.defaultServerId,
          connectors: (reply.servers || []).map(server => ({ ...server, online: server.status === 'ready' })),
          accounts: (reply.servers || []).filter(server => server.account).map(server => server.account),
          accountsKnown: true, error: '', checkedAt: reply.checkedAt, clientOffline: false };
        try { sessionStorage.setItem(cacheKey, JSON.stringify(value)); } catch { /* Current session still works without storage. */ }
        setResult(value);
      } catch (error) {
        if (!controller.signal.aborted) setResult(previous => ({ ...(previous?.uid === uid && previous.serverUrl === serverUrl ? previous : cached() || {}), uid, serverUrl, error: error.message, clientOffline: !navigator.onLine, loading: false }));
      } finally { running = false; }
    };
    void load();
    const timer = setInterval(load, 10000);
    const events = ['focus', 'online', 'offline', 'samerow:connections-changed'];
    events.forEach(event => window.addEventListener(event, load));
    return () => { controller.abort(); clearInterval(timer); events.forEach(event => window.removeEventListener(event, load)); };
  }, [serverUrl, uid]);
  const empty = { connectors: [], accounts: [], servers: [], accountsKnown: false, error: '', clientOffline: false };
  return result?.uid === uid && result.serverUrl === serverUrl ? { ...empty, ...result } : { ...empty, loading: Boolean(uid && serverUrl != null) };
}
