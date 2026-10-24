import { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import styled from 'styled-components';
import Dialog from './components/Dialog.jsx';

const Form = styled.form`
  display: grid;
  gap: 18px;
  min-width: 0;
`;

const Field = styled.label`
  display: grid;
  gap: 8px;
  color: var(--text, #f4f6fc);
  font-size: 14px;
  font-weight: 600;
  small { color: var(--muted, #a8b1c3); font-size: 12px; font-weight: 400; line-height: 1.5; }
`;

const Input = styled.input`
  min-width: 0;
  width: 100%;
  min-height: 46px;
  box-sizing: border-box;
  padding: 11px 13px;
  background: var(--bg, #10131b);
  border: 1px solid var(--border, #343843);
  border-radius: 10px;
  color: var(--text, #f4f6fc);
  font: inherit;
  font-weight: 400;
  &:focus-visible { outline: 2px solid var(--accent, #779bff); outline-offset: 2px; }
  &:disabled { opacity: 0.65; }
  &::placeholder { color: var(--muted, #a8b1c3); }
`;

const Button = styled.button`
  min-height: 46px;
  padding: 12px 18px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: ${props => props.$stop ? 'var(--danger, #ef6c73)' : 'var(--accent, #779bff)'};
  color: #0a1020;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  &:hover { filter: brightness(1.08); }
  &:focus-visible { outline: 2px solid var(--text, #f4f6fc); outline-offset: 3px; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const Status = styled.div`
  display: grid;
  gap: 7px;
  padding: 14px;
  border: 1px solid var(--border, #343843);
  border-radius: 10px;
  background: var(--surface-raised, #222735);
  color: ${props => props.$error ? 'var(--danger, #ef6c73)' : 'var(--text, #f4f6fc)'};
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  small { color: var(--muted, #a8b1c3); }
`;

const Details = styled.details`
  color: var(--muted, #a8b1c3);
  font-size: 12px;
  summary { padding: 8px 0; cursor: pointer; }
  summary:focus-visible { outline: 2px solid var(--accent, #779bff); outline-offset: 2px; }
  pre { max-height: 150px; overflow: auto; padding: 12px; margin: 4px 0 0; border-radius: 8px; background: var(--bg, #10131b); white-space: pre-wrap; overflow-wrap: anywhere; }
`;

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

async function waitForChunkHandler(pending, signal) {
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new DOMException('Sharing stopped.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

const JellyfinPump = forwardRef(function JellyfinPump({ onChunkReceived, onMetadata, onStatusChange, onClose, visible = true }, ref) {
  const [jellyfinUrl, setJellyfinUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [itemId, setItemId] = useState('');
  const [isPumping, setIsPumping] = useState(false);
  const [status, setStatus] = useState({ state: 'idle', message: 'Connect a video to watch together.' });
  const [metadata, setMetadata] = useState(null);
  const [progress, setProgress] = useState({ chunks: 0, bytes: 0 });
  const [logs, setLogs] = useState([]);
  const readerRef = useRef(null);
  const controllerRef = useRef(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const callbacksRef = useRef({ onChunkReceived, onMetadata, onStatusChange });

  useEffect(() => {
    callbacksRef.current = { onChunkReceived, onMetadata, onStatusChange };
  }, [onChunkReceived, onMetadata, onStatusChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
      readerRef.current?.cancel().catch(() => {});
      controllerRef.current = null;
      readerRef.current = null;
    };
  }, []);

  const updateStatus = (state, message) => {
    if (!mountedRef.current) return;
    setStatus({ state, message });
    callbacksRef.current.onStatusChange?.({ state, message });
    setLogs(previous => [...previous, message].slice(-30));
  };

  const stopPump = () => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    readerRef.current?.cancel().catch(() => {});
    controllerRef.current = null;
    readerRef.current = null;
    setIsPumping(false);
    updateStatus('idle', 'Sharing stopped. Your connection details are ready to reuse.');
  };

  const startPump = async (startOffsetSeconds = 0) => {
    let server;
    try {
      server = new URL(jellyfinUrl.trim());
      if (!['http:', 'https:'].includes(server.protocol)) throw new Error('protocol');
    } catch {
      updateStatus('error', 'Enter a valid Jellyfin server address beginning with https:// or http://.');
      return;
    }
    if (!apiToken.trim() || !itemId.trim()) {
      updateStatus('error', 'Enter your API token and the video item ID to continue.');
      return;
    }

    generationRef.current += 1;
    const generation = generationRef.current;
    controllerRef.current?.abort();
    readerRef.current?.cancel().catch(() => {});
    const controller = new AbortController();
    controllerRef.current = controller;
    readerRef.current = null;
    const isCurrent = () => mountedRef.current && generation === generationRef.current && !controller.signal.aborted;
    const baseUrl = server.href.replace(/\/$/, '');
    const offset = Math.max(0, Number(startOffsetSeconds) || 0);
    const headers = { 'X-Emby-Token': apiToken.trim() };
    let reader;

    setIsPumping(true);
    setProgress({ chunks: 0, bytes: 0 });
    setLogs([]);
    updateStatus('loading', offset > 0 ? `Connecting from ${formatDuration(offset)}…` : 'Connecting to Jellyfin…');

    try {
      // Metadata uses the same controller so stopping also cancels connection setup.
      try {
        const metadataUrl = new URL(`${baseUrl}/Items`);
        metadataUrl.searchParams.set('Ids', itemId.trim());
        const response = await fetch(metadataUrl, { headers, signal: controller.signal });
        if (response.ok) {
          const data = await response.json();
          if (!isCurrent()) return;
          const item = data.Items?.[0];
          if (item) {
            const nextMetadata = { title: item.Name || 'Jellyfin video', duration: (item.RunTimeTicks || 0) / 10000000 };
            setMetadata(nextMetadata);
            callbacksRef.current.onMetadata?.(nextMetadata);
          }
        }
      } catch (error) {
        if (error.name === 'AbortError' || !isCurrent()) return;
        updateStatus('loading', 'Video details are unavailable. Connecting to the stream…');
      }
      if (!isCurrent()) return;

      const streamUrl = new URL(`${baseUrl}/Videos/${encodeURIComponent(itemId.trim())}/stream.ts`);
      streamUrl.search = new URLSearchParams({
        Static: 'false', VideoCodec: 'h264', AudioCodec: 'aac',
        StartTimeTicks: String(Math.floor(offset * 10000000)),
        TranscodingMaxAudioChannels: '2', SegmentContainer: 'ts', MinSegments: '1',
        BreakOnNonKeyFrames: 'true', PlaySessionId: `SameRow_${Date.now()}`,
      }).toString();
      const response = await fetch(streamUrl, { headers, signal: controller.signal });
      if (!isCurrent()) return;
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw new Error('Jellyfin rejected the API token. Check its permissions and try again.');
        if (response.status === 404) throw new Error('This video was not found. Check the item ID.');
        throw new Error(`Jellyfin could not start the stream (HTTP ${response.status}). Try again.`);
      }
      if (!response.body) throw new Error('This browser could not open the video stream. Try another browser.');

      reader = response.body.getReader();
      readerRef.current = reader;
      updateStatus('streaming', 'Sharing video with the room.');
      let chunks = 0;
      let bytes = 0;
      let lastProgressAt = 0;

      while (isCurrent()) {
        const { done, value } = await reader.read();
        if (!isCurrent()) break;
        if (done) {
          setProgress({ chunks, bytes });
          // Finishing the transfer does not mean that buffered playback has ended.
          updateStatus('complete', 'The video is fully buffered. Playback continues in the room.');
          break;
        }
        chunks += 1;
        bytes += value.byteLength;
        if (Date.now() - lastProgressAt > 500) {
          lastProgressAt = Date.now();
          setProgress({ chunks, bytes });
        }
        // Await the room's backpressure handler before reading another chunk.
        // The optional signal lets a parent stop its own buffer/channel wait loops.
        // Racing cancellation also releases the reader if a callback is still pending.
        await waitForChunkHandler(callbacksRef.current.onChunkReceived?.(value, { signal: controller.signal }), controller.signal);
      }
    } catch (error) {
      if (isCurrent() && error.name !== 'AbortError') {
        // Fetch errors can contain addresses; keep user credentials out of logs.
        const message = error instanceof TypeError ? 'Could not reach Jellyfin. Check the address, network connection, and server browser-access settings.' : error.message;
        updateStatus('error', message);
      }
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch { /* The controller may have already closed the stream. */ }
        try { reader.releaseLock(); } catch { /* A cancelled read may still hold a lock. */ }
      }
      if (generation === generationRef.current && mountedRef.current) {
        setIsPumping(false);
        controllerRef.current = null;
        readerRef.current = null;
      }
    }
  };

  useImperativeHandle(ref, () => ({ restartPump: offsetSeconds => startPump(offsetSeconds), stopPump }));

  return (
    <Dialog open={visible} title="Share from Jellyfin" onClose={onClose} description="Connect your server and choose a video. Closing this window keeps the stream running.">
      <Form onSubmit={event => { event.preventDefault(); if (!isPumping) startPump(0); }}>
        <Field>
          Server address
          <Input type="url" inputMode="url" autoComplete="url" placeholder="https://jellyfin.example.com" value={jellyfinUrl} onChange={event => setJellyfinUrl(event.target.value)} disabled={isPumping} required />
        </Field>
        <Field>
          API token
          <Input type="password" autoComplete="off" placeholder="Your Jellyfin API token" value={apiToken} onChange={event => setApiToken(event.target.value)} disabled={isPumping} required spellCheck={false} />
          <small>Used for this session to connect to your Jellyfin server.</small>
        </Field>
        <Field>
          Video item ID
          <Input type="text" autoComplete="off" placeholder="Paste the video’s item ID" value={itemId} onChange={event => setItemId(event.target.value)} disabled={isPumping} required spellCheck={false} />
          <small>Find this in the video’s address when you open it in Jellyfin.</small>
        </Field>
        <Status role={status.state === 'error' ? 'alert' : 'status'} $error={status.state === 'error'}>
          <span>{status.message}</span>
          {metadata && <small>{metadata.title}{metadata.duration > 0 ? ` · ${formatDuration(metadata.duration)}` : ''}</small>}
          {progress.chunks > 0 && <small>{(progress.bytes / 1024 / 1024).toFixed(1)} MB sent</small>}
        </Status>
        {isPumping
          ? <Button type="button" $stop onClick={event => { event.preventDefault(); stopPump(); }}>Stop sharing video</Button>
          : <Button type="submit" disabled={!jellyfinUrl.trim() || !apiToken.trim() || !itemId.trim()}>Share video with room</Button>}
        {logs.length > 0 && <Details><summary>Connection details</summary><pre>{logs.join('\n')}</pre></Details>}
      </Form>
    </Dialog>
  );
});

export default JellyfinPump;
