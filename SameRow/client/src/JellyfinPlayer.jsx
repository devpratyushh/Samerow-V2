import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { FaCog, FaFilm, FaStop } from 'react-icons/fa';
import PlaybackControls from './components/PlaybackControls';
import { jellyfinTime } from './jellyfinRoom';
import { createDriftController } from './playbackSync';
import './JellyfinPlayer.css';
import { useJellyfinQuality } from './useJellyfinQuality';
import JellyfinQuality from './JellyfinQuality';
import { playbackStats } from './playbackStats';
import { hlsFailure, mediaFailure, mediaReadiness } from './playbackDiagnostics';

export default function JellyfinPlayer({ state, base, command, connected, focused, onBrowse, onOpenNative, onPlaybackStats }) {
  const videoRef = useRef(null);
  const [audio, setAudio] = useState(() => state.audioTracks.find(track => track.default)?.index ?? state.audioTracks[0]?.index ?? -1);
  const [subtitle, setSubtitle] = useState(-1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [diagnostics, setDiagnostics] = useState({ stage: 'Requesting playback settings…', lastError: '' });
  const [telemetry, setTelemetry] = useState({ elapsed: 0, buffer: 0, readyState: 0 });
  const startedAt = useRef(performance.now());
  const [time, setTime] = useState(state.timestamp);
  const [attempt, setAttempt] = useState(0);
  const [drift] = useState(createDriftController);
  const loading = useRef(true);
  const blocked = useRef(false);
  const playPending = useRef(false);
  const selectedSubtitle = state.subtitleTracks.find(track => track.index === subtitle);
  const burnSubtitle = selectedSubtitle && !selectedSubtitle.text ? subtitle : -1;
  const root = `${base}/api/jellyfin/${state.accessToken}`;
  const quality = useJellyfinQuality(`${root}/quality`);
  const qualityMode = quality.policy?.mode;
  const maxBitrate = quality.policy?.maxBitrate;
  const [networkBitrate, setNetworkBitrate] = useState(null);
  const [fallback, setFallback] = useState(null);
  const streamKey = `${root}:${audio}:${attempt}:${quality.policy?.revision}`;
  const fallbackReason = qualityMode === 'original' && (
    burnSubtitle !== -1 ? 'These subtitles need to be embedded in the video.' :
    quality.policy.capacityLimited ? 'The shared bandwidth limit is too low for original video.' :
    fallback?.key === streamKey ? fallback.reason : ''
  );
  const original = qualityMode === 'original' && !fallbackReason;
  const audioCodec = state.audioTracks.find(track => track.index === audio)?.codec?.toLowerCase();
  const audioCodecString = { aac: 'mp4a.40.2', mp3: 'mp4a.6B', ac3: 'ac-3', eac3: 'ec-3', opus: 'opus', flac: 'flac' }[audioCodec];
  const audioCopy = Boolean(audioCodecString && globalThis.MediaSource?.isTypeSupported(`audio/mp4; codecs="${audioCodecString}"`));
  const playbackBitrate = original ? 0 : Math.min(maxBitrate || 0, networkBitrate || Infinity);
  const policyReady = Boolean(quality.policy);
  const policyFailed = !policyReady && Boolean(quality.error);
  const retry = () => {
    startedAt.current = performance.now();
    if (!policyReady) quality.retry();
    setAttempt(value => value + 1);
  };
  useEffect(() => {
    const update = () => setTelemetry({ ...playbackStats(videoRef.current), elapsed: Math.floor((performance.now() - startedAt.current) / 1000) });
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
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
  const reportPlayback = useEffectEvent(() => onPlaybackStats?.(playbackStats(videoRef.current)));
  useEffect(() => {
    const timer = setInterval(() => reportPlayback(), 5000);
    return () => clearInterval(timer);
  }, []);
  const initialTime = useEffectEvent(() => jellyfinTime(state));
  useEffect(() => {
    const video = videoRef.current;
    if (!policyReady) return;
    let disposed = false;
    let hls;
    let ready = false;
    let bufferingSince = 0;
    const switchToCompatibleStream = reason => {
      if (!disposed) setFallback({ key: streamKey, reason });
    };
    const adaptiveTimer = setInterval(() => {
      if (!bufferingSince || performance.now() - bufferingSince < 8000 || !ready || video.paused || video.seeking) return;
      const estimate = hls?.bandwidthEstimate;
      if (original) {
        if (Number.isFinite(estimate) && estimate > 0) setNetworkBitrate(Math.max(250000, Math.floor(estimate * 0.7)));
        switchToCompatibleStream('Original video could not keep up with this connection.');
        return;
      }
      if (Number.isFinite(estimate) && estimate > 0 && estimate * 0.7 < playbackBitrate * 0.8) {
        setNetworkBitrate(Math.max(250000, Math.floor(estimate * 0.7)));
        bufferingSince = 0;
      }
    }, 2000);
    loading.current = true; blocked.current = false; drift.reset();
    const reportLoading = () => { startedAt.current = performance.now(); setPhase('loading'); setError(''); setDiagnostics(previous => ({ stage: 'Loading browser player…', lastError: previous.lastError })); };
    reportLoading();
    const url = `${root}/stream.m3u8?audio=${audio}&subtitle=${burnSubtitle}&${original ? `original=1&audioCopy=${audioCopy ? 1 : 0}` : `bitrate=${playbackBitrate}`}`;
    const load = async () => {
      if (!original && video.canPlayType('application/vnd.apple.mpegurl')) {
        setDiagnostics(previous => ({ ...previous, stage: 'Requesting stream playlist…' }));
        video.src = url; video.load();
      } else {
        const { default: Hls } = await import('hls.js');
        if (disposed) return;
        if (!Hls.isSupported()) {
          if (original) switchToCompatibleStream('This browser cannot use the original video player.');
          else { setPhase('error'); setError('This browser cannot play this video. Try a current browser with HLS support.'); }
          return;
        }
        hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 20, maxBufferSize: 40 * 1000 * 1000, startPosition: initialTime(), enableWorker: true });
        const stage = text => { if (!disposed) setDiagnostics(previous => ({ ...previous, stage: text })); };
        hls.on(Hls.Events.MANIFEST_LOADING, () => stage('Requesting stream playlist…'));
        hls.on(Hls.Events.MANIFEST_LOADED, () => stage('Reading stream playlist…'));
        hls.on(Hls.Events.LEVEL_LOADING, () => stage('Requesting media playlist…'));
        hls.on(Hls.Events.FRAG_LOADING, () => stage('Downloading media segment…'));
        hls.on(Hls.Events.FRAG_LOADED, () => stage('Appending media segment…'));
        hls.on(Hls.Events.FRAG_BUFFERED, () => stage('Waiting for browser decoder…'));
        let recovered = false;
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (disposed) return;
          setDiagnostics(previous => ({ ...previous, lastError: hlsFailure(data) }));
          if (!data.fatal) return;
          if (original) { switchToCompatibleStream('Original video could not play on this device.'); return; }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; stage('Recovering browser decoder…'); hls.recoverMediaError(); }
          else { loading.current = true; setPhase('error'); setError('The video connection stopped. Reconnect playback to try again.'); hls.stopLoad(); }
        });
        hls.loadSource(url); hls.attachMedia(video);
      }
    };
    const onReady = () => { ready = true; bufferingSince = 0; loading.current = false; setPhase(video.paused ? 'paused' : 'playing'); synchronize(true); };
    const onPlaying = () => { bufferingSince = 0; loading.current = false; setPhase('playing'); };
    const onWaiting = () => { bufferingSince ||= performance.now(); loading.current = true; if (!blocked.current) setPhase('buffering'); };
    const onError = () => {
      if (video.error) setDiagnostics(previous => ({ ...previous, lastError: mediaFailure(video.error.code) }));
      if (original) switchToCompatibleStream('Original video could not play on this device.');
      else { setPhase('error'); setError('This stream could not be played. Reconnect playback or choose another track.'); }
    };
    const onMetadata = () => setDiagnostics(previous => ({ ...previous, stage: 'Waiting for playable video frames…' }));
    const onPause = () => { if (!loading.current && !blocked.current) setPhase(video.ended ? 'ended' : 'paused'); };
    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('canplay', onReady); video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting); video.addEventListener('error', onError); video.addEventListener('pause', onPause);
    load().catch(() => { if (!disposed) onError(); });
    const timeout = setTimeout(() => {
      if (ready || disposed) return;
      if (original) switchToCompatibleStream('Original video took too long to start.');
      else { setPhase('error'); setError('Jellyfin is taking too long to start. Check the server and reconnect playback.'); }
    }, 30000);
    return () => {
      disposed = true; clearInterval(adaptiveTimer); clearTimeout(timeout); hls?.destroy();
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('canplay', onReady); video.removeEventListener('playing', onPlaying); video.removeEventListener('waiting', onWaiting); video.removeEventListener('error', onError); video.removeEventListener('pause', onPause);
      video.pause(); video.removeAttribute('src'); video.load();
      // The next manifest stops its previous encoding. Release only on full unmount below.
    };
  }, [root, audio, audioCopy, burnSubtitle, attempt, drift, playbackBitrate, original, policyReady, streamKey]);
  useEffect(() => { videoRef.current.volume = volume; }, [volume]);
  const togglePlay = () => {
    if (blocked.current) { blocked.current = false; play(); return; }
    const restart = time >= state.duration - 0.1;
    if (state.playing && !restart) videoRef.current?.pause(); else play();
    command(state.playing && !restart ? 'pause' : 'play');
  };
  const seek = value => { if (videoRef.current) videoRef.current.currentTime = value; setTime(value); command('seek', value); };
  const subtitleUrl = selectedSubtitle?.text ? `${root}/subtitle/${subtitle}` : null;
  return <div className="jellyfin-player" data-phase={phase} data-delivery={original ? 'original' : 'compatible'}>
    <video ref={videoRef} playsInline muted={!focused || muted} aria-label="Shared Jellyfin video" crossOrigin="anonymous">
      {subtitleUrl && <track key={subtitleUrl} kind="subtitles" src={subtitleUrl} srcLang={selectedSubtitle.language || 'und'} label={selectedSubtitle.title} default onLoad={event => { event.target.track.mode = 'showing'; }} />}
    </video>
    {(policyFailed || ['loading', 'buffering', 'blocked', 'error'].includes(phase)) && <div className={`jellyfin-player-status ${phase === 'buffering' ? 'is-buffering' : ''}`} >
      <p role="status">{policyFailed ? quality.error : phase === 'loading' ? !policyReady ? 'Requesting playback settings…' : diagnostics.stage : phase === 'buffering' ? `Buffering · ${diagnostics.stage}` : phase === 'blocked' ? 'Press Play to watch with the room.' : error}</p>
      {phase !== 'blocked' && <>
        <small>{telemetry.elapsed}s elapsed · {Number(telemetry.buffer || 0).toFixed(1)}s buffered</small>
        <details className="jellyfin-playback-details"><summary>Playback details</summary><dl>
          <dt>Last stage</dt><dd>{policyReady ? diagnostics.stage : 'Playback settings request'}</dd>
          <dt>Browser</dt><dd>{mediaReadiness(telemetry.readyState)}</dd>
          <dt>Delivery requested</dt><dd>{!policyReady ? 'Waiting for settings' : original ? 'Original video · fragmented MP4' : 'Compatible HLS'}</dd>
          <dt>Source</dt><dd>{quality.policy?.source?.height ? `${quality.policy.source.height}p` : 'Not reported'}</dd>
          <dt>Audio</dt><dd>{audioCodec || 'Not reported'}</dd>
          <dt>Last error</dt><dd>{policyFailed ? quality.error : diagnostics.lastError || 'None reported'}</dd>
        </dl></details>
      </>}
      {phase === 'blocked' && <button className="sr-button" onClick={() => { blocked.current = false; play(); }}>Play on this device</button>}
      {(policyFailed || phase === 'error') && <button className="sr-button" onClick={retry}>{policyFailed ? 'Retry playback settings' : 'Reconnect playback'}</button>}
    </div>}
    {fallbackReason && <p className="jellyfin-fallback-note" role="status">Using compatible playback. {fallbackReason}</p>}
    <PlaybackControls label="for everyone" playing={state.playing && phase !== 'blocked' && time < state.duration - 0.1} currentTime={time} duration={state.duration} onTogglePlay={togglePlay} onSeek={seek} disabled={!connected || ['loading', 'error'].includes(phase)} volume={volume} muted={muted} onMute={() => setMuted(value => !value)} onVolumeChange={value => { setVolume(value); setMuted(value === 0); }} note={connected ? 'Everyone can control playback' : 'Reconnecting to room…'}>
      <details className="player-track-menu" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary').focus(); event.stopPropagation(); } }}>
        <summary className="player-control" aria-label="Audio and subtitles" title="Audio and subtitles"><FaCog /></summary>
        <div className="player-track-panel">
          <JellyfinQuality {...quality} select={mode => { setNetworkBitrate(null); return quality.select(mode); }} />
          <strong>Audio &amp; subtitles</strong><p>Only changes your playback.</p>
          <label>Audio track<select aria-label="Audio track" value={audio} onChange={event => setAudio(Number(event.target.value))} disabled={!state.audioTracks.length}>{!state.audioTracks.length && <option value="-1">No audio</option>}{state.audioTracks.map(track => <option key={track.index} value={track.index}>{track.title}</option>)}</select></label>
          <label>Subtitles<select aria-label="Subtitles" value={subtitle} onChange={event => setSubtitle(Number(event.target.value))}><option value="-1">Off</option>{state.subtitleTracks.map(track => <option key={track.index} value={track.index}>{track.title}{!track.text ? ' (video subtitles)' : ''}</option>)}</select></label>
          {onOpenNative && <button className="sr-button" onClick={onOpenNative}>Open Jellyfin Web player</button>}
          <button className="sr-button" onClick={event => { event.currentTarget.closest('details').open = false; }}>Done</button>
        </div>
      </details>
      {onBrowse && <button className="player-control" onClick={onBrowse} title="Browse Jellyfin library" aria-label="Browse Jellyfin library"><FaFilm /></button>}
      <button className="player-control" aria-label="Stop movie for everyone" title="Stop movie for everyone" onClick={() => command('stop')} disabled={!connected}><FaStop /></button>
    </PlaybackControls>
  </div>;
}
