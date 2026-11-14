import { useJellyfinRecovery } from './useJellyfinRecovery';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { FaCog, FaFilm, FaStop } from 'react-icons/fa';
import PlaybackControls from './components/PlaybackControls';
import { jellyfinTime } from './jellyfinRoom';
import { createDriftController } from './playbackSync';
import './JellyfinPlayer.css';
import { useJellyfinQuality } from './useJellyfinQuality';
import JellyfinQuality from './JellyfinQuality';
import { playbackStats } from './playbackStats';
import { createPlaybackNetwork, diagnosticLoader, networkDiagnosis } from './playbackNetwork';
import PlaybackNetworkDetails from './components/PlaybackNetworkDetails';
import PlayerNerdStats from './components/PlayerNerdStats';
import { hlsFailure, mediaFailure, mediaReadiness } from './playbackDiagnostics';
import { createDirectMedia, directLoader } from './directMedia';

export default function JellyfinPlayer({ state, base, socket, command, connected, focused, onBrowse, onOpenNative, onPlaybackStats, onJoinStatus }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const networkRef = useRef(null);
  const [directPeer, setDirectPeer] = useState(null);
  const [relayReason, setRelayReason] = useState(() => state.direct && !globalThis.RTCPeerConnection ? 'WebRTC is unavailable in this browser' : '');
  const relayReasonForSession = useRef(relayReason);
  const [transportStatus, setTransportStatus] = useState('');
  const [subtitleBlob, setSubtitleBlob] = useState(null);
  const firstFrame = useRef(null);
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
  const pendingRoomSeek = useRef(true);
  const blocked = useRef(false);
  const playPending = useRef(false);
  const queuedSeek = useRef(null);
  const seekTimer = useRef(null);
  const recoveredAt = useRef(-Infinity);
  const selectedSubtitle = state.subtitleTracks.find(track => track.index === subtitle);
  const burnSubtitle = selectedSubtitle && !selectedSubtitle.text ? subtitle : -1;
  const root = `${base}/api/jellyfin/${state.accessToken}`;
  const sessionId = state.sessionId;
  const accessToken = state.accessToken;
  const preferDirect = Boolean(state.direct && socket && globalThis.RTCPeerConnection && !relayReason);
  // A capacity change should only affect a new playback request.
  const quality = useJellyfinQuality(`${root}/quality${preferDirect ? '?direct=1' : ''}`);
  const qualityMode = quality.policy?.mode;
  const maxBitrate = quality.policy?.maxBitrate;
  const qualitySourceBitrate = quality.policy?.source?.bitrate;
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
  const unlock = () => { blocked.current = false; play(); };
  const recovery = useJellyfinRecovery(`${root}/health`, () => {
    const video = videoRef.current;
    if ((phase === 'playing' || phase === 'paused') && video?.readyState >= 3 && !loading.current) return;
    retry();
  });
  useEffect(() => {
    let disposed = false;
    const update = async () => {
      const direct = await directPeer?.snapshot();
      if (!disposed) setTelemetry({ ...playbackStats(videoRef.current), network: networkRef.current?.snapshot(), direct,
        firstFrame: firstFrame.current, elapsed: Math.floor((performance.now() - startedAt.current) / 1000) });
    };
    update();
    const timer = setInterval(update, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [directPeer]);
  useEffect(() => {
    if (!directPeer || !selectedSubtitle?.text) return;
    const controller = new AbortController();
    let url;
    directPeer.request(`subtitle/${subtitle}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(new Blob([result.data], { type: 'text/vtt' }));
      setSubtitleBlob({ peer: directPeer, index: subtitle, url });
    }).catch(() => {});
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [directPeer, selectedSubtitle?.text, subtitle]);
  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video || playPending.current || blocked.current) return;
    playPending.current = true;
    Promise.resolve(video.play()).catch(err => {
      if (err.name === 'NotAllowedError') { blocked.current = true; setPhase('blocked'); }
    }).finally(() => { playPending.current = false; });
  }, []);
  const synchronize = useEffectEvent((force = false) => {
    if (force) pendingRoomSeek.current = true;
    const video = videoRef.current;
    if (!video || !connected) return;
    const target = jellyfinTime(state);
    if (!state.playing) video.pause();
    // Metadata is enough to retarget a stream that is buffering after a track change.
    // Waiting for canplay here leaves HLS fetching the obsolete room position.
    if (video.readyState < 1) return;
    // Never repeatedly seek past the final frame and restart an ended video.
    if (video.ended && target >= state.duration - 0.3) {
      onJoinStatus?.({ phase: 'ready', state });
      return;
    }
    const now = performance.now();
    const recovering = state.playing && now - recoveredAt.current < 1500;
    let bufferedTarget = false;
    if (recovering) {
      const buffered = video.buffered;
      for (let index = 0; index < buffered.length; index++) {
        if (target >= buffered.start(index) && target + 0.25 <= buffered.end(index)) bufferedTarget = true;
      }
    }
    const suspended = video.seeking || queuedSeek.current !== null ||
      (!pendingRoomSeek.current && (loading.current || (recovering && !bufferedTarget)));
    const correction = drift.correction({ currentTime: video.currentTime, target, playing: state.playing, now, force: pendingRoomSeek.current, suspended, rates: [0.97, 1, 1.03] });
    if (!suspended) pendingRoomSeek.current = false;
    video.playbackRate = correction.rate;
    if (correction.seek !== undefined) video.currentTime = Math.min(correction.seek, Math.max(0, state.duration - 0.05));
    if (state.playing && video.paused && !blocked.current && !loading.current) play();
    if (onJoinStatus && !video.seeking && correction.seek === undefined && Math.abs(target - video.currentTime) <= 0.75 &&
      video.readyState >= (state.playing ? 3 : 2) && !loading.current && video.paused === !state.playing) {
      onJoinStatus({ phase: 'ready', state });
    }
  });
  const reportJoinStatus = useEffectEvent(() => {
    if (policyFailed || phase === 'error') onJoinStatus?.({ phase: 'error', state, retry });
    else if (phase === 'blocked') onJoinStatus?.({ phase: 'blocked', state, retry: unlock });
    else onJoinStatus?.({ phase: 'loading', state });
  });
  useEffect(() => { reportJoinStatus(); }, [phase, policyFailed, state.sessionId, state.revision]);
  useEffect(() => { synchronize(true); }, [state.revision, state.sessionId, connected]);
  useEffect(() => {
    const timer = setInterval(() => { synchronize(); if (videoRef.current && queuedSeek.current === null) setTime(videoRef.current.currentTime); }, 400);
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
    const abort = new AbortController();
    let peer;
    let validated = false;
    let recoveryAttempts = 0;
    let hls;
    let ready = false;
    let bufferingSince = 0;
    let decoderTimeout;
    const switchToCompatibleStream = reason => {
      if (!disposed) setFallback({ key: streamKey, reason });
    };
    const switchToRelay = reason => {
      if (disposed || relayReasonForSession.current) return;
      relayReasonForSession.current = reason;
      peer?.close();
      setDirectPeer(null);
      setTransportStatus('Switching to HTTPS relay…');
      setRelayReason(reason);
    };
    const adaptiveTimer = setInterval(() => {
      if (!bufferingSince || performance.now() - bufferingSince < 8000 || !ready || video.paused || video.seeking) return;
      const estimate = hls?.bandwidthEstimate;
      if (validated) {
        const levelBitrate = hls?.levels[hls.currentLevel]?.bitrate;
        const target = original ? sourceBitrate : levelBitrate;
        if (performance.now() - bufferingSince >= 16000 && peer.isSlowFor(target)) {
          switchToRelay('Direct throughput could not keep up with playback');
        }
        return;
      }
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
    networkRef.current = createPlaybackNetwork(undefined, preferDirect ? 'webrtc' : 'https');
    firstFrame.current = null;
    loading.current = true; blocked.current = false; recoveredAt.current = -Infinity; drift.reset();
    const reportLoading = () => { startedAt.current = performance.now(); setPhase('loading'); setError(''); setDiagnostics(previous => ({ stage: 'Loading browser player…', lastError: previous.lastError })); };
    reportLoading();
    const url = `${root}/stream.m3u8?audio=${audio}&subtitle=${burnSubtitle}&${original ? `original=1&audioCopy=${audioCopy ? 1 : 0}` : `bitrate=${playbackBitrate}`}`;
    const sourceBitrate = qualitySourceBitrate;
    const load = async () => {
      let directManifest;
      if (preferDirect) {
        setTransportStatus('Connecting to home Jellyfin…');
        const { default: Hls } = await import('hls.js');
        if (disposed) return;
        if (!Hls.isSupported()) { switchToRelay('This browser uses HTTPS HLS'); return; }
        const settings = Object.fromEntries(new URL(url, window.location.href).searchParams);
        for (let retry = 0; retry < 2; retry++) {
          try {
            peer = createDirectMedia(socket, { sessionId, accessToken }, value => { if (!disposed) setTransportStatus(value); }, reason => {
              if (validated) switchToRelay(reason);
            });
            await peer.connect(settings, abort.signal);
            directManifest = await peer.request('manifest', { timeout: 10000, signal: abort.signal });
            if (!/^#EXTM3U\b/.test(new TextDecoder().decode(directManifest.data))) throw new Error('Invalid Jellyfin playlist');
            if (disposed) return;
            validated = true;
            setDirectPeer(peer);
            setTransportStatus('Direct WebRTC connected');
            break;
          } catch (error) {
            peer?.close();
            if (disposed) return;
            if (error.code === 409 && original) { switchToCompatibleStream('Original video is unavailable for these playback settings.'); return; }
            if (retry || error.code || error.message === 'Home sender unavailable') {
              switchToRelay(error.code ? `Direct media returned HTTP ${error.code}` : error.message === 'Home sender unavailable' ? 'Home sender unavailable' : 'Direct media validation failed');
              return;
            }
            setTransportStatus('Retrying direct connection…');
          }
        }
      } else if (relayReason) {
        setTransportStatus('Connecting to HTTPS relay…');
      }
      if (!validated && !original && video.canPlayType('application/vnd.apple.mpegurl')) {
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
        const loader = validated ? directLoader(peer, url, directManifest) : Hls.DefaultConfig.loader;
        hls = new Hls({ loader: diagnosticLoader(loader, networkRef.current), maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 20, maxBufferSize: 40 * 1000 * 1000, startPosition: initialTime(), enableWorker: true });
        hlsRef.current = hls;
        const stage = text => { if (!disposed) setDiagnostics(previous => ({ ...previous, stage: text })); };
        hls.on(Hls.Events.MANIFEST_LOADING, () => stage('Requesting stream playlist…'));
        hls.on(Hls.Events.MANIFEST_LOADED, () => stage('Reading stream playlist…'));
        hls.on(Hls.Events.LEVEL_LOADING, () => stage('Requesting media playlist…'));
        hls.on(Hls.Events.FRAG_LOADING, () => stage('Downloading media segment…'));
        hls.on(Hls.Events.FRAG_LOADED, () => stage('Appending media segment…'));
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          stage('Waiting for browser decoder…');
          if (validated && original && !ready && !decoderTimeout && video.buffered.length) {
            decoderTimeout = setTimeout(() => {
              if (!ready && !disposed && video.readyState < 2) {
                switchToCompatibleStream('The browser could not decode the original stream in time.');
              }
            }, 12000);
          }
        });
        let recovered = false;
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (disposed) return;
          setDiagnostics(previous => ({ ...previous, lastError: hlsFailure(data) }));
          if (!data.fatal) return;
          if (!validated && data.response?.code === 429) {
            setPhase('error');
            setError('The HTTPS relay is at its daily bandwidth limit. Try later or ask the server owner to check the direct connection.');
            hls.stopLoad();
            return;
          }
          const status = data.response?.code;
          if (validated && data.type === Hls.ErrorTypes.NETWORK_ERROR && (!status || status === 408 || status === 502 || status === 503 || status === 504)) {
            if (recoveryAttempts++ === 0) { hls.startLoad(initialTime()); return; }
            switchToRelay('Direct media requests stopped completing'); return;
          }
          if (original) { switchToCompatibleStream('Original video could not play on this device.'); return; }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; stage('Recovering browser decoder…'); hls.recoverMediaError(); }
          else { loading.current = true; setPhase('error'); setError('The video connection stopped. Reconnect playback to try again.'); hls.stopLoad(); }
        });
        hls.loadSource(url); hls.attachMedia(video);
      }
    };
    const onReady = () => {
      clearTimeout(decoderTimeout);
      if (bufferingSince) recoveredAt.current = performance.now();
      ready = true; bufferingSince = 0; loading.current = false;
      setPhase(video.paused ? 'paused' : 'playing');
      if (!validated && relayReason) setTransportStatus('HTTPS relay connected');
      synchronize();
    };
    const onPlaying = () => { bufferingSince = 0; loading.current = false; setPhase('playing'); };
    const onWaiting = () => { bufferingSince ||= performance.now(); loading.current = true; if (!blocked.current) setPhase('buffering'); };
    const onError = () => {
      if (video.error) setDiagnostics(previous => ({ ...previous, lastError: mediaFailure(video.error.code) }));
      if (original) switchToCompatibleStream('Original video could not play on this device.');
      else { setPhase('error'); setError('This stream could not be played. Reconnect playback or choose another track.'); }
    };
    const onMetadata = () => { setDiagnostics(previous => ({ ...previous, stage: 'Waiting for playable video frames…' })); synchronize(true); };
    const onPause = () => { if (!loading.current && !blocked.current) setPhase(video.ended ? 'ended' : 'paused'); };
    video.addEventListener('loadedmetadata', onMetadata);
    const markFrame = () => { firstFrame.current ??= performance.now() - startedAt.current; };
    const frameCallback = video.requestVideoFrameCallback?.(markFrame);
    if (frameCallback === undefined) video.addEventListener('loadeddata', markFrame);
    video.addEventListener('canplay', onReady); video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting); video.addEventListener('error', onError); video.addEventListener('pause', onPause);
    load().catch(() => { if (!disposed) onError(); });
    const timeout = setTimeout(() => {
      if (ready || disposed) return;
      if (preferDirect && !validated) { switchToRelay('Direct startup timed out'); return; }
      if (original) switchToCompatibleStream('Original video took too long to start.');
      else { setPhase('error'); setError('Jellyfin is taking too long to start. Check the server and reconnect playback.'); }
    }, preferDirect ? 50000 : 30000);
    return () => {
      disposed = true; clearInterval(adaptiveTimer); clearTimeout(timeout); clearTimeout(decoderTimeout); abort.abort(); hls?.destroy(); hlsRef.current = null;
      setDirectPeer(current => current === peer ? null : current);
      if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
      video.removeEventListener('loadeddata', markFrame);
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('canplay', onReady); video.removeEventListener('playing', onPlaying); video.removeEventListener('waiting', onWaiting); video.removeEventListener('error', onError); video.removeEventListener('pause', onPause);
      video.pause(); video.removeAttribute('src'); video.load();
      // The next manifest stops its previous encoding. Release only on full unmount below.
    };
  }, [root, audio, audioCopy, burnSubtitle, attempt, drift, playbackBitrate, original, policyReady, streamKey,
    preferDirect, relayReason, socket, accessToken, sessionId, qualitySourceBitrate]);
  useEffect(() => { videoRef.current.volume = volume; }, [volume]);
  useEffect(() => () => {
    clearTimeout(seekTimer.current);
    queuedSeek.current = null;
  }, [root, connected]);
  const commitSeek = () => {
    clearTimeout(seekTimer.current);
    const value = queuedSeek.current;
    queuedSeek.current = null;
    if (value === null || !command) return;
    if (videoRef.current) videoRef.current.currentTime = value;
    command('seek', value);
  };
  const togglePlay = () => {
    if (blocked.current) { blocked.current = false; play(); return; }
    const restart = (queuedSeek.current ?? time) >= state.duration - 0.1;
    commitSeek();
    if (state.playing && !restart) videoRef.current?.pause(); else play();
    command?.(state.playing && !restart ? 'pause' : 'play');
  };
  const seek = value => {
    queuedSeek.current = value;
    setTime(value);
    clearTimeout(seekTimer.current);
    seekTimer.current = setTimeout(commitSeek, 180);
  };
  const subtitleUrl = selectedSubtitle?.text ? preferDirect
    ? subtitleBlob?.peer === directPeer && subtitleBlob?.index === subtitle ? subtitleBlob.url : null
    : `${root}/subtitle/${subtitle}` : null;
  return <div className="jellyfin-player" data-phase={phase} data-delivery={original ? 'original' : 'compatible'} data-transport={preferDirect ? directPeer ? 'webrtc' : 'connecting' : 'https'}>
    {recovery && <p className="jellyfin-recovery" role="status">{recovery}</p>}
    <video ref={videoRef} playsInline muted={!focused || muted} aria-label="Shared Jellyfin video" crossOrigin="anonymous">
      {subtitleUrl && <track key={subtitleUrl} kind="subtitles" src={subtitleUrl} srcLang={selectedSubtitle.language || 'und'} label={selectedSubtitle.title} default onLoad={event => { event.target.track.mode = 'showing'; }} />}
    </video>
    {(policyFailed || ['loading', 'buffering', 'blocked', 'error'].includes(phase)) && <div className={`jellyfin-player-status ${phase === 'buffering' ? 'is-buffering' : ''}`} >
      <p role="status">{policyFailed ? quality.error : phase === 'loading' ? !policyReady ? 'Requesting playback settings…' : transportStatus && !directPeer ? transportStatus : diagnostics.stage : phase === 'buffering' ? `Buffering · ${diagnostics.stage}` : phase === 'blocked' ? 'Press Play to watch with the room.' : error}</p>
      {phase !== 'blocked' && <>
        <small>{telemetry.elapsed}s elapsed · {Number(telemetry.buffer || 0).toFixed(1)}s buffered</small>
        <p className="jellyfin-network-status">{telemetry.network?.requests?.length ? networkDiagnosis(telemetry.network) : !policyReady ? 'Waiting for playback settings from the media gateway.' : 'Starting the browser media engine. Native HLS request timing may be unavailable.'}</p>
        <details className="jellyfin-playback-details"><summary>Playback &amp; network details</summary><dl>
          <dt>Last stage</dt><dd>{policyReady ? diagnostics.stage : 'Playback settings request'}</dd>
          <dt>Browser</dt><dd>{mediaReadiness(telemetry.readyState)}</dd>
          <dt>Delivery requested</dt><dd>{!policyReady ? 'Waiting for settings' : original ? 'Original video · fragmented MP4' : 'Compatible HLS'}</dd>
          <dt>Source</dt><dd>{quality.policy?.source?.height ? `${quality.policy.source.height}p` : 'Not reported'}</dd>
          <dt>Audio</dt><dd>{audioCodec || 'Not reported'}</dd>
          <dt>Last error</dt><dd>{policyFailed ? quality.error : diagnostics.lastError || 'None reported'}</dd>
        </dl><PlaybackNetworkDetails network={telemetry.network} endpoint={root} /></details>
      </>}
      {phase === 'blocked' && <button className="sr-button" onClick={() => { blocked.current = false; play(); }}>Play on this device</button>}
      {(policyFailed || phase === 'error') && <button className="sr-button" onClick={retry}>{policyFailed ? 'Retry playback settings' : 'Reconnect playback'}</button>}
    </div>}
    {fallbackReason && <p className="jellyfin-fallback-note" role="status">Using compatible playback. {fallbackReason}</p>}
    <PlaybackControls docked label="for everyone" playing={state.playing && phase !== 'blocked' && time < state.duration - 0.1} currentTime={time} duration={state.duration} onTogglePlay={togglePlay} onSeek={seek} disabled={!command || ['loading', 'error'].includes(phase)} volume={volume} muted={muted} onMute={() => setMuted(value => !value)} onVolumeChange={value => { setVolume(value); setMuted(value === 0); }} note={connected ? transportStatus || 'Everyone can control playback' : 'Reconnecting to room…'}>
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
    <button className="player-control" aria-label="Stop movie for everyone" title="Stop movie for everyone" onClick={() => command?.('stop')} disabled={!command}><FaStop /></button>
    </PlaybackControls>
    <PlayerNerdStats network={telemetry.network} endpoint={root} videoRef={videoRef} hlsRef={hlsRef} policy={quality.policy} phase={policyFailed ? 'error' : phase}
      transport={transportStatus || 'HTTPS'} transportError={relayReason || telemetry.direct?.lastError} direct={telemetry.direct} firstFrame={telemetry.firstFrame}
      stage={policyReady ? diagnostics.stage : 'Playback settings request'} failure={policyFailed ? quality.error : diagnostics.lastError || error}
      delivery={policyReady ? original ? 'Original video · fragmented MP4' : 'Compatible HLS' : 'Waiting for settings'}
      audio={state.audioTracks.find(track => track.index === audio)?.title || 'No audio'} subtitle={selectedSubtitle?.title || 'Off'}
      targetTime={() => jellyfinTime(state)} />
  </div>;
}
