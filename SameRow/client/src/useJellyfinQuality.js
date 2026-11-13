import { useEffect, useRef, useState } from 'react';

export function useJellyfinQuality(endpoint) {
  const [result, setResult] = useState(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const generation = useRef(0);
  const pending = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    const versionRef = generation;
    let running = false;
    const refresh = async () => {
      if (running || pending.current === generation.current) return;
      running = true;
      const version = generation.current;
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const policy = await response.json();
        if (!policy || typeof policy.mode !== 'string' || !Number.isFinite(policy.maxBitrate) || policy.maxBitrate <= 0) throw new Error('Invalid playback settings');
        if (version === generation.current) setResult(previous => previous?.endpoint === endpoint && JSON.stringify(previous.policy) === JSON.stringify(policy) ? previous : { endpoint, policy, error: '', saving: false });
      } catch (error) {
        if (!controller.signal.aborted && version === generation.current) setResult(previous => {
          // A refresh failure must not interrupt an already loaded stream.
          if (previous?.endpoint === endpoint && previous.policy) return previous;
          const reason = error.name === 'TimeoutError' ? 'request timed out after 10 seconds' : /^HTTP \d{3}$/.test(error.message) ? error.message : 'network request failed';
          return { endpoint, policy: null, saving: false, error: `Could not load playback settings: ${reason}.` };
        });
      }
      finally { running = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => { controller.abort(); clearInterval(timer); versionRef.current++; };
  }, [endpoint, refreshCount]);
  const select = async mode => {
    const version = ++generation.current;
    pending.current = version;
    setResult(previous => ({ ...previous, endpoint, saving: true, error: '' }));
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
      if (!response.ok) throw Error();
      const policy = await response.json();
      if (version === generation.current) setResult({ endpoint, policy, saving: false, error: '' });
    } catch {
      if (version === generation.current) setResult(previous => ({ ...previous, saving: false, error: 'Could not change quality. Try again.' }));
    } finally { if (pending.current === version) pending.current = null; }
  };
  return { policy: result?.endpoint === endpoint ? result.policy : null, select,
    retry: () => { setResult(previous => previous?.endpoint === endpoint ? { ...previous, error: '' } : previous); setRefreshCount(value => value + 1); },
    saving: result?.endpoint === endpoint && result.saving, error: result?.endpoint === endpoint ? result.error : '' };
}
