import { useCallback, useEffect, useRef, useState } from 'react';
import { FaPlay, FaPause, FaVolumeUp, FaVolumeMute, FaExpand, FaCompress, FaUndo, FaRedo } from 'react-icons/fa';
import { useRoomPresentation } from './RoomPresentation';
import { formatTime } from './roomLayout';
import './PlaybackControls.css';

/** Local sound controls; play/pause and completed seeks are supplied by the room. */
export default function PlaybackControls({ playing, currentTime = 0, duration = 0, volume = 1, muted = false, onTogglePlay, onSeek, onVolumeChange, onMute, canSeek = true, disabled = false, label = 'Video', note, children }) {
  const [draft, setDraft] = useState(null);
  const { fullscreen, toggleFullscreen } = useRoomPresentation();
  const [awake, setAwake] = useState(true);
  const controlsRef = useRef(null);
  const hideTimer = useRef(null);
  const dragging = useRef(false);
  const wasHidden = useRef(false);
  const visible = !playing || disabled || awake;
  const scheduleHide = useCallback((delay = 2200) => {
    clearTimeout(hideTimer.current);
    if (!playing || disabled) return;
    const hideWhenIdle = () => {
      const controls = controlsRef.current;
      if (dragging.current || controls?.matches(':hover') || controls?.querySelector(':focus-visible')) {
        hideTimer.current = setTimeout(hideWhenIdle, 500);
        return;
      }
      setAwake(false);
    };
    hideTimer.current = setTimeout(hideWhenIdle, delay);
  }, [playing, disabled, setAwake]);
  const wake = useCallback(() => { setAwake(true); scheduleHide(); }, [scheduleHide, setAwake]);
  useEffect(() => {
    scheduleHide();
    const release = () => {
      if (!dragging.current) return;
      dragging.current = false;
      scheduleHide();
    };
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    return () => {
      clearTimeout(hideTimer.current);
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', release);
    };
  }, [scheduleHide]);
  const finiteDuration = Number.isFinite(duration) && duration > 0;
  const time = draft ?? currentTime;
  const seekable = !disabled && canSeek && finiteDuration;
  const finishSeek = event => {
    if (draft === null) return;
    onSeek?.(Math.min(duration, Math.max(0, Number(event.currentTarget.value))));
    setDraft(null);
  };
  const skip = delta => onSeek?.(Math.min(duration, Math.max(0, currentTime + delta)));
  return <>
    <div className="playback-hit-area" aria-hidden="true"
      onPointerMove={event => { if (event.pointerType !== 'touch') wake(); }}
      onPointerLeave={() => scheduleHide(1200)}
      onPointerDown={() => { wasHidden.current = !visible; wake(); }}
      onClick={event => { if (event.button === 0 && !disabled && !wasHidden.current) onTogglePlay?.(); }} />
    <div ref={controlsRef} className={`player-controls ${!playing ? 'is-paused' : ''} ${!visible ? 'is-hidden' : ''}`} role="group" aria-label={`${label} playback controls`}
      onPointerEnter={wake} onPointerLeave={() => scheduleHide(1200)} onFocusCapture={wake} onKeyDown={wake}
      onPointerDown={() => { dragging.current = true; wake(); }}>
    <label className="player-seek"><span className="sr-only">Seek {label.toLowerCase()}</span><input type="range" min="0" max={finiteDuration ? duration : 1} step="0.1" value={Math.max(0, Math.min(time, finiteDuration ? duration : 1))} disabled={!seekable} aria-valuetext={`${formatTime(time)} of ${finiteDuration ? formatTime(duration) : 'unknown duration'}`} onChange={event => setDraft(Number(event.target.value))} onPointerUp={finishSeek} onKeyUp={finishSeek} onBlur={finishSeek} style={{ '--played': `${finiteDuration ? Math.max(0, Math.min(100, time / duration * 100)) : 0}%` }} /></label>
    <div className="player-controls-row">
      <button className="player-control player-play" aria-label={playing ? `Pause ${label.toLowerCase()}` : `Play ${label.toLowerCase()}`} title={playing ? 'Pause' : 'Play'} disabled={disabled} onClick={onTogglePlay}>{playing ? <FaPause /> : <FaPlay />}</button>
      <button className="player-control player-skip" aria-label="Back 10 seconds" title="Back 10 seconds" onClick={() => skip(-10)} disabled={!seekable}><FaUndo /><small>10</small></button>
      <button className="player-control player-skip" aria-label="Forward 10 seconds" title="Forward 10 seconds" onClick={() => skip(10)} disabled={!seekable}><FaRedo /><small>10</small></button>
      <span className="player-clock">{formatTime(time)}<span> / {finiteDuration ? formatTime(duration) : duration === Infinity ? 'LIVE' : '—:—'}</span></span>
      <span className="player-controls-spacer" />
      {note && <span className="player-control-note">{note}</span>}
      <div className="player-volume"><button className="player-control" aria-label={muted || volume === 0 ? 'Unmute video' : 'Mute video'} title={muted || volume === 0 ? 'Unmute video' : 'Mute video'} onClick={onMute}>{muted || volume === 0 ? <FaVolumeMute /> : <FaVolumeUp />}</button><input aria-label="Video volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={event => onVolumeChange?.(Number(event.target.value))} /></div>
      {children}
      <button className="player-control player-fullscreen" aria-label={fullscreen ? 'Exit video fullscreen' : 'Video fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen || undefined} disabled={!toggleFullscreen}>{fullscreen ? <FaCompress /> : <FaExpand />}</button>
    </div>
  </div></>;
}
