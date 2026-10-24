// This standalone Vite fixture is not imported by the production application.
import { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import MSEPlayer from '../src/MSEPlayer.jsx';
import JellyfinPump from '../src/JellyfinPump.jsx';
import '../src/index.css';

if (!import.meta.env.DEV) throw new Error('The media regression fixture is available in development only.');

window.mediaEvents = [];
window.pumpEvents = [];
window.receivedMetadata = [];
window.deliveredChunks = [];
window.handleMediaChunk = async (chunk) => { window.deliveredChunks.push([...chunk]); };

export default function MediaFixture() {
  const [revision, setRevision] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [muted, setMuted] = useState(false);
  const [visible, setVisible] = useState(true);
  const [pumpMounted, setPumpMounted] = useState(true);
  const [playerMounted, setPlayerMounted] = useState(true);
  const playerRef = useRef(null);
  const pumpRef = useRef(null);

  useEffect(() => {
    window.mediaHarness = {
      revise: () => setRevision(value => value + 1),
      enable: () => setEnabled(true),
      disable: () => setEnabled(false),
      setMuted,
      showPump: () => setVisible(true),
      hidePump: () => setVisible(false),
      unmountPump: () => setPumpMounted(false),
      unmountPlayer: () => setPlayerMounted(false),
      append: chunk => playerRef.current.appendChunk(new Uint8Array(chunk)),
      play: () => playerRef.current.play(),
      pause: () => playerRef.current.pause(),
      retry: () => playerRef.current.retry(),
      flush: () => playerRef.current.flush(),
      endStream: () => playerRef.current.endStream(),
      restartPump: offset => pumpRef.current.restartPump(offset),
      stopPump: () => pumpRef.current.stopPump(),
    };
  }, []);

  return (
    <main data-revision={revision} style={{ width: '100%', maxWidth: 640, height: 320 }}>
      {playerMounted && <MSEPlayer ref={playerRef} enabled={enabled} muted={muted} onBuffering={buffering => { window.isMediaBuffering = buffering; }} onStatusChange={status => window.mediaEvents.push(status)} />}
      {pumpMounted && <JellyfinPump ref={pumpRef} visible={visible} onClose={() => setVisible(false)} onMetadata={metadata => window.receivedMetadata.push(metadata)} onStatusChange={status => window.pumpEvents.push(status)} onChunkReceived={(chunk, context) => window.handleMediaChunk(chunk, context)} />}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<MediaFixture />);
