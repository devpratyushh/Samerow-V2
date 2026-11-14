import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import ReactPlayer from 'react-player';
import { FaTimes } from 'react-icons/fa';
import { playbackTime, youtubeErrorMessage } from './youtube';
import { commandServerTime, createDriftController } from './playbackSync';
import PlaybackControls from './components/PlaybackControls';
import './YouTubePlayer.css';

export default function YouTubePlayer({ state, socket, roomId, onClose, focused = true, onJoinStatus }) {
  const playerRef = useRef(null);
  const desired = useRef(state);
  const ready = useRef(false);
  const hasPlayed = useRef(false);
  const buffering = useRef(false);
  const ended = useRef(false);
  const [drift] = useState(createDriftController);
  const rateRequest = useRef({ value: 1, at: 0 });
  const rateRejected = useRef(false);
  const pendingSeek = useRef(null);
  const playRequest = useRef(null);
  const pendingCommand = useRef(null);
  const playStartTimer = useRef(null);
  const autoplayCleanup = useRef(null);
  const autoplayBlocked = useRef(false);
  const config = useMemo(() => ({ youtube: { origin: window.location.origin, referrerpolicy: 'strict-origin-when-cross-origin', disablekb: 1, fs: 0 } }), []);
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [currentTime, setCurrentTime] = useState(state.timestamp || 0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const preparing = Boolean(onJoinStatus);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!ready.current) { setError('YouTube is taking too long to load. Check your connection or content blocker, then retry.'); setPhase('error'); }
    }, 15000);
    return () => { playRequest.current = null; clearTimeout(timeout); clearTimeout(playStartTimer.current); autoplayCleanup.current?.(); };
  }, [attempt]);

  const isSeeking = useCallback(() => {
    if (pendingSeek.current && performance.now() >= pendingSeek.current.expires) pendingSeek.current = null;
    return Boolean(pendingSeek.current);
  }, []);
  const readClock = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const length = player.duration;
    if ((Number.isFinite(length) && length > 0) || length === Infinity) setDuration(length);
    if (Number.isFinite(player.currentTime) && !isSeeking()) setCurrentTime(player.currentTime);
  }, [isSeeking]);
  const markBlocked = useCallback(() => {
    autoplayBlocked.current = true;
    playRequest.current = null;
    clearTimeout(playStartTimer.current);
    setPhase('blocked'); setPlaying(false);
  }, [setPhase, setPlaying]);
  const startPlayback = useCallback(() => {
    const player = playerRef.current;
    if (!player || playRequest.current) return;
    autoplayBlocked.current = false;
    const request = { player };
    playRequest.current = request;
    // Some iframe providers leave play() pending instead of rejecting autoplay.
    playStartTimer.current = setTimeout(() => {
      if (playRequest.current === request && player.paused && !player.seeking) markBlocked();
    }, 4000);
    Promise.resolve(player.play()).catch(() => {
      if (playRequest.current === request) markBlocked();
    });
  }, [markBlocked]);
  const setLocalRate = useCallback(value => {
    if (rateRequest.current.value === value) return;
    rateRequest.current = { value, at: performance.now() };
    if (playerRef.current) playerRef.current.playbackRate = value;
    setPlaybackRate(value);
  }, [setPlaybackRate]);
  const applyState = useCallback((force = false) => {
    const player = playerRef.current;
    if (!ready.current || !player) return;
    if (!socket.connected) { setLocalRate(1); return; }
    const wanted = desired.current;
    const length = player.duration;
    const limit = Number.isFinite(length) && length > 0
      ? Math.max(0, length - (preparing && !hasPlayed.current ? 0.1 : 0))
      : Infinity;
    const target = Math.max(0, Math.min(limit, playbackTime(wanted)));
    // Load a paused room's frame locally with the guest's player muted.
    const warmingPausedFrame = preparing && !wanted.isPlaying && (!hasPlayed.current || buffering.current);
    if (!wanted.isPlaying && !warmingPausedFrame) {
      playRequest.current = null; clearTimeout(playStartTimer.current);
      autoplayBlocked.current = false; buffering.current = false;
      if (!player.paused) player.pause();
    }
    if (Number.isFinite(length) && length > 0 && target >= length) {
      if (!ended.current) {
        ended.current = true; playRequest.current = null; clearTimeout(playStartTimer.current);
        if (!player.paused) player.pause();
        if (Math.abs(player.currentTime - length) > 0.08) {
          pendingSeek.current = { target: length, expires: performance.now() + 4000 };
          player.currentTime = length; setCurrentTime(length);
        }
        setPlaying(false); setPhase('ended');
      }
      setLocalRate(1); return;
    }
    ended.current = false;
    const now = performance.now();
    if (rateRequest.current.value !== 1 && now - rateRequest.current.at > 1000 && Math.abs(player.playbackRate - rateRequest.current.value) > 0.01) rateRejected.current = true;
    const rates = rateRejected.current ? [1] : player.api?.getAvailablePlaybackRates?.() || [0.95, 1, 1.05];
    const plan = drift.correction({
      currentTime: player.currentTime, target, playing: wanted.isPlaying, now, force, rates,
      suspended: isSeeking() || player.seeking || (wanted.isPlaying && (buffering.current || autoplayBlocked.current)) || length === Infinity
    });
    setLocalRate(plan.rate);
    if (plan.seek !== undefined) {
      pendingSeek.current = { target: plan.seek, expires: now + 4000 };
      player.currentTime = plan.seek;
      setCurrentTime(plan.seek);
    }
    if ((wanted.isPlaying || warmingPausedFrame) && player.paused && !buffering.current && !autoplayBlocked.current) startPlayback();
  }, [socket.connected, preparing, drift, isSeeking, setLocalRate, setCurrentTime, setPlaying, setPhase, startPlayback]);
  useEffect(() => {
    const previous = desired.current;
    const pending = pendingCommand.current;
    if (pending && performance.now() < pending.expires && state.sessionId === previous.sessionId &&
        Number.isFinite(state.revision) && state.revision <= pending.revision && state.commandId !== pending.id) return;
    pendingCommand.current = null;
    const command = state.revision !== previous.revision || state.isPlaying !== previous.isPlaying || Math.abs(playbackTime(state) - playbackTime(previous)) > 0.3;
    desired.current = state;
    if (command) { pendingSeek.current = null; drift.reset(); }
    // Native media callbacks can update React; run them after this commit finishes.
    let active = true;
    queueMicrotask(() => { if (active && desired.current === state) applyState(command); });
    return () => { active = false; };
  }, [state, applyState, drift]);
  const reportReady = useEffectEvent(() => {
    const player = playerRef.current;
    const wanted = desired.current;
    if (!onJoinStatus || !ready.current || !hasPlayed.current || !player || buffering.current || autoplayBlocked.current) return;
    const target = Math.min(playbackTime(wanted), player.duration || Infinity);
    if (ended.current || (player.readyState >= 3 && !isSeeking() && player.paused === !wanted.isPlaying &&
        Math.abs(player.currentTime - target) <= 0.75)) {
      onJoinStatus({ phase: 'ready', state: wanted });
    }
  });
  useEffect(() => {
    const tick = () => { if (ready.current) { readClock(); applyState(); reportReady(); } };
    const timer = setInterval(tick, 250);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [readClock, applyState]);

  const publish = (isPlaying, force = false, position) => {
    const player = playerRef.current;
    if (preparing || !ready.current || !player || error || !socket.connected) return;
    if (!force && desired.current.isPlaying === isPlaying) return;
    const timestamp = position ?? (Number.isFinite(player.currentTime) ? player.currentTime : 0);
    const commandId = globalThis.crypto?.randomUUID?.() || `${socket.id || 'viewer'}:${performance.now()}:${Math.random().toString(36).slice(2)}`;
    pendingCommand.current = { id: commandId, revision: desired.current.revision ?? -1, expires: performance.now() + 5000 };
    desired.current = { ...desired.current, isPlaying, timestamp, receivedAt: performance.now() };
    socket.emit('youtube-state-change', { roomId, sessionId: state.sessionId, isPlaying, timestamp, sentAt: commandServerTime(desired.current), commandId });
  };
  const seek = position => {
    if (!ready.current || !socket.connected || !playerRef.current) return;
    const target = Math.max(0, Math.min(Number.isFinite(duration) && duration > 0 ? duration : position, position));
    drift.reset(); setLocalRate(1); ended.current = false;
    pendingSeek.current = { target, expires: performance.now() + 4000 };
    playerRef.current.currentTime = target;
    setCurrentTime(target);
    publish(desired.current.isPlaying, true, target);
  };
  const handleSeeked = () => {
    const time = playerRef.current?.currentTime || 0;
    if (pendingSeek.current && Math.abs(time - pendingSeek.current.target) < 0.3) pendingSeek.current = null;
    readClock();
  };
  const joinPlayback = () => {
    autoplayBlocked.current = false; buffering.current = false;
    pendingSeek.current = null; drift.reset();
    applyState(true);
  };
  const togglePlay = () => {
    const player = playerRef.current;
    if (!ready.current || !player || !socket.connected) return;
    if (phase === 'blocked') { joinPlayback(); return; }
    if (ended.current) { seek(0); publish(true); startPlayback(); return; }
    if (desired.current.isPlaying) {
      publish(false); setLocalRate(1);
      playRequest.current = null; clearTimeout(playStartTimer.current); player.pause();
    } else {
      // Publish the user's intent before waiting for this viewer's buffer to fill.
      publish(true); startPlayback();
    }
  };
  const retry = () => {
    ready.current = false; hasPlayed.current = false; pendingSeek.current = null; autoplayBlocked.current = false;
    buffering.current = false; ended.current = false; rateRejected.current = false; drift.reset(); setLocalRate(1);
    playRequest.current = null; clearTimeout(playStartTimer.current); autoplayCleanup.current?.();
    setError(''); setPhase('loading'); setAttempt(value => value + 1);
  };
  const reportJoinStatus = useEffectEvent(() => {
    if (phase === 'error') onJoinStatus?.({ phase: 'error', state, retry });
    else if (phase === 'blocked') onJoinStatus?.({ phase: 'blocked', state, retry: joinPlayback });
    else onJoinStatus?.({ phase: 'loading', state });
  });
  useEffect(() => { reportJoinStatus(); }, [phase, state.revision]);
  useEffect(() => {
    if (!preparing || phase === 'blocked' || phase === 'error') return;
    const timeout = setTimeout(() => {
      setError('YouTube could not buffer the room position.'); setPhase('error');
      ready.current = false;
    }, 20000);
    return () => clearTimeout(timeout);
  }, [preparing, attempt, state.revision, phase]);

  return <section className="youtube-watch" aria-label="YouTube watch together">
    <div className="youtube-watch-video">
      <ReactPlayer key={attempt} ref={playerRef} src={state.url} width="100%" height="100%" controls={false} muted={!focused || muted} volume={volume} playsInline preload="auto" playbackRate={playbackRate} config={config}
        onLoadStart={event => {
          // Apply config before the custom element constructs its iframe URL.
          if ('config' in event.target) event.target.config = config.youtube;
        }}
        onLoadedMetadata={() => {
          ready.current = true; setError(''); setPhase('ready');
          autoplayCleanup.current?.();
          const api = playerRef.current?.api;
          api?.addEventListener('onAutoplayBlocked', markBlocked);
          autoplayCleanup.current = () => api?.removeEventListener('onAutoplayBlocked', markBlocked);
          readClock(); applyState(true);
        }}
        onTimeUpdate={readClock} onDurationChange={readClock}
        onPlaying={() => {
          const recovering = buffering.current || !hasPlayed.current;
          buffering.current = false; ended.current = false; autoplayBlocked.current = false;
          playRequest.current = null; clearTimeout(playStartTimer.current);
          setPlaying(true); setPhase('playing');
          hasPlayed.current = true;
          applyState(recovering);
        }}
        onPause={() => {
          setPlaying(false); setLocalRate(1);
          if (autoplayBlocked.current || (!hasPlayed.current && desired.current.isPlaying)) return;
          setPhase('paused');
        }}
        onSeeked={handleSeeked} onEnded={() => { ended.current = true; buffering.current = false; setPlaying(false); setPhase('ended'); setLocalRate(1); }}
        onWaiting={() => { buffering.current = true; setLocalRate(1); setPhase('buffering'); }}
        onError={event => { playRequest.current = null; clearTimeout(playStartTimer.current); ready.current = false; setLocalRate(1); setError(youtubeErrorMessage(event)); setPhase('error'); }} />
    </div>
    {['loading', 'buffering'].includes(phase) && <div className="youtube-loading" role="status"><span className="room-spinner" />{phase === 'loading' ? 'Loading YouTube…' : 'Buffering…'}</div>}
    {phase === 'blocked' && <div className="youtube-feedback" role="status"><p>Press play to join the video.</p><button onClick={joinPlayback}>Join playback</button></div>}
    {error && <div className="youtube-feedback" role="alert"><p>{error}</p><div><button onClick={retry}>Retry</button><a href={state.url} target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a></div></div>}
    <PlaybackControls label="Video" playing={playing} currentTime={currentTime} duration={duration} volume={volume} muted={muted} disabled={phase === 'loading' || phase === 'error' || Boolean(error) || !socket.connected} onTogglePlay={togglePlay} onSeek={seek} onVolumeChange={value => { setVolume(value); setMuted(value === 0); }} onMute={() => { if (muted || volume === 0) { if (volume === 0) setVolume(0.5); setMuted(false); } else setMuted(true); }} note={socket.connected ? 'Playback shared with the room' : 'Reconnecting…'}><button className="player-control" onClick={onClose} aria-label="Close video for everyone" title="Close video for everyone"><FaTimes /></button></PlaybackControls>
  </section>;
}
