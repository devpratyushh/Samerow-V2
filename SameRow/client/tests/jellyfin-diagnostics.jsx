import { createRoot } from 'react-dom/client';
import JellyfinPlayer from '../src/JellyfinPlayer';
import '../src/index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only.');
const state = { accessToken: 'diagnostics-test-secret', sessionId: 'diagnostics', audioTracks: [], subtitleTracks: [], playing: true, timestamp: 0, receivedAt: performance.now(), duration: 60, revision: 1 };
createRoot(document.getElementById('root')).render(<main style={{ height: '100dvh' }}><JellyfinPlayer state={state} base="" command={() => {}} connected focused /></main>);
