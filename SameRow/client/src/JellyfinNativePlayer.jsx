import { browserId } from './browserId';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { FaFilm, FaStop } from 'react-icons/fa';
import { jellyfinTime } from './jellyfinRoom';
import { useRoomPresentation } from './components/RoomPresentation';
import './JellyfinNativePlayer.css';
import { useJellyfinQuality } from './useJellyfinQuality';
import JellyfinQuality from './JellyfinQuality';

export default function JellyfinNativePlayer({ state, base, command, connected, focused, onBrowse, onOpenSameRow }) {
  const frameRef = useRef(null);
  const [channel] = useState(() => browserId());
  const [attempt, setAttempt] = useState(0);
  const [qualityNote, setQualityNote] = useState('');
  const [status, setStatus] = useState({ phase: 'loading' });
  const { fullscreen, toggleFullscreen } = useRoomPresentation();
  const quality = useJellyfinQuality(`${base}/api/jellyfin-native/${state.accessToken}/samerow/quality`);
  const ready = useRef(false);
  const send = (type, details = {}) => frameRef.current?.contentWindow?.postMessage({ source: 'samerow', channel, type, ...details }, '*');
  const synchronize = useEffectEvent(() => {
    if (!ready.current) return;
    send('sync', { state: { playing: state.playing, timestamp: jellyfinTime(state), duration: state.duration, revision: state.revision }, connected });
    send('focus', { focused, fullscreen });
    if (quality.policy) send('quality', { policy: quality.policy });
  });
  const receive = useEffectEvent(event => {
    if (event.source !== frameRef.current?.contentWindow || event.origin !== 'null' || event.data?.source !== 'samerow-jellyfin' || event.data.channel !== channel) return;
    const data = event.data;
    if (data.type === 'ready') { ready.current = true; synchronize(); }
    if (data.type === 'status' && ['loading', 'playing', 'paused', 'buffering', 'blocked', 'error', 'ended'].includes(data.phase)) setStatus({ phase: data.phase, message: typeof data.message === 'string' ? data.message.slice(0, 300) : '' });
    if (data.type === 'command' && connected && ['play', 'pause', 'seek', 'stop'].includes(data.action)) {
      if (data.action === 'seek' && (!Number.isFinite(data.time) || data.time < 0 || data.time > state.duration)) return;
      command(data.action, data.time);
    }
    if (data.type === 'quality-status' && typeof data.message === 'string') setQualityNote(data.message.slice(0, 200));
    if (data.type === 'fullscreen' && typeof data.fullscreen === 'boolean' && data.fullscreen !== fullscreen) toggleFullscreen?.();
  });
  useEffect(() => {
    const listener = event => receive(event);
    window.addEventListener('message', listener);
    const timer = setInterval(() => synchronize(), 500);
    return () => { window.removeEventListener('message', listener); clearInterval(timer); };
  }, []);
  useEffect(() => { synchronize(); }, [state.revision, state.accessToken, connected, focused, fullscreen]);
  useEffect(() => {
    const timeout = setTimeout(() => { if (!ready.current) setStatus({ phase: 'error', message: 'Jellyfin did not finish loading. Reconnect playback to try again.' }); }, 45000);
    return () => clearTimeout(timeout);
  }, [attempt, state.accessToken]);
  const src = `${base}/api/jellyfin-native/${state.accessToken}/web/index.html?${new URLSearchParams({ channel, parentOrigin: window.location.origin, attempt: String(attempt) })}`;
  return <div className="jellyfin-native-player" data-phase={status.phase}>
    <div className="jellyfin-native-stage">
      <details className="jellyfin-native-quality"><summary>Quality</summary><JellyfinQuality {...quality} select={mode => { setQualityNote(''); return quality.select(mode); }} />{qualityNote && <small role="status">{qualityNote}</small>}{onOpenSameRow && <button className="sr-button" onClick={onOpenSameRow}>Open SameRow player</button>}</details>
      <iframe ref={frameRef} className="jellyfin-native-frame" src={src} title="Jellyfin player" allow="autoplay; fullscreen; picture-in-picture" sandbox="allow-scripts allow-forms allow-pointer-lock allow-downloads" referrerPolicy="no-referrer" />
      {['loading', 'blocked', 'error', 'ended'].includes(status.phase) && <div className="jellyfin-native-status" role="status"><p>{status.message || (status.phase === 'loading' ? 'Opening Jellyfin’s player…' : status.phase === 'blocked' ? 'Press Play to join the movie.' : status.phase === 'ended' ? 'The movie has ended.' : 'Playback could not start.')}</p>
        {status.phase === 'blocked' && <button className="sr-button sr-button--primary" onClick={() => send('play-local')}>Play on this device</button>}
        {status.phase === 'ended' && <button className="sr-button sr-button--primary" onClick={() => { setStatus({ phase: 'loading' }); command('play'); }}>Watch again</button>}
        {status.phase === 'error' && <button className="sr-button" onClick={() => { ready.current = false; setStatus({ phase: 'loading' }); setAttempt(value => value + 1); }}>Reconnect playback</button>}
      </div>}
    </div>
    <div className="jellyfin-native-info"><span title={state.title}>{state.title}<small>{connected ? 'Shared playback · personal audio & subtitles' : 'Reconnecting to room…'}</small></span><div><button className="icon-button" onClick={onBrowse} title="Browse Jellyfin library" aria-label="Browse Jellyfin library"><FaFilm /></button><button className="icon-button" onClick={() => command('stop')} disabled={!connected} title="Stop movie for everyone" aria-label="Stop movie for everyone"><FaStop /></button></div></div>
  </div>;
}
