import { useRef, useEffect, useState, useImperativeHandle, forwardRef, useCallback } from 'react';
import styled from 'styled-components';

const VideoElement = styled.video`
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #000;
  object-fit: contain;
`;

const Diagnostics = styled.div`
  position: absolute;
  inset: auto 12px 12px;
  width: fit-content;
  max-width: calc(100% - 24px);
  padding: 8px 12px;
  border: 1px solid var(--border, #343843);
  border-radius: 8px;
  background: rgba(10, 13, 20, 0.85);
  color: var(--muted, #a8b1c3);
  font: 11px/1.5 monospace;
  overflow-wrap: anywhere;
  pointer-events: none;
`;

const emptyStats = { chunksAppended: 0, bufferAhead: 0, bufferStart: 0, error: null };

/** Keep this engine mounted while changing room layouts so its buffer survives. */
const MSEPlayer = forwardRef(function MSEPlayer({
  mimeCodec = 'video/mp2t; codecs="avc1.42E01E, mp4a.40.2"',
  onBuffering,
  onBufferFull,
  onStatusChange,
  enabled = true,
  diagnostics = false,
  muted = false,
  volume = 1,
}, ref) {
  const videoRef = useRef(null);
  const mediaSourceRef = useRef(null);
  const sourceBufferRef = useRef(null);
  const queueRef = useRef([]);
  const pendingEndRef = useRef(false);
  const callbacksRef = useRef({ onBuffering, onBufferFull, onStatusChange, diagnostics });
  const desiredPlayingRef = useRef(true);
  const lastStatusRef = useRef('');
  const chunksAppendedRef = useRef(0);
  const lastStatsUpdateRef = useRef(0);
  const [stats, setStats] = useState(emptyStats);
  const [msVersion, setMsVersion] = useState(0);

  useEffect(() => { if (videoRef.current) videoRef.current.volume = Math.max(0, Math.min(1, volume)); }, [volume]);

  // Layout renders often produce new callbacks. They must not recreate MediaSource.
  useEffect(() => {
    callbacksRef.current = { onBuffering, onBufferFull, onStatusChange, diagnostics };
  }, [onBuffering, onBufferFull, onStatusChange, diagnostics]);

  const reportStatus = useCallback((state, message = '') => {
    const key = `${state}:${message}`;
    if (lastStatusRef.current === key) return;
    lastStatusRef.current = key;
    callbacksRef.current.onStatusChange?.({ state, message });
    callbacksRef.current.onBuffering?.(state === 'loading' || state === 'buffering');
  }, []);

  const reportError = useCallback((message) => {
    reportStatus('error', message);
    if (callbacksRef.current.diagnostics) setStats(previous => ({ ...previous, error: message }));
  }, [reportStatus]);

  const tryPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    desiredPlayingRef.current = true;
    return video.play()?.catch(error => {
      if (error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') {
        reportStatus('blocked', 'Press Play to allow video and audio in this browser.');
      } else {
        reportError('Playback could not start. Try reconnecting the stream.');
      }
    });
  }, [reportStatus, reportError]);

  const processQueue = useCallback(function appendNextChunk() {
    const sourceBuffer = sourceBufferRef.current;
    const video = videoRef.current;
    const mediaSource = mediaSourceRef.current;
    if (!sourceBuffer || sourceBuffer.updating || mediaSource?.readyState !== 'open') return;

    if (!queueRef.current.length && pendingEndRef.current) {
      try {
        // EOF belongs after the final asynchronous append, not the final fetch.
        mediaSource.endOfStream();
        pendingEndRef.current = false;
      } catch {
        reportError('The browser could not finish this stream. Try reconnecting.');
      }
      return;
    }

    // Keep two minutes behind the playhead while allowing ongoing streams to run.
    if (video?.buffered.length && video.currentTime - video.buffered.start(0) > 140) {
      try {
        sourceBuffer.remove(0, video.currentTime - 120);
        return;
      } catch {
        // A queued append may still succeed if a range cannot be removed yet.
      }
    }

    if (!queueRef.current.length) return;
    if (video?.buffered.length) {
      const ahead = video.buffered.end(video.buffered.length - 1) - video.currentTime;
      callbacksRef.current.onBufferFull?.(ahead > 120);
    }

    try {
      const chunk = queueRef.current.shift();
      // TS carries absolute timestamps; retain compatibility with offset messages.
      if (chunk?.type === 'offset') {
        appendNextChunk();
        return;
      }
      sourceBuffer.appendBuffer(chunk);
      chunksAppendedRef.current += 1;

      let ahead = 0;
      let start = 0;
      if (video?.buffered.length) {
        start = video.buffered.start(0);
        ahead = video.buffered.end(video.buffered.length - 1) - video.currentTime;
        if (!video.seeking && (video.currentTime < start - 0.2 || (video.currentTime === 0 && start > 0.1))) {
          video.currentTime = start;
        }
      }
      if (callbacksRef.current.diagnostics && Date.now() - lastStatsUpdateRef.current > 500) {
        lastStatsUpdateRef.current = Date.now();
        setStats({ chunksAppended: chunksAppendedRef.current, bufferAhead: ahead.toFixed(1), bufferStart: start.toFixed(2), error: null });
      }
    } catch {
      reportError('The browser could not read this stream. Reconnect or choose a different source.');
    }
  }, [reportError]);

  useEffect(() => {
    if (!enabled) {
      // A stopped movie is a new session on next activation. Focus changes keep
      // enabled=true and therefore retain both the buffer and playback intent.
      queueRef.current = [];
      pendingEndRef.current = false;
      desiredPlayingRef.current = true;
      chunksAppendedRef.current = 0;
      lastStatsUpdateRef.current = 0;
      reportStatus('idle');
      return;
    }
    const video = videoRef.current;
    const MediaSourceClass = globalThis.MediaSource;
    if (!video) return;
    if (!MediaSourceClass || !MediaSourceClass.isTypeSupported(mimeCodec)) {
      reportError('This browser does not support this Jellyfin stream format. Try a browser with MPEG-TS Media Source support, or share your screen instead.');
      return;
    }

    reportStatus('loading', 'Preparing the stream…');
    const mediaSource = new MediaSourceClass();
    const objectUrl = URL.createObjectURL(mediaSource);
    mediaSourceRef.current = mediaSource;
    video.src = objectUrl;
    video.load();
    let sourceBuffer;

    const onBufferError = () => reportError('The stream contains an unsupported or damaged video segment. Try reconnecting.');
    const onSourceOpen = () => {
      try {
        if (sourceBufferRef.current) return;
        sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
        sourceBufferRef.current = sourceBuffer;
        sourceBuffer.addEventListener('updateend', processQueue);
        sourceBuffer.addEventListener('error', onBufferError);
        processQueue();
      } catch {
        reportError('The browser could not prepare this stream format. Try another source or screen sharing.');
      }
    };
    const onWaiting = () => reportStatus('buffering', 'Waiting for more video…');
    const onPlaying = () => reportStatus('playing');
    const onPause = () => {
      if (sourceBufferRef.current && !video.ended) reportStatus('paused');
    };
    const onCanPlay = () => {
      if (desiredPlayingRef.current && video.paused) tryPlay();
    };
    const onEnded = () => reportStatus('ended', 'The stream has ended.');
    const onVideoError = () => reportError('The stream could not be played. Try reconnecting or choose another source.');

    mediaSource.addEventListener('sourceopen', onSourceOpen);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onVideoError);

    return () => {
      mediaSource.removeEventListener('sourceopen', onSourceOpen);
      sourceBuffer?.removeEventListener('updateend', processQueue);
      sourceBuffer?.removeEventListener('error', onBufferError);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onVideoError);
      sourceBufferRef.current = null;
      mediaSourceRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, mimeCodec, msVersion, processQueue, reportStatus, reportError, tryPlay]);

  const resetEngine = useCallback(() => {
    queueRef.current = [];
    pendingEndRef.current = false;
    sourceBufferRef.current = null;
    chunksAppendedRef.current = 0;
    lastStatsUpdateRef.current = 0;
    lastStatusRef.current = '';
    setStats(emptyStats);
    setMsVersion(version => version + 1);
  }, []);

  useImperativeHandle(ref, () => ({
    setTimestampOffset: () => { /* TS parser uses absolute PTS. */ },
    appendChunk: chunk => { queueRef.current.push(chunk); processQueue(); },
    endStream: () => { pendingEndRef.current = true; processQueue(); },
    flush: resetEngine,
    retry: resetEngine,
    getBufferAhead: () => {
      const video = videoRef.current;
      return video?.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0;
    },
    getBufferedRanges: () => {
      const video = videoRef.current;
      return video ? Array.from({ length: video.buffered.length }, (_, index) => ({ start: video.buffered.start(index), end: video.buffered.end(index) })) : [];
    },
    getCurrentTime: () => videoRef.current?.currentTime || 0,
    setCurrentTime: time => { if (videoRef.current) videoRef.current.currentTime = time; },
    play: tryPlay,
    pause: () => { desiredPlayingRef.current = false; videoRef.current?.pause(); },
    getVideoElement: () => videoRef.current,
  }), [processQueue, resetEngine, tryPlay]);

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, position: 'relative' }}>
      <VideoElement ref={videoRef} autoPlay playsInline muted={muted} aria-label="Shared Jellyfin video" />
      {diagnostics && (
        <Diagnostics>
          <div>{stats.chunksAppended} segments · {stats.bufferAhead}s ahead · starts at {stats.bufferStart}s</div>
          <div>{mimeCodec}</div>
          {stats.error && <div>{stats.error}</div>}
        </Diagnostics>
      )}
    </div>
  );
});

export default MSEPlayer;
