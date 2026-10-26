import { useCallback, useEffect, useRef, useState } from 'react';
import { FaMicrophone, FaMicrophoneSlash, FaVideo, FaVideoSlash, FaPhoneSlash, FaEllipsisH, FaExpand, FaCompress, FaThLarge, FaDesktop, FaCopy, FaCommentAlt, FaPlay, FaUsers, FaChevronDown, FaChevronUp, FaPlus, FaCircle, FaSlidersH } from 'react-icons/fa';
import Dialog from './Dialog';
import { RoomPresentation } from './RoomPresentation';
import MediaTile from './MediaTile';
import { gridColumns, resolveSource } from './roomLayout';
import './RoomView.css';

function Control({ label, children, active, danger, ...props }) {
  return <button className={`room-control ${active ? 'is-active' : ''} ${danger ? 'is-danger' : ''}`} title={label} aria-label={label} {...props}>{children}<span>{label}</span></button>;
}

export function MediaStatus({ status, onRetry }) {
  if (!status || ['playing', 'paused', 'idle'].includes(status.state)) return null;
  const failed = ['error', 'blocked', 'ended'].includes(status.state);
  return <div className={`media-status ${failed ? 'media-status--action' : ''}`} role={failed ? 'status' : undefined}>
    {!failed && <span className="room-spinner" aria-hidden="true" />}
    <span>{status.message || ({ loading: 'Getting your video ready…', buffering: 'Buffering…', blocked: 'Ready when you are. Press play to begin.', ended: 'The video has ended.', error: 'This video could not be loaded.' }[status.state])}</span>
    {onRetry && failed && <button className="sr-button sr-button--small" onClick={onRetry}>{status.state === 'blocked' ? 'Play video' : 'Try again'}</button>}
  </div>;
}

export default function RoomView({ roomId, userName, connected = true, participants, screenShares = [], youtube, jellyfin, chat, chatOpen, onChatToggle, unread = 0, muted, videoOff, onToggleMute, onToggleVideo, onShare, onLeave, onInvite, onStopScreen, notification, diagnostics, preview = false }) {
  const [selectedSource, setSelectedSource] = useState(null);
  const [pin, setPin] = useState(null);
  const [railHidden, setRailHidden] = useState(false);
  const [participantLayout, setParticipantLayout] = useState('auto');
  const [participantPosition, setParticipantPosition] = useState(null);
  const participantRef = useRef(null);
  const participantDrag = useRef(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [theater, setTheater] = useState(false);
  const [barsVisible, setBarsVisible] = useState({ top: true, bottom: true });
  const barTimers = useRef({ top: null, bottom: null });
  const barHovered = useRef({ top: false, bottom: false });
  const [columns, setColumns] = useState(2);
  const shellRef = useRef(null);
  const gridRef = useRef(null);
  const sources = [
    { id: 'people', label: 'Everyone', icon: <FaUsers /> },
    ...screenShares.map(source => ({ id: source.id, label: source.isSelf ? 'Your screen' : `${source.name}’s screen`, icon: <FaDesktop /> })),
    ...(youtube?.active ? [{ id: 'youtube', label: 'YouTube', icon: <FaPlay /> }] : []),
    ...(jellyfin?.active ? [{ id: 'jellyfin', label: 'Jellyfin', icon: <FaPlay /> }] : []),
  ];
  const sourceId = resolveSource(selectedSource, sources);
  const contentFocused = sourceId !== 'people';
  const pinnedId = participants.length > 1 && participants.some(person => person.id === pin) ? pin : null;
  const currentSource = sources.find(source => source.id === sourceId);
  const fullscreen = fullScreen || theater;
  const immersive = fullscreen && contentFocused;
  const floatingLayout = participantLayout === 'auto' ? (participants.length > 1 ? 'strip' : 'circles') : participantLayout;
  const moveParticipants = useCallback((x, y) => {
    const panel = participantRef.current;
    const bounds = panel?.offsetParent;
    if (!panel || !bounds) return;
    const next = {
      x: Math.max(18, Math.min(x, bounds.clientWidth - panel.offsetWidth - 18)),
      y: Math.max(18, Math.min(y, bounds.clientHeight - panel.offsetHeight - 18)),
    };
    setParticipantPosition(previous => previous?.x === next.x && previous?.y === next.y ? previous : next);
  }, [setParticipantPosition]);
  useEffect(() => {
    if (!immersive || railHidden) return;
    const panel = participantRef.current;
    const constrain = () => moveParticipants(panel.offsetLeft, panel.offsetTop);
    const observer = new ResizeObserver(constrain);
    observer.observe(panel);
    observer.observe(panel.offsetParent);
    return () => observer.disconnect();
  }, [immersive, railHidden, floatingLayout, moveParticipants]);
  const startParticipantDrag = event => {
    if (event.button !== 0) return;
    const panel = participantRef.current;
    participantDrag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const dragParticipants = event => {
    const drag = participantDrag.current;
    if (drag?.id === event.pointerId) moveParticipants(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  };
  const endParticipantDrag = () => { participantDrag.current = null; };
  const chromeVisible = barsVisible.top || barsVisible.bottom;
  const scheduleHide = useCallback((bar, delay = 650) => {
    clearTimeout(barTimers.current[bar]);
    const hideWhenIdle = () => {
      // Media providers can replace their event target before pointerleave arrives.
      const hovered = barHovered.current[bar] && shellRef.current?.querySelector(`[data-room-bar="${bar}"]:hover`);
      if (hovered) {
        barTimers.current[bar] = setTimeout(hideWhenIdle, 650);
        return;
      }
      setBarsVisible(previous => previous[bar] ? { ...previous, [bar]: false } : previous);
    };
    barTimers.current[bar] = setTimeout(hideWhenIdle, delay);
  }, [setBarsVisible]);
  const enterBar = useCallback((bar, event) => {
    if (!immersive || event?.pointerType === 'touch') return;
    barHovered.current[bar] = true;
    scheduleHide(bar, 2800);
    setBarsVisible(previous => previous[bar] ? previous : { ...previous, [bar]: true });
  }, [immersive, scheduleHide, setBarsVisible]);
  const leaveBar = useCallback(bar => {
    if (!immersive) return;
    barHovered.current[bar] = false;
    scheduleHide(bar);
  }, [immersive, scheduleHide]);
  const revealBars = useCallback(() => {
    setBarsVisible({ top: true, bottom: true });
    scheduleHide('top', 2800);
    scheduleHide('bottom', 2800);
  }, [scheduleHide, setBarsVisible]);
  useEffect(() => {
    if (!immersive) return;
    const timers = barTimers.current;
    scheduleHide('top', 2200);
    scheduleHide('bottom', 2200);
    const revealForKeyboard = event => {
      if (!event.target.closest('.player-controls, .playback-hit-area')) revealBars();
    };
    document.addEventListener('keydown', revealForKeyboard);
    return () => {
      clearTimeout(timers.top); clearTimeout(timers.bottom);
      barHovered.current = { top: false, bottom: false };
      document.removeEventListener('keydown', revealForKeyboard);
    };
  }, [immersive, scheduleHide, revealBars]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const observer = new ResizeObserver(([entry]) => setColumns(gridColumns(participants.length, entry.contentRect.width, entry.contentRect.height)));
    observer.observe(grid);
    return () => observer.disconnect();
  }, [participants.length]);
  useEffect(() => {
    const update = () => setFullScreen(document.fullscreenElement === shellRef.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => {
    if (!theater) return;
    const exitTheater = event => { if (event.key === 'Escape' && !document.querySelector('.sr-dialog-overlay')) setTheater(false); };
    document.addEventListener('keydown', exitTheater);
    return () => document.removeEventListener('keydown', exitTheater);
  }, [theater]);

  const toggleFullscreen = async () => {
    revealBars();
    try {
      if (theater) { setTheater(false); return; }
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (shellRef.current.requestFullscreen) await shellRef.current.requestFullscreen();
      else setTheater(true);
    } catch { setTheater(true); }
  };
  const pinParticipant = (id) => {
    setPin(previous => previous === id ? null : id);
    setSelectedSource('people');
  };
  const moreAction = (action) => () => { setMoreOpen(false); action(); };

  return <RoomPresentation.Provider value={{ fullscreen, toggleFullscreen }}>
  <div className={`room-shell ${fullscreen ? 'is-fullscreen' : ''} ${immersive ? 'is-watching' : ''} ${contentFocused ? 'has-media' : ''} ${immersive && !barsVisible.top ? 'top-bar-hidden' : ''} ${immersive && !barsVisible.bottom ? 'bottom-bar-hidden' : ''} ${immersive && !chromeVisible ? 'chrome-hidden' : ''} ${chatOpen ? 'has-open-chat' : ''} ${theater ? 'is-theater' : ''}`} ref={shellRef} onPointerDown={event => {
    if (immersive && event.pointerType !== 'mouse' && !event.target.closest('.playback-hit-area, .player-controls')) revealBars();
  }}>
    <div className="fullscreen-topbar" data-room-bar="top" hidden={!immersive} onPointerEnter={event => enterBar('top', event)} onPointerLeave={() => leaveBar('top')}><span className="fullscreen-source">{currentSource.label}</span><div><button className="icon-button" onClick={() => setRailHidden(value => !value)} aria-label={railHidden ? 'Show fullscreen participants' : 'Hide fullscreen participants'} aria-pressed={!railHidden}><FaUsers /></button><button className="icon-button chat-toggle" aria-label={chatOpen ? 'Close chat' : 'Open chat'} onClick={onChatToggle} aria-expanded={chatOpen}><FaCommentAlt />{unread > 0 && <b className="unread-dot">{unread > 9 ? '9+' : unread}</b>}</button><button className="icon-button" aria-label="Fullscreen room options" onClick={() => setMoreOpen(true)}><FaEllipsisH /></button><button className="icon-button" onClick={toggleFullscreen} aria-label="Exit fullscreen" title="Exit fullscreen"><FaCompress /></button></div></div>
    <header className="room-header" data-room-bar="top" onPointerEnter={event => enterBar('top', event)} onPointerLeave={() => leaveBar('top')}>
      <a className="room-brand" href="/" aria-label="SameRow home">SameRow</a>
      <div className="room-heading"><h1 title={roomId}>{roomId}</h1></div>
      <div className="room-header-actions"><span className={`connection-state ${connected ? '' : 'is-offline'}`}><i />{connected ? 'Connected' : 'Reconnecting'}</span><button className="sr-button header-invite" onClick={onInvite}><FaCopy /> Invite friends</button><button className={`icon-button chat-toggle ${chatOpen ? 'is-active' : ''}`} aria-label={chatOpen ? 'Close chat' : `Open chat${unread ? `, ${unread} unread messages` : ''}`} aria-expanded={chatOpen} onClick={onChatToggle}><FaCommentAlt />{unread > 0 && <b className="unread-dot">{unread > 9 ? '9+' : unread}</b>}</button></div>
    </header>
    {!connected && <div className="connection-banner" role="status">Connection interrupted. Your view is preserved while we reconnect.</div>}
    <div className="room-workspace">
      <main className="room-canvas" aria-label="Room content">
        <div className="stage-heading"><div><span className="room-eyebrow">{contentFocused ? 'Shared content' : 'Room'}</span><h2>{contentFocused ? currentSource.label : participants.length === 1 ? 'Waiting for others' : 'Everyone'}</h2></div><span className="people-count"><FaUsers /> {participants.length}<span> in the room</span></span></div>
        <div className="source-bar" data-room-bar="top" onPointerEnter={event => enterBar('top', event)} onPointerLeave={() => leaveBar('top')}><div className="source-tabs" role="group" aria-label="Choose what to view">{sources.map(source => <button key={source.id} aria-pressed={source.id === sourceId} className={source.id === sourceId ? 'is-active' : ''} onClick={() => setSelectedSource(source.id)}>{source.icon}<span>{source.label}</span>{source.id === sourceId && sourceId !== 'people' && <i className="live-dot" />}</button>)}</div><button className="icon-button expand-stage" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>{fullscreen ? <FaCompress /> : <FaExpand />}</button></div>
        <div className={`room-composition ${contentFocused ? 'has-content' : ''} ${railHidden && contentFocused ? 'rail-hidden' : ''}`}>
          <section className="content-stage" hidden={!contentFocused} aria-label={currentSource.label}>
            {screenShares.map(source => <div key={source.id} className="source-pane" hidden={sourceId !== source.id}>{source.node || <MediaTile participant={source} screen hidden={sourceId !== source.id} />}{source.isSelf && <div className="screen-share-actions" data-room-bar="top" onPointerEnter={event => enterBar('top', event)} onPointerLeave={() => leaveBar('top')}><span><i className="live-dot" /> You’re sharing your screen</span><button onClick={onStopScreen}>Stop sharing</button></div>}</div>)}
            <div className="source-pane" hidden={sourceId !== 'youtube'}>{typeof youtube?.node === 'function' ? youtube.node(sourceId === 'youtube') : youtube?.node}</div>
            <div className="source-pane" hidden={sourceId !== 'jellyfin'}>{typeof jellyfin?.node === 'function' ? jellyfin.node(sourceId === 'jellyfin') : jellyfin?.node}</div>
          </section>
          <div ref={participantRef} className={`participant-section ${immersive ? `floating-participants floating-participants--${floatingLayout}` : ''}`} style={immersive && participantPosition ? { left: participantPosition.x, top: participantPosition.y } : undefined} hidden={contentFocused && railHidden}>
            {immersive && <div className="participant-float-controls">
              <button className="participant-drag-handle" aria-label="Move participant panel" title="Drag to move · Arrow keys to reposition" onPointerDown={startParticipantDrag} onPointerMove={dragParticipants} onPointerUp={endParticipantDrag} onPointerCancel={endParticipantDrag} onLostPointerCapture={endParticipantDrag} onKeyDown={event => {
                const step = event.shiftKey ? 40 : 10;
                const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
                if (!delta) return;
                event.preventDefault();
                moveParticipants(participantRef.current.offsetLeft + delta[0], participantRef.current.offsetTop + delta[1]);
              }}>⠿ <span>Move</span></button>
              <select aria-label="Fullscreen participant layout" value={participantLayout} onChange={event => setParticipantLayout(event.target.value)}>
                <option value="auto">Auto layout</option><option value="strip">Horizontal strip</option><option value="vertical">Vertical strip</option><option value="circles">Circles</option>
              </select>
            </div>}
            <div className="participant-rail-label"><span>IN THE ROOM <b>{participants.length}</b></span><button className="icon-button" aria-label="Hide participants" onClick={() => setRailHidden(true)}><FaChevronDown /></button></div>
            <div ref={gridRef} className={`participant-grid ${pinnedId && !contentFocused ? 'has-pin' : ''}`} style={{ '--columns': columns, '--participant-count': Math.max(1, participants.length - 1) }}>
              {participants.map(person => <MediaTile key={person.id} participant={person} focused={!contentFocused && pinnedId === person.id} onPin={participants.length > 1 ? () => pinParticipant(person.id) : undefined} />)}
            </div>
            {participants.length === 1 && !contentFocused && <div className="room-empty"><span className="empty-orbit"><FaUsers /></span><h3>Waiting for others</h3><p>Invite someone to join this room.</p><button className="sr-button" onClick={onInvite}><FaCopy /> Copy invite link</button></div>}
          </div>
        </div>
        {contentFocused && <div className="stage-bottom"><span><i className="live-dot" /> Shared in this room</span><button onClick={() => setRailHidden(value => !value)}>{railHidden ? <FaChevronUp /> : <FaChevronDown />}{railHidden ? 'Show participants' : 'Hide participants'}</button></div>}
      </main>
      {chat}
    </div>
    <footer className="room-toolbar" data-room-bar="bottom" onPointerEnter={event => enterBar('bottom', event)} onPointerLeave={() => leaveBar('bottom')}>
      <div className="toolbar-note"><span className="toolbar-dot" /><div><strong>{preview ? 'Layout preview' : userName}</strong><span>{preview ? 'Sample room' : (muted ? 'Microphone off' : 'Microphone on')}</span></div></div>
      <div className="toolbar-controls"><Control label={muted ? 'Unmute microphone' : 'Mute microphone'} active={!muted} aria-pressed={!muted} onClick={onToggleMute}>{muted ? <FaMicrophoneSlash /> : <FaMicrophone />}</Control><Control label={videoOff ? 'Turn camera on' : 'Turn camera off'} active={!videoOff} aria-pressed={!videoOff} onClick={onToggleVideo}>{videoOff ? <FaVideoSlash /> : <FaVideo />}</Control><Control label="Share something" onClick={onShare}><FaPlus /></Control><Control label="More options" aria-expanded={moreOpen} onClick={() => setMoreOpen(true)}><FaEllipsisH /></Control><span className="toolbar-divider" /><Control label="Leave room" danger onClick={onLeave}><FaPhoneSlash /></Control></div>
      <div className="toolbar-end"><FaCircle /><span>SameRow</span></div>
    </footer>
    {notification && <div className="room-toast" role="status">{notification}</div>}
    {immersive && <><div className="room-edge-zone room-edge-zone--top" data-room-bar="top" onPointerEnter={event => enterBar('top', event)} onPointerLeave={() => leaveBar('top')} onPointerDown={revealBars} aria-hidden="true" /><div className="room-edge-zone room-edge-zone--bottom" data-room-bar="bottom" onPointerEnter={event => enterBar('bottom', event)} onPointerLeave={() => leaveBar('bottom')} onPointerDown={revealBars} aria-hidden="true" /></>}
    <Dialog open={moreOpen} title="Room options" description="View and room settings." onClose={() => setMoreOpen(false)}>
      <div className="room-menu"><button onClick={moreAction(onChatToggle)}><FaCommentAlt /><span>{chatOpen ? 'Close chat' : 'Open chat'}{unread > 0 ? ` (${unread} unread)` : ''}</span></button><button onClick={moreAction(onInvite)}><FaCopy /><span>Invite friends</span></button><button onClick={moreAction(() => { setSelectedSource('people'); setPin(null); })}><FaThLarge /><span>Show everyone in a grid</span></button><button onClick={moreAction(() => { setRailHidden(value => !value); })} disabled={!contentFocused}><FaUsers /><span>{railHidden ? 'Show' : 'Hide'} participant strip</span></button><button onClick={() => { setMoreOpen(false); toggleFullscreen(); }}><FaExpand /><span>{fullscreen ? 'Exit' : 'Enter'} fullscreen</span></button><button onClick={moreAction(() => setDiagnosticsOpen(true))}><FaSlidersH /><span>Connection details</span></button></div>
    </Dialog>
    <Dialog open={diagnosticsOpen} title="Connection details" onClose={() => setDiagnosticsOpen(false)}><div className="room-diagnostics"><p>Room <strong>{roomId}</strong></p><p>Status <strong>{connected ? 'Connected' : 'Reconnecting'}</strong></p><p>Participants <strong>{participants.length}</strong></p>{diagnostics}</div></Dialog>
  </div></RoomPresentation.Provider>;
}
