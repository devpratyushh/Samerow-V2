import { useEffect, useRef, useState } from 'react';
import { FaMicrophoneSlash, FaThumbtack, FaPlay } from 'react-icons/fa';
import { initials } from './roomLayout';
export default function MediaTile({ participant, screen = false, focused = false, onPin, hidden = false }) {
  const { id, name, stream, isSelf, videoOff, muted } = participant;
  const videoRef = useRef(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play().catch(error => {
      if (error.name === 'NotAllowedError') setBlocked(true);
    });
  }, [stream]);
  return (
    <article className={`media-tile ${screen ? 'media-tile--screen' : ''} ${focused ? 'is-pinned' : ''}`} data-participant={id} data-self={isSelf || undefined} hidden={hidden}>
      <video ref={videoRef} autoPlay playsInline muted={isSelf || (screen && hidden)} className={videoOff ? 'camera-off' : ''} aria-label={`${name}${screen ? ' screen share' : ' camera'}`} />
      {(!stream || videoOff) && <div className="tile-avatar" aria-hidden="true"><span>{initials(name)}</span><i /></div>}
      <div className="tile-caption"><span>{name}{isSelf ? ' (You)' : ''}</span>{muted && !screen && <FaMicrophoneSlash aria-label="Microphone muted" />}</div>
      {onPin && <button className="tile-pin" onClick={onPin} aria-label={`${focused ? 'Unpin' : 'Pin'} ${name}`} aria-pressed={focused} title={`${focused ? 'Unpin' : 'Pin'} participant`}><FaThumbtack /></button>}
      {blocked && <button className="tile-play" onClick={() => videoRef.current?.play().then(() => setBlocked(false)).catch(() => {})}><FaPlay /> Enable audio</button>}
    </article>
  );
}
