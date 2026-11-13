import { useEffect, useEffectEvent, useState } from 'react';
export function useJellyfinRecovery(url, onRecovered) {
  const [recovery, setRecovery] = useState('');
  const recovered = useEffectEvent(onRecovered);
  useEffect(() => {
    const controller = new AbortController();
    let lost = false, running = false;
    const check = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try {
        if (!navigator.onLine) { lost = true; setRecovery('You’re offline. Playback will reconnect when this device is online.'); return; }
        const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(7000)]), cache: 'no-store' });
        if ([401, 403].includes(response.status)) { setRecovery('This playback session ended. Reopen the library to authorize playback.'); return; }
        if (!response.ok) throw Error();
        const health = await response.json();
        if (health.status === 'sign_in_required') { setRecovery('Jellyfin sign-in is required. The room and playback position are saved.'); return; }
        if (health.status !== 'ready') throw Error();
        setRecovery('');
        if (lost) { lost = false; recovered(); }
      } catch {
        if (!controller.signal.aborted) { lost = true; setRecovery('Reconnecting to Jellyfin… Your room and playback position are saved.'); }
      } finally { running = false; }
    };
    void check();
    const timer = setInterval(check, 10000);
    window.addEventListener('online', check); window.addEventListener('offline', check);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('online', check); window.removeEventListener('offline', check); };
  }, [url]);
  return recovery;
}
