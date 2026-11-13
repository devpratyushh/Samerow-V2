import './browserGlobals';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import Peer from 'simple-peer';
import { connectGroupCall } from './groupCall';
import { maintainRoomMembership } from './roomMembership';
import { FaDesktop, FaYoutube, FaPlayCircle } from 'react-icons/fa';
import YouTubePlayer from './YouTubePlayer';
import { parseYouTubeUrl } from './youtube';
import { preloadYouTube } from './youtubePreload';
import { connectYouTubeRoom } from './youtubeRoom';
import Chat from './Chat';
import JellyfinNativePlayer from './JellyfinNativePlayer';
import JellyfinPlayer from './JellyfinPlayer';

import JellyfinDialog from './components/JellyfinDialog';
import { useJellyfinRoom } from './jellyfinRoom';
import { mediaBudget, tunePeer } from './peerQuality';
import RoomView from './components/RoomView';
import Dialog from './components/Dialog';
import NerdStats from './components/NerdStats';
const PEER_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] };

function RoomJellyfinPlayer({ state, ...props }) {
  const [webPlayer, setWebPlayer] = useState(false);
  const switching = useRef(false);
  const releaseUrl = `${props.base}/api/jellyfin/${state.accessToken}/release`;
  useEffect(() => () => { fetch(releaseUrl, { method: 'POST', keepalive: true }).catch(() => {}); }, [releaseUrl]);
  const openWebPlayer = async () => {
    if (switching.current) return;
    switching.current = true;
    // Release aborts requests for this viewer. Finish it before opening the iframe.
    try {
      await fetch(releaseUrl, { method: 'POST' });
    } catch {
      // The Web player can still reconnect with the current viewer token.
    } finally {
      switching.current = false;
      setWebPlayer(true);
    }
  };
  if (state.native && webPlayer) {
    return <JellyfinNativePlayer state={state} {...props} onOpenSameRow={() => setWebPlayer(false)} />;
  }
  return <JellyfinPlayer state={state} {...props} onOpenNative={state.native ? openWebPlayer : undefined} />;
}
function createFallbackStream() {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  canvas.getContext('2d').fillRect(0, 0, 640, 360);
  const stream = canvas.captureStream(1);
  stream.getTracks().forEach(track => { track.enabled = false; });
  return stream;
}

export default function Room({ socket, roomId, roomInvite, inviteOrigin, jellyfinAddress, userName, leaveRoom, userStream, initialMuted, initialVideoOff }) {
  const [activeStream] = useState(() => userStream || createFallbackStream());
  const [ownsFallback] = useState(() => !userStream);
  const [peers, setPeers] = useState([]);
  const peersRef = useRef([]);
  const [muted, setMuted] = useState(initialMuted);
  const [videoOff, setVideoOff] = useState(initialVideoOff);
  const [peerStates, setPeerStates] = useState({});
  const [connected, setConnected] = useState(false);
  const [mediaMode, setMediaMode] = useState(socket.roomConfig?.mediaMode || null);
  const groupCallRef = useRef(null);
  const [callQuality, setCallQuality] = useState('balanced');
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
  const [showJellyfinInput, setShowJellyfinInput] = useState(false);
  const jellyfin = useJellyfinRoom(socket, roomId);
  const notify = (message) => {
    clearTimeout(toastTimer.current); setNotification(message);
    toastTimer.current = setTimeout(() => setNotification(''), 5000);
  };
  const updatePeerStream = (id, stream, screen, screenOwner) => {
    peersRef.current = peersRef.current.map(person => person.peerID === id && person.isScreenShare === screen && (!screen || person.screenOwner === screenOwner) ? { ...person, stream } : person);
    setPeers(previous => previous.map(person => person.peerID === id && person.isScreenShare === screen && (!screen || person.screenOwner === screenOwner) ? { ...person, stream } : person));
  };
  const createPeer = (remoteId, stream, remoteName, screen = false, incomingSignal = null, screenOwner = null) => {
    const peer = new Peer({ initiator: !incomingSignal, trickle: true, stream: incomingSignal && screen ? undefined : stream, config: PEER_CONFIG });
    peer.on('signal', signal => socket.emit('signal', { signal, to: remoteId, userName, isScreenShare: screen, screenOwner }));
    peer.on('stream', remoteStream => updatePeerStream(remoteId, remoteStream, screen, screenOwner));
    peer.on('connect', () => tunePeer(peer, peersRef.current.filter(person => !person.isScreenShare).length + 1, screen, callQuality));
    peer.on('close', () => {
      peersRef.current = peersRef.current.filter(person => person.peer !== peer);
      setPeers(previous => previous.filter(person => person.peer !== peer));
    });
    peer.on('error', () => notify(`The connection to ${remoteName || 'a participant'} was interrupted.`));
    if (incomingSignal) peer.signal(incomingSignal);
    return peer;
  };
  const addConnection = (id, name, stream, screen = false, signal = null, outgoingScreen = false, screenOwner = screen ? socket.id : null) => {
    const peer = createPeer(id, stream, name, screen, signal, screenOwner);
    const entry = { peerID: id, peer, userName: name, isScreenShare: screen, outgoingScreen, screenOwner, stream: null };
    peersRef.current.push(entry);
    if (!outgoingScreen) setPeers(previous => [...previous, entry]);
  };

  const onUserConnected = useEffectEvent(({ userId, userName: name }) => {
    if (mediaMode !== 'mesh' || userId === socket.id || peersRef.current.some(person => person.peerID === userId && !person.isScreenShare)) return;
    addConnection(userId, name, activeStream);
    if (screenStreamRef.current) addConnection(userId, name, screenStreamRef.current, true, null, true);
    socket.emit('update-user-state', { roomId, type: 'audio', enabled: !muted });
    socket.emit('update-user-state', { roomId, type: 'video', enabled: !videoOff });
  });
  const onSignal = useEffectEvent(payload => {
    if (mediaMode !== 'mesh' || payload.from === socket.id) return;
    const screen = !!payload.isScreenShare;
    const existing = peersRef.current.find(person => person.peerID === payload.from && person.isScreenShare === screen && (
      !screen || person.screenOwner === (payload.screenOwner || payload.from) ||
      (socket.legacyRooms && !payload.screenOwner && payload.signal.type !== 'offer')
    ));
    if (existing) { try { existing.peer.signal(payload.signal); } catch { /* Late signals can arrive after a peer closes. */ } }
    else if (payload.signal.type === 'offer') addConnection(payload.from, payload.userName, activeStream, screen, payload.signal, false, screen ? payload.screenOwner || payload.from : null);
  });
  const onRoomReady = useEffectEvent(reply => {
    setMediaMode(reply.mediaMode); setConnected(true);
    socket.emit('sync-request', roomId);
    socket.emit('room-joined');
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
    const disconnected = () => { setConnected(false); peersRef.current.forEach(person => person.peer?.destroy()); peersRef.current = []; setPeers([]); };
    const userConnected = payload => onUserConnected(payload);
    const signal = payload => onSignal(payload);
    const stateUpdated = ({ userId, type, enabled }) => setPeerStates(previous => ({ ...previous, [userId]: { ...previous[userId], [type]: enabled } }));
    const userDisconnected = id => {
      const departed = peersRef.current.filter(person => person.peerID === id);
      departed.forEach(person => person.peer?.destroy());
      peersRef.current = peersRef.current.filter(person => person.peerID !== id);
      setPeers(previous => previous.filter(person => person.peerID !== id));
      setPeerStates(previous => { const next = { ...previous }; delete next[id]; return next; });
    };
    socket.on('disconnect', disconnected);
    socket.on('user-connected', userConnected); socket.on('user-disconnected', userDisconnected); socket.on('signal', signal); socket.on('user-state-updated', stateUpdated);
    const stopMembership = maintainRoomMembership({ socket, roomId, userName, invite: roomInvite,
      onReady: reply => onRoomReady(reply), onWaiting: () => setConnected(false), onError: message => notify(message),
    });
    return () => {
      clearTimeout(toastTimer.current);
      stopMembership(); socket.off('disconnect', disconnected);
      socket.off('user-connected', userConnected); socket.off('user-disconnected', userDisconnected); socket.off('signal', signal); socket.off('user-state-updated', stateUpdated);
      peersRef.current.forEach(person => person.peer?.destroy()); peersRef.current = [];
      screenStreamRef.current?.getTracks().forEach(track => track.stop());
      if (ownsFallback) activeStream.getTracks().forEach(track => track.stop());
    };
  }, [socket, roomId, roomInvite, userName, activeStream, ownsFallback]);
  useEffect(() => {
    if (mediaMode !== 'livekit' || !connected) return;
    const controller = new AbortController();
    connectGroupCall({ socket, roomId, stream: activeStream, signal: controller.signal,
      onPeers: values => { peersRef.current = values; setPeers(values); },
      onError: message => { if (!controller.signal.aborted) notify(message); },
    }).then(call => {
      if (controller.signal.aborted) { call?.close(); return; }
      groupCallRef.current = call;
      if (screenStreamRef.current) call?.publishScreen(screenStreamRef.current).catch(() => notify('Restart screen sharing to share it again.'));
      call?.setMuted('audio', !activeStream.getAudioTracks().some(track => track.enabled)).catch(() => {});
      call?.setMuted('video', !activeStream.getVideoTracks().some(track => track.enabled)).catch(() => {});
    }).catch(error => { if (!controller.signal.aborted) notify(error.message || 'Could not connect the call.'); });
    return () => { controller.abort(); groupCallRef.current?.close(); groupCallRef.current = null; };
  }, [socket, roomId, mediaMode, connected, activeStream]);
  useEffect(() => { groupCallRef.current?.setMuted('audio', muted).catch(() => {}); }, [muted]);
  useEffect(() => { groupCallRef.current?.setMuted('video', videoOff).catch(() => {}); }, [videoOff]);
  useEffect(() => {
    const error = value => notify(value?.error || 'The room could not complete that action.');
    socket.on('room-error', error);
    return () => socket.off('room-error', error);
  }, [socket]);
  // Permission can resolve after joining. Upgrade tracks in place instead of
  // recreating the room, players, or existing peer connections.
  useEffect(() => {
    if (!userStream || userStream === activeStream) return;
    for (const newTrack of userStream.getTracks()) {
      if (activeStream.getTracks().includes(newTrack)) continue;
      const oldTrack = activeStream.getTracks().find(track => track.kind === newTrack.kind);
      newTrack.enabled = newTrack.kind === 'audio' ? !muted : !videoOff;
      for (const person of peersRef.current.filter(person => !person.isScreenShare && person.peer && !person.peer.destroyed)) {
        if (oldTrack) person.peer.replaceTrack(oldTrack, newTrack, activeStream);
        else person.peer.addTrack(newTrack, activeStream);
      }
      if (oldTrack) { activeStream.removeTrack(oldTrack); oldTrack.stop(); }
      activeStream.addTrack(newTrack);
      groupCallRef.current?.syncTracks().catch(() => notify('Could not update the call devices. Rejoin the room.'));
    }
  }, [userStream, activeStream, muted, videoOff]);
  useEffect(() => { activeStream.getAudioTracks().forEach(track => { track.enabled = !muted; }); }, [activeStream, muted]);
  useEffect(() => { activeStream.getVideoTracks().forEach(track => { track.enabled = !videoOff; }); }, [activeStream, videoOff]);

  const participantCount = peers.filter(person => !person.isScreenShare).length + 1;
  useEffect(() => {
    const budget = mediaBudget(mediaMode === 'livekit' ? 2 : participantCount, false, mediaMode === 'livekit' ? 'high' : callQuality);
    activeStream.getVideoTracks().forEach(track => {
      track.applyConstraints?.({ width: { ideal: budget.width }, height: { ideal: budget.height }, frameRate: { ideal: budget.frameRate, max: budget.frameRate } }).catch(() => {});
    });
    const tune = () => peersRef.current.filter(person => person.peer).forEach(person => tunePeer(person.peer, participantCount, person.isScreenShare, callQuality));
    tune();
    const timer = setInterval(tune, 5000);
    return () => clearInterval(timer);
  }, [participantCount, activeStream, userStream, mediaMode, callQuality]);

  const toggleMute = () => { setMuted(value => !value); socket.emit('update-user-state', { roomId, type: 'audio', enabled: muted }); };
  const toggleVideo = () => { setVideoOff(value => !value); socket.emit('update-user-state', { roomId, type: 'video', enabled: videoOff }); };
  const stopScreenShare = () => {
    screenStreamRef.current?.getTracks().forEach(track => { track.onended = null; track.stop(); }); screenStreamRef.current = null; setMyScreenStream(null);
    groupCallRef.current?.stopScreen().catch(() => notify('Could not stop screen sharing. Rejoin the call.'));
    const outgoing = peersRef.current.filter(person => person.outgoingScreen);
    outgoing.forEach(person => person.peer?.destroy());
  };
  const startScreenShare = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) { notify('Screen sharing is unavailable in this browser. You can share a YouTube video instead.'); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: true });
      screenStreamRef.current = stream; setMyScreenStream(stream);
      stream.getVideoTracks()[0].onended = stopScreenShare;
      if (mediaMode === 'livekit') {
        if (!groupCallRef.current) throw new Error('Wait for the call to connect.');
        await groupCallRef.current.publishScreen(stream);
      } else peersRef.current.filter(person => !person.isScreenShare).forEach(person => addConnection(person.peerID, person.userName, stream, true, null, true));
      setShowShare(false);
    } catch (error) { stopScreenShare(); if (error.name !== 'NotAllowedError') notify(error.message || 'Screen sharing could not start. Please try again.'); }
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
    const url = new URL('/', inviteOrigin || window.location.origin); url.searchParams.set('room', roomId);
    if (roomInvite) url.hash = new URLSearchParams({ invite: roomInvite }).toString();
    try { await navigator.clipboard.writeText(url.href); notify('Invite link copied.'); }
    catch { notify(`Invite your friends: ${url.href}`); }
  };
  const participants = [{ id: 'self', name: userName, stream: activeStream, muted: muted || !userStream, videoOff: videoOff || !userStream, isSelf: true }, ...peers.filter(person => !person.isScreenShare).map(person => ({ id: person.peerID, name: person.userName, stream: person.stream, sfuTracks: person.sfuTracks, muted: person.sfu ? person.muted : peerStates[person.peerID]?.audio === false, videoOff: person.sfu ? person.videoOff : peerStates[person.peerID]?.video === false }))];
  const screenShares = [...(myScreenStream ? [{ id: 'screen-self', name: userName, stream: myScreenStream, isSelf: true }] : []), ...peers.filter(person => person.isScreenShare && !person.outgoingScreen).map(person => ({ id: `screen-${person.peerID}`, name: person.userName, stream: person.stream, sfuTracks: person.sfuTracks }))];

  return <>
    <RoomView roomId={roomId} userName={userName} connected={connected} participants={participants} screenShares={screenShares} muted={muted} videoOff={videoOff} onToggleMute={toggleMute} onToggleVideo={toggleVideo} onShare={() => setShowShare(true)} onLeave={leaveRoom} onInvite={invite} onStopScreen={stopScreenShare} notification={notification} chatOpen={showChat} onChatToggle={socket.legacyRooms ? undefined : () => setShowChat(value => !value)} unread={unread}
      chat={socket.legacyRooms ? null : <Chat socket={socket} roomId={roomId} userName={userName} open={showChat} onClose={() => setShowChat(false)} onUnreadChange={setUnread} />}
      youtube={{ active: Boolean(youtubeState?.url), node: focused => youtubeState?.url ? <YouTubePlayer key={youtubeState.sessionId} state={youtubeState} socket={socket} roomId={roomId} focused={focused} onClose={() => youtubeRoomRef.current.close()} /> : null }}
      jellyfin={{ active: Boolean(jellyfin.state), node: focused => jellyfin.state ? <RoomJellyfinPlayer key={jellyfin.state.sessionId} state={jellyfin.state} base={jellyfin.base} command={jellyfin.command} connected={connected} focused={focused} onPlaybackStats={stats => { if (socket.connected && stats) socket.emit('jellyfin-playback-stats', { roomId, sessionId: jellyfin.state.sessionId, stats }); }} onBrowse={jellyfin.state.native ? () => setShowJellyfinInput(true) : undefined} /> : null }}
      diagnostics={() => <NerdStats socket={socket} roomId={roomId} mediaMode={mediaMode} peersRef={peersRef} groupCallRef={groupCallRef} qualityMode={callQuality} onQualityChange={setCallQuality} />} />
    <Dialog open={showShare} title="Share with the room" description="Choose what to share." onClose={() => setShowShare(false)}><div className="room-share-options"><button onClick={myScreenStream ? () => { stopScreenShare(); setShowShare(false); } : startScreenShare}><FaDesktop /><span><strong>{myScreenStream ? 'Stop sharing your screen' : 'Your screen'}</strong><small>Share a tab, an app, or your desktop.</small></span></button><button onPointerEnter={preloadYouTube} onFocus={preloadYouTube} onClick={() => { preloadYouTube(); setShowShare(false); setShowUrlInput(true); }}><FaYoutube /><span><strong>A YouTube video</strong><small>Watch a video together.</small></span></button>{!socket.legacyRooms && <button onClick={() => { setShowShare(false); setShowJellyfinInput(true); }}><FaPlayCircle /><span><strong>Your Jellyfin library</strong><small>Stream a video from your server.</small></span></button>}</div></Dialog>
    <Dialog open={showUrlInput} title="Share a YouTube video" description="Paste a YouTube link. Playback controls are shared with the room." onClose={() => setShowUrlInput(false)}><form onSubmit={submitUrl}><label className="room-field">YouTube video link<input type="url" data-autofocus disabled={isSubmittingUrl} placeholder="https://youtube.com/watch?v=…" value={inputUrl} onChange={event => { setInputUrl(event.target.value); setUrlError(''); }} aria-describedby={urlError ? 'youtube-url-error' : undefined} required /></label>{urlError && <p id="youtube-url-error" className="room-field-error" role="alert">{urlError}</p>}<button className="sr-button sr-button--primary" type="submit" disabled={!inputUrl.trim() || !connected || isSubmittingUrl}>{isSubmittingUrl ? 'Opening video…' : 'Watch together'}</button></form></Dialog>
    <JellyfinDialog base={jellyfin.base} initialServerUrl={jellyfinAddress} open={showJellyfinInput} onClose={() => setShowJellyfinInput(false)} onShare={jellyfin.open} onCancel={jellyfin.cancel} />
  </>;
}
