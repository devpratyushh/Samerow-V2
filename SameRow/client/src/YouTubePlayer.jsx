import { useCallback, useEffect, useRef, useState } from 'react';
import ReactPlayer from 'react-player';
import { FaTimes } from 'react-icons/fa';
import { playbackTime, youtubeErrorMessage } from './youtube';
import PlaybackControls from './components/PlaybackControls';
import './YouTubePlayer.css';

export default function YouTubePlayer({ state, socket, roomId, onClose, focused = true }) {
  const playerRef = useRef(null);
  const desired = useRef(state);
  const ready = useRef(false);
  const hasPlayed = useRef(false);
  const pendingSeek = useRef(null);
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [currentTime, setCurrentTime] = useState(state.timestamp || 0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!ready.current) { setError('YouTube is taking too long to load. Check your connection or content blocker, then retry.'); setPhase('error'); }
    }, 15000);
    return () => clearTimeout(timeout);
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
  const applyState = () => {
    const player = playerRef.current;
    if (!ready.current || !player) return;
    const target = playbackTime(desired.current);
    if (Math.abs((player.currentTime || 0) - target) > 1) {
      pendingSeek.current = { target, expires: performance.now() + 5000 };
      player.currentTime = target;
      setCurrentTime(target);
    }
    if (desired.current.isPlaying && player.paused) {
      Promise.resolve(player.play()).catch(() => { setPhase('blocked'); setPlaying(false); });
    } else if (!desired.current.isPlaying && !player.paused) player.pause();
  };
  useEffect(() => { desired.current = state; applyState(); }, [state]);
  useEffect(() => {
    const timer = setInterval(() => { if (ready.current) readClock(); }, 500);
    return () => clearInterval(timer);
  }, [readClock]);

  const publish = (isPlaying, force = false, position) => {
    const player = playerRef.current;
    if (!ready.current || !player || error || !socket.connected) return;
    if (!force && desired.current.isPlaying === isPlaying) return;
    const timestamp = position ?? (Number.isFinite(player.currentTime) ? player.currentTime : 0);
    desired.current = { ...desired.current, isPlaying, timestamp, receivedAt: performance.now() };
    socket.emit('youtube-state-change', { roomId, sessionId: state.sessionId, isPlaying, timestamp });
  };
  const seek = position => {
    if (!ready.current || !socket.connected || !playerRef.current) return;
    const target = Math.max(0, Math.min(Number.isFinite(duration) && duration > 0 ? duration : position, position));
    pendingSeek.current = { target, expires: performance.now() + 5000 };
    playerRef.current.currentTime = target;
    setCurrentTime(target);
    publish(desired.current.isPlaying, true, target);
  };
  const handleSeeked = () => {
    const player = playerRef.current;
    const time = player?.currentTime || 0;
    if (pendingSeek.current && Math.abs(time - pendingSeek.current.target) < 2) { pendingSeek.current = null; setCurrentTime(time); return; }
    pendingSeek.current = null;
    if (Math.abs(time - playbackTime(desired.current)) > 1) publish(desired.current.isPlaying, true);
    readClock();
  };
  const togglePlay = () => {
    const player = playerRef.current;
    if (!ready.current || !player || !socket.connected) return;
    if (!player.paused && phase !== 'ended') { player.pause(); publish(false); }
    else {
      if (phase === 'ended') seek(0);
      Promise.resolve(player.play()).then(() => { setPlaying(true); setPhase('playing'); publish(true); }).catch(() => { setPhase('blocked'); setPlaying(false); });
    }
  };
  const retry = () => {
    ready.current = false; hasPlayed.current = false; pendingSeek.current = null;
    setError(''); setPhase('loading'); setAttempt(value => value + 1);
  };

  return <section className="youtube-watch" aria-label="YouTube watch together">
    <div className="youtube-watch-video">
      <ReactPlayer key={attempt} ref={playerRef} src={state.url} width="100%" height="100%" controls={false} muted={!focused || muted} volume={volume} playsInline playbackRate={1} config={{ youtube: { origin: window.location.origin, referrerpolicy: 'strict-origin-when-cross-origin', disablekb: 1, fs: 0 } }}
        onLoadedMetadata={() => { ready.current = true; setError(''); setPhase('ready'); readClock(); applyState(); }}
        onTimeUpdate={readClock} onDurationChange={readClock}
        onPlaying={() => {
          setPlaying(true); setPhase('playing');
          if (!hasPlayed.current && desired.current.isPlaying && Math.abs((playerRef.current?.currentTime || 0) - playbackTime(desired.current)) > 2) applyState();
          hasPlayed.current = true;
          if (!isSeeking()) publish(true);
        }}
        onPause={() => { setPlaying(false); setPhase('paused'); if (!isSeeking()) publish(false); }}
        onSeeked={handleSeeked} onEnded={() => { setPlaying(false); setPhase('ended'); publish(false); }}
        onWaiting={() => setPhase('buffering')}
        onError={event => { ready.current = false; setError(youtubeErrorMessage(event)); setPhase('error'); }} />
    </div>
    {['loading', 'buffering'].includes(phase) && <div className="youtube-loading" role="status"><span className="room-spinner" />{phase === 'loading' ? 'Loading YouTube…' : 'Buffering…'}</div>}
    {phase === 'blocked' && <div className="youtube-feedback" role="status"><p>Press play to join the video.</p><button onClick={togglePlay}>Join playback</button></div>}
    {error && <div className="youtube-feedback" role="alert"><p>{error}</p><div><button onClick={retry}>Retry</button><a href={state.url} target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a></div></div>}
    <PlaybackControls label="Video" playing={playing} currentTime={currentTime} duration={duration} volume={volume} muted={muted} disabled={phase === 'loading' || phase === 'error' || Boolean(error) || !socket.connected} onTogglePlay={togglePlay} onSeek={seek} onVolumeChange={value => { setVolume(value); setMuted(value === 0); }} onMute={() => { if (muted || volume === 0) { if (volume === 0) setVolume(0.5); setMuted(false); } else setMuted(true); }} note={socket.connected ? 'Playback shared with the room' : 'Reconnecting…'}><button className="player-control" onClick={onClose} aria-label="Close video for everyone" title="Close video for everyone"><FaTimes /></button></PlaybackControls>
  </section>;
}
