import React, { useState, useRef, useImperativeHandle, forwardRef } from 'react';

import ReactDOM from 'react-dom';
import styled from 'styled-components';
import { FaTimes } from 'react-icons/fa';

const ModalOverlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background-color: rgba(0,0,0,0.7);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 9999;
  backdrop-filter: blur(8px);
`;

const Container = styled.div`
  padding: 24px;
  background-color: rgba(30, 30, 34, 0.95);
  border-radius: 16px;
  color: white;
  width: 100%;
  max-width: 500px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  border: 1px solid rgba(255,255,255,0.1);
  box-shadow: 0 20px 40px rgba(0,0,0,0.5);
  position: relative;
`;

const CloseButton = styled.button`
  position: absolute;
  top: 16px;
  right: 16px;
  background: none;
  border: none;
  color: rgba(255,255,255,0.6);
  cursor: pointer;
  &:hover { color: white; }
`;

const Input = styled.input`
  padding: 12px;
  background-color: rgba(0,0,0,0.2);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 8px;
  color: white;
  width: 100%;
  box-sizing: border-box;
`;

const Button = styled.button`
  padding: 12px 24px;
  background-color: #0a84ff;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-weight: bold;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const LogArea = styled.div`
  background-color: #000;
  padding: 12px;
  border-radius: 8px;
  font-family: monospace;
  font-size: 12px;
  height: 200px;
  overflow-y: auto;
  color: #0f0;
  white-space: pre-wrap;
`;

const JellyfinPump = forwardRef(({ onChunkReceived, onMetadata, onClose, visible = true }, ref) => {
  const [jellyfinUrl, setJellyfinUrl] = useState('http://192.168.29.5:8096');
  const [apiToken, setApiToken] = useState('a621f0edc33d4d91b7c95229d8e48fc0');
  const [itemId, setItemId] = useState('c37c133b11f6dd17b9f5fc9a57b14b42');
  const [isPumping, setIsPumping] = useState(false);
  const [logs, setLogs] = useState([]);

  const readerRef = useRef(null);
  const controllerRef = useRef(null);
  const chunkCountRef = useRef(0);
  const totalBytesRef = useRef(0);

  const addLog = (msg) => {
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`].slice(-50));
  };

  const startPump = async (startOffsetSeconds = 0) => {
    if (!jellyfinUrl || !apiToken || !itemId) {
      addLog("Error: Missing required fields.");
      return;
    }

    try {
      if (controllerRef.current) {
        controllerRef.current.abort();
      }
      setIsPumping(true);
      setLogs([]);
      addLog(`Starting pump at offset ${startOffsetSeconds}s...`);

      // Fetch metadata first
      try {
        const metaUrl = `${jellyfinUrl.replace(/\/$/, '')}/Items?Ids=${itemId}`;
        const metaRes = await fetch(metaUrl, { headers: { 'X-Emby-Token': apiToken } });
        if (metaRes.ok) {
          const metaData = await metaRes.json();
          const item = metaData.Items && metaData.Items[0];
          if (item && item.RunTimeTicks) {
            const durationSec = item.RunTimeTicks / 10000000;
            addLog(`Got duration: ${durationSec}s`);
            if (onMetadata) onMetadata({ duration: durationSec });
          }
        }
      } catch (err) {
        addLog(`Warning: Failed to fetch metadata: ${err.message}`);
      }

      // 10000000 ticks = 1 second
      const startTimeTicks = Math.floor(startOffsetSeconds * 10000000);
      // Force Jellyfin to transcode with a unique session ID so StartTimeTicks is honored.
      // Without explicit codec params, Jellyfin may silently fall back to Static=true (ignoring seek).
      const sessionId = `SameRow_${Date.now()}`;
      const url = `${jellyfinUrl.replace(/\/$/, '')}/Videos/${itemId}/stream.ts?Static=false&VideoCodec=h264&AudioCodec=aac&StartTimeTicks=${startTimeTicks}&TranscodingMaxAudioChannels=2&SegmentContainer=ts&MinSegments=1&BreakOnNonKeyFrames=true&PlaySessionId=${sessionId}&api_key=${apiToken}`;

      controllerRef.current = new AbortController();

      addLog(`Fetching offset: ${startOffsetSeconds}s, ticks: ${startTimeTicks}`);
      addLog(`Fetching from: ${url}`);
      const response = await fetch(url, {
        headers: {
          'X-Emby-Token': apiToken
        },
        signal: controllerRef.current.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type');
      addLog(`Connected! Content-Type: ${contentType}`);

      // Get the readable stream
      readerRef.current = response.body.getReader();
      chunkCountRef.current = 0;
      totalBytesRef.current = 0;

      // Start the recursive read loop
      pump();

    } catch (error) {
      if (error.name === 'AbortError') {
        addLog("Pump manually aborted.");
      } else {
        addLog(`Error: ${error.message}`);
      }
      setIsPumping(false);
    }
  };

  const pump = async () => {
    try {
      if (!readerRef.current) return;

      const { done, value } = await readerRef.current.read();

      if (done) {
        addLog("Stream complete (done: true).");
        setIsPumping(false);
        return;
      }

      // 'value' is a Uint8Array containing raw video bytes
      chunkCountRef.current += 1;
      totalBytesRef.current += value.byteLength;

      if (chunkCountRef.current % 50 === 0) {
        addLog(`Pumped ${chunkCountRef.current} chunks (${(totalBytesRef.current / 1024 / 1024).toFixed(2)} MB)...`);
      }

      if (onChunkReceived) {
        await onChunkReceived(value);
      } else if (chunkCountRef.current <= 5) {
        addLog(`Received chunk of size: ${value.byteLength} bytes`);
      }

      // Recursively read the next chunk immediately
      pump();

    } catch (error) {
      if (error.name === 'AbortError') {
        addLog("Read loop aborted.");
      } else {
        addLog(`Pump error: ${error.message}`);
      }
      setIsPumping(false);
    }
  };

  const stopPump = () => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
    setIsPumping(false);
    addLog("Pump stopped.");
  };

  useImperativeHandle(ref, () => ({
    restartPump: (offsetSeconds) => startPump(offsetSeconds),
    stopPump: stopPump
  }));

  if (!visible) return null;

  return ReactDOM.createPortal(
    <ModalOverlay onClick={onClose}>
      <Container onClick={e => e.stopPropagation()}>
        <CloseButton onClick={onClose}><FaTimes /></CloseButton>
        <h3 style={{ margin: 0 }}>Jellyfin Server</h3>
        <p style={{ fontSize: '14px', color: '#aaa', margin: 0 }}>
          Enter your Jellyfin server details to pump raw video chunks to the room.
        </p>

        <Input
          type="text"
          placeholder="Jellyfin URL (e.g. http://192.168.1.100:8096)"
          value={jellyfinUrl}
          onChange={e => setJellyfinUrl(e.target.value)}
          disabled={isPumping}
        />
        <Input
          type="text"
          placeholder="API Token"
          value={apiToken}
          onChange={e => setApiToken(e.target.value)}
          disabled={isPumping}
        />
        <Input
          type="text"
          placeholder="Item ID (e.g. e2a7...)"
          value={itemId}
          onChange={e => setItemId(e.target.value)}
          disabled={isPumping}
        />

        {!isPumping ? (
          <Button onClick={() => startPump(0)}>Start Pumping to Room</Button>
        ) : (
          <Button onClick={stopPump} style={{ backgroundColor: '#ff3b30' }}>Stop Pumping</Button>
        )}

        <LogArea>
          {logs.map((log, i) => <div key={i}>{log}</div>)}
        </LogArea>

      </Container>
    </ModalOverlay>,
    document.body
  );
});

export default JellyfinPump;
