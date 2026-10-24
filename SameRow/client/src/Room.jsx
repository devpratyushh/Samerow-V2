import { useEffect, useEffectEvent, useRef, useState } from 'react';
import Peer from 'simple-peer';
import { FaDesktop, FaYoutube, FaPlayCircle, FaStop } from 'react-icons/fa';
import YouTubePlayer from './YouTubePlayer';
import { parseYouTubeUrl } from './youtube';
import { connectYouTubeRoom } from './youtubeRoom';
import Chat from './Chat';
import JellyfinPump from './JellyfinPump';
import MSEPlayer from './MSEPlayer';
import RoomView, { MediaStatus } from './components/RoomView';
import Dialog from './components/Dialog';
import PlaybackControls from './components/PlaybackControls';
import { formatTime } from './components/roomLayout';
function setMediaBitrate(sdp, mediaType, bitrate) {
    let lines = sdp.split("\n");
    let line = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("m=" + mediaType) === 0) {
            line = i;
            break;
        }
    }
    if (line === -1) return sdp;
    line++;
    while (lines[line] && lines[line].indexOf("i=") === 0 || lines[line].indexOf("c=") === 0) line++;
    if (lines[line] && lines[line].indexOf("b=") === 0) {
        lines[line] = "b=AS:" + bitrate;
        return lines.join("\n");
    }
    var newLines = lines.slice(0, line);
    newLines.push("b=AS:" + bitrate);
    newLines = newLines.concat(lines.slice(line, lines.length));
    return newLines.join("\n");
}

function preferCodec(sdp, codec) {
    let sdpLines = sdp.split('\r\n');
    let mLineIndex = -1;
    for (let i = 0; i < sdpLines.length; i++) {
        if (sdpLines[i].search('m=video') !== -1) { mLineIndex = i; break; }
    }
    if (mLineIndex === -1) return sdp;
    let payload = -1;
    for (let i = mLineIndex; i < sdpLines.length; i++) {
        if (sdpLines[i].indexOf('a=rtpmap') !== -1 && sdpLines[i].search(codec) !== -1) {
            let parts = sdpLines[i].split(' ');
            let rtpmap = parts[0].split(':');
            payload = rtpmap[1];
            break;
        }
    }
    if (payload === -1) return sdp;
    let mLine = sdpLines[mLineIndex].split(' ');
    let newMLine = [mLine[0], mLine[1], mLine[2]];
    newMLine.push(payload);
    for (let i = 3; i < mLine.length; i++) { if (mLine[i] !== payload) newMLine.push(mLine[i]); }
    sdpLines[mLineIndex] = newMLine.join(' ');
    return sdpLines.join('\r\n');
}

const PEER_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
    ],
    sdpTransform: (sdp) => {
        let newSdp = sdp;
        newSdp = preferCodec(newSdp, 'H264');
        newSdp = setMediaBitrate(newSdp, 'video', 4000);
        return newSdp;
    }
};


function createFallbackStream() {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  canvas.getContext('2d').fillRect(0, 0, 640, 360);
  const stream = canvas.captureStream(1);
  stream.getTracks().forEach(track => { track.enabled = false; });
  return stream;
}

function JellyfinControls({ currentTime, duration, playing, isHost, onPlayPause, onSeek, onStop, onSettings, volume, muted, onVolumeChange, onMute }) {
  return <PlaybackControls label={isHost ? 'for everyone' : 'for me'} playing={playing} currentTime={currentTime} duration={duration} canSeek={isHost} onTogglePlay={onPlayPause} onSeek={onSeek} volume={volume} muted={muted} onVolumeChange={onVolumeChange} onMute={onMute} note={isHost ? 'You control the movie' : 'Host controls seeking'}>{isHost && <><button className="player-control" aria-label="Jellyfin settings" title="Jellyfin settings" onClick={onSettings}><FaPlayCircle /></button><button className="player-control" aria-label="Stop movie for everyone" title="Stop movie for everyone" onClick={onStop}><FaStop /></button></>}</PlaybackControls>;
}

export default function Room({ socket, roomId, userName, leaveRoom, userStream, initialMuted, initialVideoOff }) {
  const [activeStream] = useState(() => userStream || createFallbackStream());
  const [ownsFallback] = useState(() => !userStream);
  const [peers, setPeers] = useState([]);
  const peersRef = useRef([]);
  const [muted, setMuted] = useState(initialMuted);
  const [videoOff, setVideoOff] = useState(initialVideoOff);
  const [peerStates, setPeerStates] = useState({});
  const [connected, setConnected] = useState(socket.connected);
  const [youtubeState, setYoutubeState] = useState(null);
  const youtubeRoomRef = useRef(null);
  const [isSubmittingUrl, setIsSubmittingUrl] = useState(false);
  const [inputUrl, setInputUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [unread, setUnread] = useState(0);
  const [notification, setNotification] = useState('');
  const toastTimer = useRef(null);
  const [myScreenStream, setMyScreenStream] = useState(null);
  const screenStreamRef = useRef(null);
  const msePlayerRef = useRef(null);
  const jellyfinPumpRef = useRef(null);
  const [jellyfinActive, setJellyfinActive] = useState(false);
  const [isJellyfinHost, setIsJellyfinHost] = useState(false);
  const [showJellyfinInput, setShowJellyfinInput] = useState(false);
  const [jellyfinDuration, setJellyfinDuration] = useState(0);
  const [jellyfinCurrentTime, setJellyfinCurrentTime] = useState(0);
  const [jellyfinPlaying, setJellyfinPlaying] = useState(true);
  const [movieVolume, setMovieVolume] = useState(1);
  const [movieMuted, setMovieMuted] = useState(false);
  const [jellyfinBuffered, setJellyfinBuffered] = useState(0);
  const [jellyfinStatus, setJellyfinStatus] = useState({ state: 'idle' });
  const jellyfinOffsetRef = useRef(0);
  const jellyfinStateRef = useRef({ host: false, active: false, duration: 0, playing: true, time: 0, pumping: false });
  const seekTimer = useRef(null);

  useEffect(() => {
    jellyfinStateRef.current = { ...jellyfinStateRef.current, host: isJellyfinHost, active: jellyfinActive, duration: jellyfinDuration, playing: jellyfinPlaying, time: jellyfinCurrentTime };
  }, [isJellyfinHost, jellyfinActive, jellyfinDuration, jellyfinPlaying, jellyfinCurrentTime]);
  const notify = (message) => {
    clearTimeout(toastTimer.current); setNotification(message);
    toastTimer.current = setTimeout(() => setNotification(''), 5000);
  };
  const broadcastJellyfin = (message) => {
    const text = JSON.stringify(message);
    peersRef.current.filter(person => !person.isScreenShare).forEach(({ peer }) => {
      if (peer?.connected && !peer.destroyed) { try { peer.send(text); } catch { /* A closing peer will be removed by its close handler. */ } }
    });
  };
  const handleJellyfinData = (data) => {
    let text = typeof data === 'string' ? data : null;
    if (!text && data instanceof Uint8Array && data.length < 1000 && data[0] === 123) text = new TextDecoder().decode(data);
    if (text) {
      try {
        const message = JSON.parse(text);
        if (!message.type?.startsWith('JELLYFIN_')) return;
        if (message.type === 'JELLYFIN_END') { setJellyfinActive(false); return; }
        setJellyfinActive(true);
        if (message.type === 'JELLYFIN_METADATA') setJellyfinDuration(message.duration);
        if (message.type === 'JELLYFIN_COMPLETE') msePlayerRef.current?.endStream();
        if (message.type === 'JELLYFIN_FLUSH') msePlayerRef.current?.flush();
        if (message.type === 'JELLYFIN_OFFSET') { jellyfinOffsetRef.current = message.offset; setJellyfinCurrentTime(message.offset); }
        if (message.type === 'JELLYFIN_STATE') {
          setJellyfinPlaying(message.isPlaying);
          if (message.isPlaying) msePlayerRef.current?.play(); else msePlayerRef.current?.pause();
          const physicalTime = msePlayerRef.current?.getCurrentTime() || 0;
          if (Number.isFinite(message.currentTime) && Math.abs(physicalTime + jellyfinOffsetRef.current - message.currentTime) > 2) msePlayerRef.current?.setCurrentTime(Math.max(0, message.currentTime - jellyfinOffsetRef.current));
        }
      } catch { notify('A movie update could not be read. Try reconnecting to the room.'); }
    } else { setJellyfinActive(true); msePlayerRef.current?.appendChunk(data); }
  };
  const updatePeerStream = (id, stream, screen) => {
    peersRef.current = peersRef.current.map(person => person.peerID === id && person.isScreenShare === screen ? { ...person, stream } : person);
    setPeers(previous => previous.map(person => person.peerID === id && person.isScreenShare === screen ? { ...person, stream } : person));
  };
  const createPeer = (remoteId, stream, remoteName, screen = false, incomingSignal = null) => {
    const peer = new Peer({ initiator: !incomingSignal, trickle: true, stream: incomingSignal && screen ? undefined : stream, config: PEER_CONFIG });
    peer.on('signal', signal => socket.emit('signal', { signal, to: remoteId, userName, isScreenShare: screen }));
    peer.on('stream', remoteStream => updatePeerStream(remoteId, remoteStream, screen));
    if (!screen) peer.on('data', handleJellyfinData);
    peer.on('connect', () => {
      const movie = jellyfinStateRef.current;
      if (!screen && movie.host && movie.active && movie.pumping) {
        const logicalTime = movie.time;
        msePlayerRef.current?.flush(); jellyfinOffsetRef.current = logicalTime;
        broadcastJellyfin({ type: 'JELLYFIN_METADATA', duration: movie.duration });
        broadcastJellyfin({ type: 'JELLYFIN_FLUSH' });
        broadcastJellyfin({ type: 'JELLYFIN_OFFSET', offset: logicalTime });
        broadcastJellyfin({ type: 'JELLYFIN_STATE', isPlaying: movie.playing, currentTime: logicalTime });
        jellyfinPumpRef.current?.restartPump(logicalTime);
      }
    });
    peer.on('close', () => {
      peersRef.current = peersRef.current.filter(person => person.peer !== peer);
      setPeers(previous => previous.filter(person => person.peer !== peer));
    });
    peer.on('error', () => notify(`The connection to ${remoteName || 'a participant'} was interrupted.`));
    if (incomingSignal) peer.signal(incomingSignal);
    return peer;
  };
  const addConnection = (id, name, stream, screen = false, signal = null, outgoingScreen = false) => {
    const peer = createPeer(id, stream, name, screen, signal);
    const entry = { peerID: id, peer, userName: name, isScreenShare: screen, outgoingScreen, stream: null };
    peersRef.current.push(entry);
    if (!outgoingScreen) setPeers(previous => [...previous, entry]);
  };

  const onUserConnected = useEffectEvent(({ userId, userName: name }) => {
    if (userId === socket.id || peersRef.current.some(person => person.peerID === userId && !person.isScreenShare)) return;
    addConnection(userId, name, activeStream);
    if (screenStreamRef.current) addConnection(userId, name, screenStreamRef.current, true, null, true);
    socket.emit('update-user-state', { roomId, type: 'audio', enabled: !muted });
    socket.emit('update-user-state', { roomId, type: 'video', enabled: !videoOff });
  });
  const onSignal = useEffectEvent(payload => {
    if (payload.from === socket.id) return;
    const screen = !!payload.isScreenShare;
    const existing = peersRef.current.find(person => person.peerID === payload.from && person.isScreenShare === screen);
    if (existing) { try { existing.peer.signal(payload.signal); } catch { /* Late signals can arrive after a peer closes. */ } }
    else if (payload.signal.type === 'offer') addConnection(payload.from, payload.userName, activeStream, screen, payload.signal);
  });
  const onJoin = useEffectEvent(() => {
    setConnected(true);
    socket.emit('join-room', roomId, userName);
    socket.emit('sync-request', roomId);
    socket.emit('update-user-state', { roomId, type: 'audio', enabled: !muted });
    socket.emit('update-user-state', { roomId, type: 'video', enabled: !videoOff });
  });

  useEffect(() => {
    const room = connectYouTubeRoom({
      socket, roomId, userName, joinRoom: false,
      onState: setYoutubeState,
      onSubmitted: () => {
        setIsSubmittingUrl(false);
        setInputUrl(''); setUrlError(''); setShowUrlInput(false);
      },
      onError: message => {
        setIsSubmittingUrl(false);
        setUrlError(message); setShowUrlInput(true);
      }
    });
    youtubeRoomRef.current = room;
    return () => { room.dispose(); youtubeRoomRef.current = null; };
  }, [socket, roomId, userName]);

  useEffect(() => {
    const disconnected = () => setConnected(false);
    const joined = () => onJoin();
    const userConnected = payload => onUserConnected(payload);
    const signal = payload => onSignal(payload);
    const stateUpdated = ({ userId, type, enabled }) => setPeerStates(previous => ({ ...previous, [userId]: { ...previous[userId], [type]: enabled } }));
    const userDisconnected = id => {
      const departed = peersRef.current.filter(person => person.peerID === id);
      departed.forEach(person => person.peer.destroy());
      peersRef.current = peersRef.current.filter(person => person.peerID !== id);
      setPeers(previous => previous.filter(person => person.peerID !== id));
      setPeerStates(previous => { const next = { ...previous }; delete next[id]; return next; });
    };
    socket.on('connect', joined); socket.on('disconnect', disconnected);
    socket.on('user-connected', userConnected); socket.on('user-disconnected', userDisconnected); socket.on('signal', signal); socket.on('user-state-updated', stateUpdated);
    if (socket.connected) joined();
    return () => {
      clearTimeout(seekTimer.current); clearTimeout(toastTimer.current);
      socket.off('connect', joined); socket.off('disconnect', disconnected);
      socket.off('user-connected', userConnected); socket.off('user-disconnected', userDisconnected); socket.off('signal', signal); socket.off('user-state-updated', stateUpdated);
      peersRef.current.forEach(person => person.peer.destroy()); peersRef.current = [];
      screenStreamRef.current?.getTracks().forEach(track => track.stop());
      if (ownsFallback) activeStream.getTracks().forEach(track => track.stop());
    };
  }, [socket, roomId, activeStream, ownsFallback]);
  // Permission can resolve after joining. Upgrade tracks in place instead of
  // recreating the room, players, or existing peer connections.
  useEffect(() => {
    if (!userStream || userStream === activeStream) return;
    for (const newTrack of userStream.getTracks()) {
      if (activeStream.getTracks().includes(newTrack)) continue;
      const oldTrack = activeStream.getTracks().find(track => track.kind === newTrack.kind);
      newTrack.enabled = newTrack.kind === 'audio' ? !muted : !videoOff;
      for (const person of peersRef.current.filter(person => !person.isScreenShare && !person.peer.destroyed)) {
        if (oldTrack) person.peer.replaceTrack(oldTrack, newTrack, activeStream);
        else person.peer.addTrack(newTrack, activeStream);
      }
      if (oldTrack) { activeStream.removeTrack(oldTrack); oldTrack.stop(); }
      activeStream.addTrack(newTrack);
    }
  }, [userStream, activeStream, muted, videoOff]);
  useEffect(() => { activeStream.getAudioTracks().forEach(track => { track.enabled = !muted; }); }, [activeStream, muted]);
  useEffect(() => { activeStream.getVideoTracks().forEach(track => { track.enabled = !videoOff; }); }, [activeStream, videoOff]);

  useEffect(() => {
    if (!jellyfinActive) return;
    const timer = setInterval(() => {
      const player = msePlayerRef.current; if (!player) return;
      const time = player.getCurrentTime() + jellyfinOffsetRef.current;
      setJellyfinCurrentTime(time); setJellyfinBuffered(player.getBufferAhead());
      if (socket.connected) {
        for (const [type, enabled] of Object.entries({ jellyfinTime: time, jellyfinPlaying, jellyfinBuffering: jellyfinStatus.state === 'buffering', jellyfinForwardCache: player.getBufferAhead() })) socket.emit('update-user-state', { roomId, type, enabled });
      }
    }, 500);
    return () => clearInterval(timer);
  }, [jellyfinActive, jellyfinPlaying, jellyfinStatus.state, socket, roomId]);

  const toggleMute = () => { setMuted(value => !value); socket.emit('update-user-state', { roomId, type: 'audio', enabled: muted }); };
  const toggleVideo = () => { setVideoOff(value => !value); socket.emit('update-user-state', { roomId, type: 'video', enabled: videoOff }); };
  const stopScreenShare = () => {
    screenStreamRef.current?.getTracks().forEach(track => { track.onended = null; track.stop(); }); screenStreamRef.current = null; setMyScreenStream(null);
    const outgoing = peersRef.current.filter(person => person.outgoingScreen);
    outgoing.forEach(person => person.peer.destroy());
  };
  const startScreenShare = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) { notify('Screen sharing is unavailable in this browser. You can share a YouTube video instead.'); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenStreamRef.current = stream; setMyScreenStream(stream);
      stream.getVideoTracks()[0].onended = stopScreenShare;
      peersRef.current.filter(person => !person.isScreenShare).forEach(person => addConnection(person.peerID, person.userName, stream, true, null, true));
      setShowShare(false);
    } catch (error) { if (error.name !== 'NotAllowedError') notify('Screen sharing could not start. Please try again.'); }
  };
  const submitUrl = event => {
    event.preventDefault();
    if (isSubmittingUrl) return;
    const video = parseYouTubeUrl(inputUrl);
    if (!video) { setUrlError('Enter a valid YouTube watch, Shorts, live, or youtu.be link.'); return; }
    if (!connected) { setUrlError('Wait for the room to reconnect, then try again.'); return; }
    setUrlError(''); setIsSubmittingUrl(true);
    youtubeRoomRef.current.submit(video);
  };
  const invite = async () => {
    const url = new URL('/', window.location.origin); url.searchParams.set('room', roomId);
    try { await navigator.clipboard.writeText(url.href); notify('Invite link copied.'); }
    catch { notify(`Invite your friends: ${url.href}`); }
  };
  const playPause = () => {
    const playing = !jellyfinPlaying; setJellyfinPlaying(playing);
    if (playing) msePlayerRef.current?.play(); else msePlayerRef.current?.pause();
    if (isJellyfinHost) broadcastJellyfin({ type: 'JELLYFIN_STATE', isPlaying: playing, currentTime: (msePlayerRef.current?.getCurrentTime() || 0) + jellyfinOffsetRef.current });
  };
  const seek = time => {
    if (!isJellyfinHost || !jellyfinDuration) return;
    clearTimeout(seekTimer.current); setJellyfinPlaying(false); msePlayerRef.current?.pause();
    broadcastJellyfin({ type: 'JELLYFIN_FLUSH' }); broadcastJellyfin({ type: 'JELLYFIN_OFFSET', offset: time }); broadcastJellyfin({ type: 'JELLYFIN_STATE', isPlaying: false, currentTime: time });
    msePlayerRef.current?.flush(); jellyfinOffsetRef.current = time; setJellyfinCurrentTime(time); jellyfinPumpRef.current?.restartPump(time);
    seekTimer.current = setTimeout(() => { setJellyfinPlaying(true); msePlayerRef.current?.play(); broadcastJellyfin({ type: 'JELLYFIN_STATE', isPlaying: true, currentTime: time }); }, 2000);
  };
  const stopMovie = () => { clearTimeout(seekTimer.current); jellyfinPumpRef.current?.stopPump(); broadcastJellyfin({ type: 'JELLYFIN_END' }); setJellyfinActive(false); setJellyfinPlaying(false); };
  const retryMovie = () => {
    if (jellyfinStatus.state === 'blocked') msePlayerRef.current?.play();
    else if (isJellyfinHost) { msePlayerRef.current?.retry(); jellyfinPumpRef.current?.restartPump(jellyfinCurrentTime); }
    else notify('Ask the host to restart the stream to reconnect your movie.');
  };
  const participants = [{ id: 'self', name: userName, stream: activeStream, muted: muted || !userStream, videoOff: videoOff || !userStream, isSelf: true }, ...peers.filter(person => !person.isScreenShare).map(person => ({ id: person.peerID, name: person.userName, stream: person.stream, muted: peerStates[person.peerID]?.audio === false, videoOff: peerStates[person.peerID]?.video === false }))];
  const screenShares = [...(myScreenStream ? [{ id: 'screen-self', name: userName, stream: myScreenStream, isSelf: true }] : []), ...peers.filter(person => person.isScreenShare && !person.outgoingScreen).map(person => ({ id: `screen-${person.peerID}`, name: person.userName, stream: person.stream }))];

  return <>
    <RoomView roomId={roomId} userName={userName} connected={connected} participants={participants} screenShares={screenShares} muted={muted} videoOff={videoOff} onToggleMute={toggleMute} onToggleVideo={toggleVideo} onShare={() => setShowShare(true)} onLeave={leaveRoom} onInvite={invite} onStopScreen={stopScreenShare} notification={notification} chatOpen={showChat} onChatToggle={() => setShowChat(value => !value)} unread={unread}
      chat={<Chat roomId={roomId} userName={userName} open={showChat} onClose={() => setShowChat(false)} onUnreadChange={setUnread} />}
      youtube={{ active: Boolean(youtubeState?.url), node: focused => youtubeState?.url ? <YouTubePlayer key={youtubeState.sessionId} state={youtubeState} socket={socket} roomId={roomId} focused={focused} onClose={() => youtubeRoomRef.current.close()} /> : null }}
      jellyfin={{ active: jellyfinActive, node: focused => <><MSEPlayer ref={msePlayerRef} enabled={jellyfinActive} muted={!focused || movieMuted} volume={movieVolume} onStatusChange={setJellyfinStatus} /><MediaStatus status={jellyfinStatus} onRetry={retryMovie} />{jellyfinActive && <JellyfinControls currentTime={jellyfinCurrentTime} duration={jellyfinDuration} playing={jellyfinPlaying} isHost={isJellyfinHost} onPlayPause={playPause} onSeek={seek} onStop={stopMovie} onSettings={() => setShowJellyfinInput(true)} volume={movieVolume} muted={movieMuted} onVolumeChange={value => { setMovieVolume(value); setMovieMuted(value === 0); }} onMute={() => { if (movieMuted || movieVolume === 0) { if (movieVolume === 0) setMovieVolume(0.5); setMovieMuted(false); } else setMovieMuted(true); }} />}</> }}
      diagnostics={<><p>Socket <strong>{socket.id || 'Waiting'}</strong></p>{jellyfinActive && <><p>Movie position <strong>{formatTime(jellyfinCurrentTime)}</strong></p><p>Buffer ahead <strong>{Math.round(jellyfinBuffered)}s</strong></p>{Object.entries(peerStates).map(([id,state]) => <p key={id}>{participants.find(person => person.id === id)?.name || 'Participant'}<strong>{formatTime(state.jellyfinTime || 0)}</strong></p>)}</>}</>} />
    <Dialog open={showShare} title="Share with the room" description="Choose what to share." onClose={() => setShowShare(false)}><div className="room-share-options"><button onClick={myScreenStream ? () => { stopScreenShare(); setShowShare(false); } : startScreenShare}><FaDesktop /><span><strong>{myScreenStream ? 'Stop sharing your screen' : 'Your screen'}</strong><small>Share a tab, an app, or your desktop.</small></span></button><button onClick={() => { setShowShare(false); setShowUrlInput(true); }}><FaYoutube /><span><strong>A YouTube video</strong><small>Watch a video together.</small></span></button><button onClick={() => { setShowShare(false); setIsJellyfinHost(true); if (!jellyfinActive) { jellyfinOffsetRef.current = 0; setJellyfinCurrentTime(0); setJellyfinDuration(0); setJellyfinPlaying(true); setJellyfinStatus({ state: 'idle' }); } setJellyfinActive(true); setShowJellyfinInput(true); }}><FaPlayCircle /><span><strong>Your Jellyfin library</strong><small>Stream a video from your server.</small></span></button></div></Dialog>
    <Dialog open={showUrlInput} title="Share a YouTube video" description="Paste a YouTube link. Playback controls are shared with the room." onClose={() => setShowUrlInput(false)}><form onSubmit={submitUrl}><label className="room-field">YouTube video link<input type="url" data-autofocus disabled={isSubmittingUrl} placeholder="https://youtube.com/watch?v=…" value={inputUrl} onChange={event => { setInputUrl(event.target.value); setUrlError(''); }} aria-describedby={urlError ? 'youtube-url-error' : undefined} required /></label>{urlError && <p id="youtube-url-error" className="room-field-error" role="alert">{urlError}</p>}<button className="sr-button sr-button--primary" type="submit" disabled={!inputUrl.trim() || !connected || isSubmittingUrl}>{isSubmittingUrl ? 'Opening video…' : 'Watch together'}</button></form></Dialog>
    {isJellyfinHost && <JellyfinPump ref={jellyfinPumpRef} visible={showJellyfinInput} onClose={() => setShowJellyfinInput(false)} onStatusChange={status => { jellyfinStateRef.current.pumping = status.state === 'streaming' || status.state === 'loading' || status.state === 'complete'; if (status.state === 'complete') { msePlayerRef.current?.endStream(); broadcastJellyfin({ type: 'JELLYFIN_COMPLETE' }); } if (status.state === 'error') setJellyfinStatus(status); }} onMetadata={metadata => { setJellyfinDuration(metadata.duration); broadcastJellyfin({ type: 'JELLYFIN_METADATA', duration: metadata.duration }); }} onChunkReceived={async (chunk, { signal } = {}) => {
      while (!signal?.aborted && msePlayerRef.current?.getBufferAhead() > 60) { await new Promise(resolve => setTimeout(resolve, 100)); }
      if (signal?.aborted) return;
      msePlayerRef.current?.appendChunk(chunk);
      for (let offset = 0; !signal?.aborted && offset < chunk.length; offset += 65424) {
        const slice = chunk.slice(offset, offset + 65424);
        for (const person of peersRef.current.filter(person => !person.isScreenShare)) {
          while (!signal?.aborted && !person.peer.destroyed && person.peer._channel?.bufferedAmount > 256 * 1024) await new Promise(resolve => setTimeout(resolve, 10));
          if (!signal?.aborted && person.peer.connected && !person.peer.destroyed) { try { person.peer.send(slice); } catch { /* Peer closed during transfer. */ } }
        }
      }
    }} />}
  </>;
}
