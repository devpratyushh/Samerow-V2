import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import JellyfinPlayer from '../src/JellyfinPlayer';
import '../src/index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only.');
export function Fixture() {
  const [state, setState] = useState(() => ({ accessToken: 'timeline-fixture', sessionId: 'timeline', audioTracks: [], subtitleTracks: [], playing: false, timestamp: 0, receivedAt: performance.now(), duration: 180, revision: 1 }));
  const command = (action, time) => {
    if (action !== 'seek') return;
    setState(previous => ({ ...previous, timestamp: time, receivedAt: performance.now(), revision: previous.revision + 1, seek: { id: previous.revision + 1, time } }));
    return 'accepted';
  };
  return <JellyfinPlayer state={state} base="" command={command} connected focused />;
}
createRoot(document.getElementById('root')).render(<Fixture />);
