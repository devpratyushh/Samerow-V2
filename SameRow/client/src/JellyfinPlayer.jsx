import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { FaCog, FaStop } from 'react-icons/fa';
import PlaybackControls from './components/PlaybackControls';
import { jellyfinTime } from './jellyfinRoom';
import { createDriftController } from './playbackSync';
import './JellyfinPlayer.css';

export default function JellyfinPlayer({ state, base, command, connected, focused }) {
  const videoRef = useRef(null);
  const [audio, setAudio] = useState(() => state.audioTracks.find(track => track.default)?.index ?? state.audioTracks[0]?.index ?? -1);
  const [subtitle, setSubtitle] = useState(-1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [time, setTime] = useState(state.timestamp);
  const [attempt, setAttempt] = useState(0);
  const [drift] = useState(createDriftController);
  const loading = useRef(true);
  const blocked = useRef(false);
  const playPending = useRef(false);
  const selectedSubtitle = state.subtitleTracks.find(track => track.index === subtitle);
  const burnSubtitle = selectedSubtitle && !selectedSubtitle.text ? subtitle : -1;
  const root = `${base}/api/jellyfin/${state.accessToken}`;
  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video || playPending.current || blocked.current) return;
    playPending.current = true;
    Promise.resolve(video.play()).catch(err => {
      if (err.name === 'NotAllowedError') { blocked.current = true; setPhase('blocked'); }
    }).finally(() => { playPending.current = false; });
  }, []);
  const synchronize = useEffectEvent((force = false) => {
    const video = videoRef.current;
    if (!video || !connected) return;
    const target = jellyfinTime(state);
    if (!state.playing) video.pause();
    if (loading.current || video.readyState < 1) return;
    // Never repeatedly seek past the final frame and restart an ended video.
    if (video.ended && target >= state.duration - 0.3) return;
    const correction = drift.correction({ currentTime: video.currentTime, target, playing: state.playing, now: performance.now(), force, suspended: video.seeking, rates: [0.97, 1, 1.03] });
    video.playbackRate = correction.rate;
    if (correction.seek !== undefined) video.currentTime = Math.min(correction.seek, Math.max(0, state.duration - 0.05));
    if (state.playing && video.paused && !blocked.current) play();
  });
  useEffect(() => { synchronize(true); }, [state.revision, state.sessionId, connected]);
  useEffect(() => {
    const timer = setInterval(() => { synchronize(); if (videoRef.current) setTime(videoRef.current.currentTime); }, 400);
    return () => clearInterval(timer);
  }, []);
  const initialTime = useEffectEvent(() => jellyfinTime(state));
  useEffect(() => {
    const video = videoRef.current;
    let disposed = false;
    let hls;
    let ready = false;
    loading.current = true; blocked.current = false; drift.reset();
    const reportLoading = () => { setPhase('loading'); setError(''); };
    reportLoading();
    const url = `${root}/stream.m3u8?audio=${audio}&subtitle=${burnSubtitle}`;
    const load = async () => {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url; video.load();
      } else {
        const { default: Hls } = await import('hls.js');
        if (disposed) return;
        if (!Hls.isSupported()) { setPhase('error'); setError('This browser cannot play this video. Try a current browser with HLS support.'); return; }
        hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 20, maxBufferSize: 40 * 1000 * 1000, startPosition: initialTime(), enableWorker: true });
        let recovered = false;
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal || disposed) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); }
          else { loading.current = true; setPhase('error'); setError('The video connection stopped. Reconnect playback to try again.'); hls.stopLoad(); }
        });
        hls.loadSource(url); hls.attachMedia(video);
      }
    };
    const onReady = () => { ready = true; loading.current = false; synchronize(true); };
    const onPlaying = () => { loading.current = false; setPhase('playing'); };
    const onWaiting = () => { loading.current = true; if (!blocked.current) setPhase('buffering'); };
    const onError = () => { setPhase('error'); setError('This stream could not be played. Reconnect playback or choose another track.'); };
    const onPause = () => { if (!loading.current && !blocked.current) setPhase(video.ended ? 'ended' : 'paused'); };
    video.addEventListener('canplay', onReady); video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting); video.addEventListener('error', onError); video.addEventListener('pause', onPause);
    load().catch(() => { if (!disposed) { setPhase('error'); setError('The video player could not load. Try reconnecting playback.'); } });
    const timeout = setTimeout(() => { if (!ready && !disposed) { setPhase('error'); setError('Jellyfin is taking too long to start. Check the server and reconnect playback.'); } }, 30000);
    return () => {
      disposed = true; clearTimeout(timeout); hls?.destroy();
      video.removeEventListener('canplay', onReady); video.removeEventListener('playing', onPlaying); video.removeEventListener('waiting', onWaiting); video.removeEventListener('error', onError); video.removeEventListener('pause', onPause);
      video.pause(); video.removeAttribute('src'); video.load();
      // The next manifest stops its previous encoding. Release only on full unmount below.
    };
  }, [root, audio, burnSubtitle, attempt, drift]);
  useEffect(() => () => { fetch(`${root}/release`, { method: 'POST', keepalive: true }).catch(() => {}); }, [root]);
  useEffect(() => { videoRef.current.volume = volume; }, [volume]);
  const togglePlay = () => {
    if (blocked.current) { blocked.current = false; play(); return; }
    const restart = time >= state.duration - 0.1;
    if (state.playing && !restart) videoRef.current?.pause(); else play();
    command(state.playing && !restart ? 'pause' : 'play');
  };
  const seek = value => { if (videoRef.current) videoRef.current.currentTime = value; setTime(value); command('seek', value); };
  const subtitleUrl = selectedSubtitle?.text ? `${root}/subtitle/${subtitle}` : null;
  return <div className="jellyfin-player" data-phase={phase}>
    <video ref={videoRef} playsInline muted={!focused || muted} aria-label="Shared Jellyfin video" crossOrigin="anonymous">
      {subtitleUrl && <track key={subtitleUrl} kind="subtitles" src={subtitleUrl} srcLang={selectedSubtitle.language || 'und'} label={selectedSubtitle.title} default onLoad={event => { event.target.track.mode = 'showing'; }} />}
    </video>
    {['loading', 'buffering', 'blocked', 'error'].includes(phase) && <div className={`jellyfin-player-status ${phase === 'buffering' ? 'is-buffering' : ''}`} role="status">
      <p>{phase === 'loading' ? 'Preparing the stream…' : phase === 'buffering' ? 'Buffering…' : phase === 'blocked' ? 'Press Play to watch with the room.' : error}</p>
      {phase === 'blocked' && <button className="sr-button" onClick={() => { blocked.current = false; play(); }}>Play on this device</button>}
      {phase === 'error' && <button className="sr-button" onClick={() => setAttempt(value => value + 1)}>Reconnect playback</button>}
    </div>}
    <PlaybackControls label="for everyone" playing={state.playing && phase !== 'blocked' && time < state.duration - 0.1} currentTime={time} duration={state.duration} onTogglePlay={togglePlay} onSeek={seek} disabled={!connected || ['loading', 'error'].includes(phase)} volume={volume} muted={muted} onMute={() => setMuted(value => !value)} onVolumeChange={value => { setVolume(value); setMuted(value === 0); }} note={connected ? 'Everyone can control playback' : 'Reconnecting to room…'}>
      <details className="player-track-menu" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary').focus(); event.stopPropagation(); } }}>
        <summary className="player-control" aria-label="Audio and subtitles" title="Audio and subtitles"><FaCog /></summary>
        <div className="player-track-panel">
          <strong>Audio &amp; subtitles</strong><p>Only changes your playback.</p>
          <label>Audio track<select aria-label="Audio track" value={audio} onChange={event => setAudio(Number(event.target.value))} disabled={!state.audioTracks.length}>{!state.audioTracks.length && <option value="-1">No audio</option>}{state.audioTracks.map(track => <option key={track.index} value={track.index}>{track.title}</option>)}</select></label>
          <label>Subtitles<select aria-label="Subtitles" value={subtitle} onChange={event => setSubtitle(Number(event.target.value))}><option value="-1">Off</option>{state.subtitleTracks.map(track => <option key={track.index} value={track.index}>{track.title}{!track.text ? ' (video subtitles)' : ''}</option>)}</select></label>
          <button className="sr-button" onClick={event => { event.currentTarget.closest('details').open = false; }}>Done</button>
        </div>
      </details>
      <button className="player-control" aria-label="Stop movie for everyone" title="Stop movie for everyone" onClick={() => command('stop')} disabled={!connected}><FaStop /></button>
    </PlaybackControls>
  </div>;
}
