import React, { useRef, useEffect, useState, useImperativeHandle, forwardRef, useCallback } from 'react';
import styled, { keyframes } from 'styled-components';

const VideoElement = styled.video`
  width: 100%;
  height: 100%;
  background: #000;
  object-fit: contain;
`;

const Overlay = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 10px;
  background: linear-gradient(to bottom, rgba(0,0,0,0.7), transparent);
  color: #0f0;
  font-family: monospace;
  font-size: 11px;
  pointer-events: none;
  z-index: 10;
  text-align: center;
`;

const spinAnimation = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const SpinnerContainer = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
`;

const SpinnerRing = styled.div`
  width: 48px;
  height: 48px;
  border: 4px solid rgba(255,255,255,0.2);
  border-top: 4px solid #0a84ff;
  border-radius: 50%;
  animation: ${spinAnimation} 0.8s linear infinite;
`;

const Spinner = () => (
  <SpinnerContainer>
    <SpinnerRing />
    <span style={{ color: 'white', fontSize: '13px', fontWeight: 500 }}>Buffering...</span>
  </SpinnerContainer>
);

const MSEPlayer = forwardRef(({ mimeCodec = 'video/mp2t; codecs="avc1.42E01E, mp4a.40.2"', onBuffering, onBufferFull }, ref) => {
  const videoRef = useRef(null);
  const mediaSourceRef = useRef(null);
  const sourceBufferRef = useRef(null);
  const queueRef = useRef([]);
  const [isReady, setIsReady] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [stats, setStats] = useState({ chunksAppended: 0, bufferAhead: 0, bufferStart: 0, error: null });
  // Increment this to force a full MediaSource recreation
  const [msVersion, setMsVersion] = useState(0);

  // Ref for throttling stats updates to prevent React render thrashing (flickering)
  const lastStatsUpdateRef = useRef(0);

  const chunksAppendedRef = useRef(0);

  const processQueue = useCallback(() => {
    const sb = sourceBufferRef.current;
    if (!sb || sb.updating) return;
    if (!mediaSourceRef.current || mediaSourceRef.current.readyState !== 'open') return;

    // GARBAGE COLLECTION: Delete buffers older than 120s trailing
    if (videoRef.current && videoRef.current.buffered.length > 0) {
      const currentTime = videoRef.current.currentTime;
      const start = videoRef.current.buffered.start(0);
      if (currentTime - start > 140) {
        try {
          sb.remove(0, currentTime - 120);
          return;
        } catch (e) {
          console.error("Garbage collection error:", e);
        }
      }
    }

    if (queueRef.current.length === 0) return;

    // Backpressure signal
    if (videoRef.current && videoRef.current.buffered.length > 0) {
      const bufferedEnd = videoRef.current.buffered.end(videoRef.current.buffered.length - 1);
      const currentTime = videoRef.current.currentTime;
      if (bufferedEnd - currentTime > 120) {
        if (onBufferFull) onBufferFull(true);
      } else {
        if (onBufferFull) onBufferFull(false);
      }
    }

    try {
      const chunk = queueRef.current.shift();
      if (chunk && chunk.type === 'offset') {
        processQueue();
        return;
      }
      sb.appendBuffer(chunk);
      chunksAppendedRef.current += 1;

      // We still update the physical DOM playhead if stuck, but we throttle the React state update
      let ahead = 0;
      let start = 0;
      if (videoRef.current && videoRef.current.buffered.length > 0) {
        start = videoRef.current.buffered.start(0);
        ahead = videoRef.current.buffered.end(videoRef.current.buffered.length - 1) - videoRef.current.currentTime;

        // Auto-seek to buffer start if playhead is stuck before it
        // IMPORTANT: Must check !videoRef.current.seeking to prevent infinite seek-abort loops!
        if (!videoRef.current.seeking && (videoRef.current.currentTime < start - 0.2 || (videoRef.current.currentTime === 0 && start > 0.1))) {
          console.log(`Auto-seeking to ${start} (was at ${videoRef.current.currentTime})`);
          videoRef.current.currentTime = start;
        }
      }

      const now = Date.now();
      // Only trigger a React re-render every 500ms to prevent video flickering/frame drops
      if (now - lastStatsUpdateRef.current > 500) {
        lastStatsUpdateRef.current = now;
        setStats({
          chunksAppended: chunksAppendedRef.current,
          bufferAhead: ahead.toFixed(1),
          bufferStart: start.toFixed(2),
          error: null
        });
      }
    } catch (e) {
      console.error("Failed to append buffer:", e);
      setStats({ chunksAppended: chunksAppendedRef.current, bufferAhead: 0, bufferStart: 0, error: `Append Error: ${e.message}` });
    }
  }, [onBufferFull]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    // Revoke previous object URL to avoid memory leaks
    if (videoElement.src) {
      URL.revokeObjectURL(videoElement.src);
    }

    const mediaSource = new MediaSource();
    mediaSourceRef.current = mediaSource;
    videoElement.src = URL.createObjectURL(mediaSource);
    videoElement.load(); // Force the browser to drop the old buffer
    console.log("MediaSource opened!");

    const onSourceOpen = () => {
      try {
        // Guard against double-open
        if (sourceBufferRef.current) return;
        const sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
        sourceBufferRef.current = sourceBuffer;

        sourceBuffer.addEventListener('updateend', () => {
          processQueue();
        });

        sourceBuffer.addEventListener('error', (e) => {
          console.error("SourceBuffer Error:", e);
          setStats(s => ({ ...s, error: "SourceBuffer Error: Format mismatch or corrupted chunk." }));
        });

        setIsReady(true);
        // Flush any chunks that arrived before MediaSource was ready
        processQueue();
      } catch (e) {
        console.error("Failed to add source buffer:", e);
        setStats(s => ({ ...s, error: `MSE Init Error: ${e.message}` }));
      }
    };

    mediaSource.addEventListener('sourceopen', onSourceOpen);

    const handleWaiting = () => {
      setIsBuffering(true);
      if (onBuffering) onBuffering(true);
    };

    const handlePlaying = () => {
      setIsBuffering(false);
      if (onBuffering) onBuffering(false);
    };

    videoElement.addEventListener('waiting', handleWaiting);
    videoElement.addEventListener('playing', handlePlaying);
    videoElement.addEventListener('canplay', handlePlaying);

    return () => {
      mediaSource.removeEventListener('sourceopen', onSourceOpen);
      videoElement.removeEventListener('waiting', handleWaiting);
      videoElement.removeEventListener('playing', handlePlaying);
      videoElement.removeEventListener('canplay', handlePlaying);
      sourceBufferRef.current = null;
      setIsReady(false);
      try {
        if (mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
        }
      } catch (e) { /* ignore */ }
    };
  }, [mimeCodec, msVersion, processQueue, onBuffering]);

  useImperativeHandle(ref, () => ({
    setTimestampOffset: (offset) => {
      // No-op: TS parser uses absolute PTS
    },
    appendChunk: (chunk) => {
      queueRef.current.push(chunk);
      processQueue();
    },
    flush: () => {
      // Clear the pending queue
      queueRef.current = [];
      // Nuclear reset: destroy and recreate the entire MediaSource.
      // This is the ONLY reliable way to clear the HTMLMediaElement.error attribute,
      // which gets permanently set when the buffer is emptied while playing.
      sourceBufferRef.current = null;
      setIsReady(false);
      setStats({ chunksAppended: 0, bufferAhead: 0, bufferStart: 0, error: null });
      // Trigger useEffect re-run which creates a fresh MediaSource
      setMsVersion(v => v + 1);
    },
    getBufferAhead: () => {
      if (!videoRef.current || videoRef.current.buffered.length === 0) return 0;
      return videoRef.current.buffered.end(videoRef.current.buffered.length - 1) - videoRef.current.currentTime;
    },
    getBufferedRanges: () => {
      if (!videoRef.current) return [];
      const ranges = [];
      for (let i = 0; i < videoRef.current.buffered.length; i++) {
        ranges.push({
          start: videoRef.current.buffered.start(i),
          end: videoRef.current.buffered.end(i)
        });
      }
      return ranges;
    },
    getCurrentTime: () => videoRef.current ? videoRef.current.currentTime : 0,
    setCurrentTime: (time) => { if (videoRef.current) videoRef.current.currentTime = time; },
    play: () => {
      if (videoRef.current) {
        const playPromise = videoRef.current.play();
        if (playPromise !== undefined) {
          playPromise.catch(e => {
            if (e.name !== 'AbortError') console.error("MSEPlayer play error:", e);
          });
        }
      }
    },
    pause: () => videoRef.current && videoRef.current.pause(),
    getVideoElement: () => videoRef.current
  }));

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <VideoElement
        ref={videoRef}
        autoPlay
        playsInline
      />
      {isBuffering && <Spinner />}
      <Overlay>
        <div>MSE Engine: {isReady ? "Ready" : "Initializing"}</div>
        <div>MIME: {mimeCodec}</div>
        <div>Chunks Appended: {stats.chunksAppended}</div>
        <div>Buffer Ahead: {stats.bufferAhead}s (Starts at: {stats.bufferStart}s)</div>
        {stats.error && <div style={{ color: '#ff453a' }}>{stats.error}</div>}
      </Overlay>
    </div>
  );
});

export default MSEPlayer;
