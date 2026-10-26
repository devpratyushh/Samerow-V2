import { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog';

/** Metadata must resolve before the room activates its shared player. */
export default function JellyfinShareDialog({ open, onClose, onShare, onCancel }) {
  const [serverUrl, setServerUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [itemId, setItemId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const close = () => {
    generation.current += 1;
    if (pending) onCancel();
    setPending(false); setError(''); onClose();
  };
  const submit = async event => {
    event.preventDefault();
    const request = ++generation.current;
    setPending(true); setError('');
    try {
      await onShare({ serverUrl: serverUrl.trim(), apiToken: apiToken.trim(), itemId: itemId.trim() });
      if (generation.current === request) { setPending(false); onClose(); }
    } catch (err) {
      if (generation.current === request) { setPending(false); setError(err.message); }
    }
  };
  return <Dialog open={open} title="Share from Jellyfin" description="Everyone can control playback. Audio and subtitles are chosen individually." onClose={close}>
    <form onSubmit={submit}>
      <label className="room-field">Server address<input type="url" value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="https://jellyfin.example.com" disabled={pending} required /></label>
      <label className="room-field">API token<input type="password" value={apiToken} onChange={event => setApiToken(event.target.value)} autoComplete="off" disabled={pending} required /></label>
      <label className="room-field">Video item ID<input value={itemId} onChange={event => setItemId(event.target.value)} disabled={pending} required /></label>
      <p className="jellyfin-form-note">Use a Jellyfin address the room server can reach. Your API token is kept on the room server for this session.</p>
      {pending && <p role="status">Getting video details…</p>}
      {error && <p className="room-field-error" role="alert">{error}</p>}
      <button className="sr-button sr-button--primary" type="submit" disabled={pending || !serverUrl.trim() || !apiToken.trim() || !itemId.trim()}>{pending ? 'Connecting…' : 'Share video with room'}</button>
    </form>
  </Dialog>;
}
