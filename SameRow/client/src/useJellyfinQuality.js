import { useEffect, useRef, useState } from 'react';

export function useJellyfinQuality(endpoint) {
  const [result, setResult] = useState(null);
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
        const response = await fetch(endpoint, { signal: controller.signal });
        if (!response.ok) throw Error();
        const policy = await response.json();
        if (version === generation.current) setResult(previous => previous?.endpoint === endpoint && JSON.stringify(previous.policy) === JSON.stringify(policy) ? previous : { endpoint, policy, error: '', saving: false });
      } catch { /* Playback can continue through a temporary policy refresh failure. */ }
      finally { running = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => { controller.abort(); clearInterval(timer); versionRef.current++; };
  }, [endpoint]);
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
    saving: result?.endpoint === endpoint && result.saving, error: result?.endpoint === endpoint ? result.error : '' };
}
