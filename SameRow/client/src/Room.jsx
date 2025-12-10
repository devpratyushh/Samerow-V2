import React, { useEffect, useRef, useState } from "react";
import Peer from "simple-peer";
import styled, { keyframes } from "styled-components";
import ReactPlayer from "react-player";
import { FaMicrophone, FaMicrophoneSlash, FaVideo, FaVideoSlash, FaPhoneSlash, FaEllipsisV, FaSignal, FaExpand, FaTh, FaYoutube, FaSpinner, FaShareAlt, FaTimes } from "react-icons/fa";

const RoomContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background-color: #1a1a1a;
  color: white;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
`;

// Shared Player Container
const SharedPlayerWrapper = styled.div`
  width: 100%;
  max-width: 800px;
  aspect-ratio: 16/9;
  margin: 0 auto;
  background: black;
  display: ${props => props.visible ? 'block' : 'none'};
  margin-bottom: 20px;
  border-radius: 12px; overflow: hidden;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5);
  position: relative;
  z-index: 40;
`;

const spin = keyframes`
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
`;

const LoadingOverlay = styled.div`
  position: absolute;
  top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0,0,0,0.7);
  display: flex; justify-content: center; align-items: center;
  z-index: 50;
  backdrop-filter: blur(5px);
`;

const Spinner = styled(FaSpinner)`
  animation: ${spin} 1s linear infinite;
  color: #ff0000;
  font-size: 40px;
`;

const VideoGrid = styled.div`
  flex: 1;
  display: flex;
  flex-wrap: ${props => props.mode === 'pip' ? 'nowrap' : 'wrap'};
  justify-content: center;
  align-items: center;
  padding: ${props => props.mode === 'pip' ? '0' : '40px'};
  gap: ${props => props.mode === 'pip' ? '0' : '20px'};
  overflow-y: auto;
  position: relative;
`;

const VideoWrapper = styled.div`
  position: relative;
  width: ${props => props.isFullScreen ? '100vw' : '100%'};
  height: ${props => props.isFullScreen ? '100vh' : 'auto'};
  max-width: ${props => props.isFullScreen ? 'none' : '600px'};
  aspect-ratio: ${props => props.isFullScreen ? 'auto' : '16 / 9'};
  background-color: #2c2c2e;
  border-radius: ${props => props.isFullScreen ? '0' : '18px'};
  overflow: hidden;
  box-shadow: ${props => props.isFullScreen ? 'none' : '0 8px 30px rgba(0, 0, 0, 0.4)'};
  display: flex;
  justify-content: center;
  align-items: center;
  transition: all 0.3s ease;
  
  @media (max-width: 768px) { width: 100%; }
`;

const DraggableWrapper = styled.div`
  position: fixed;
  width: 240px;
  aspect-ratio: 16 / 9;
  background-color: #333;
  border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.5);
  z-index: 50;
  cursor: grab;
  overflow: hidden;
  border: 2px solid rgba(255,255,255,0.1);
  
  &:active { cursor: grabbing; }

  top: ${props => props.y}px;
  left: ${props => props.x}px;
`;

const StyledVideo = styled.video`
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: ${props => props.isHidden ? 'none' : 'block'};
`;

const NameTag = styled.div`
  position: absolute;
  bottom: 15px; left: 15px;
  background-color: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(10px); color: white;
  padding: 6px 12px; border-radius: 20px;
  font-size: 14px; font-weight: 500;
  z-index: 10;
  display: flex; align-items: center; gap: 8px;
`;

const StatusIcon = styled.div`
  color: #ff453a; font-size: 12px; display: flex; align-items: center;
`;

const InitialsAvatar = styled.div`
  width: 100%; height: 100%;
  border-radius: 0;
  background: linear-gradient(135deg, #a8c0ff, #3f2b96);
  color: white;
  display: flex; justify-content: center; align-items: center;
  font-size: 48px; font-weight: bold;
`;

const ControlsBar = styled.div`
  height: 80px;
  background-color: rgba(28, 28, 30, 0.7);
  backdrop-filter: blur(20px);
  display: flex; justify-content: center; align-items: center;
  gap: 20px;
  position: fixed; 
  bottom: 40px; 
  left: 50%;
  transform: translateX(-50%);
  width: auto;
  border-radius: 40px;
  padding: 0 40px;
  border: 1px solid rgba(255,255,255,0.1);
  z-index: 100;
  box-shadow: 0 10px 30px rgba(0,0,0,0.3);
`;

const ControlButton = styled.button`
  background-color: ${props => props.danger ? "#ff3b30" : props.active ? "#3a3a3c" : "#f2f2f7"};
  color: ${props => props.active ? "#fff" : "#000"};
  border: none; border-radius: 50%; width: 56px; height: 56px;
  display: flex; justify-content: center; align-items: center;
  cursor: pointer; 
  transition: all 0.2s ease-in-out;
  box-shadow: 0 4px 10px rgba(0,0,0,0.2);
  
  & > svg {
      width: 28px;
      height: 28px;
      font-size: 28px; /* Backup for react-icons */
  }
  
  &:hover { 
      transform: scale(1.1); 
      background-color: ${props => props.danger ? "#ff453a" : props.active ? "#48484a" : "#ffffff"};
  }
`;

const MenuTrigger = styled.button`
  position: absolute; top: 15px; right: 15px;
  background-color: rgba(0,0,0,0.4); color: white;
  border: none; width: 32px; height: 32px; border-radius: 50%;
  display: flex; justify-content: center; align-items: center;
  cursor: pointer; backdrop-filter: blur(5px);
  transition: background-color 0.2s;
  z-index: 20;
  &:hover { background-color: rgba(0,0,0,0.6); }
`;

const StatsMenu = styled.div`
  position: absolute; top: 50px; right: 15px;
  background-color: rgba(28, 28, 30, 0.95);
  backdrop-filter: blur(20px);
  border-radius: 12px;
  padding: 10px;
  width: 200px;
  color: white;
  font-size: 11px;
  font-family: monospace;
  z-index: 30;
  box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  border: 1px solid rgba(255,255,255,0.1);
`;

const StatItem = styled.div`
  display: flex; justify-content: space-between;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255,255,255,0.1);
  &:last-child { border-bottom: none; }
  span:first-child { color: #8a8a8e; }
  span:last-child { color: #30d158; font-weight: bold; }
`;

// --- SharePlay UI Components ---

const ShareButton = styled(ControlButton)`
  position: fixed;
  bottom: 40px;
  right: 40px;
  z-index: 100;
  background-color: #0a84ff;
  color: white;
  width: 64px; height: 64px;
  
  &:hover { background-color: #007aff; }
`;

const ModalOverlay = styled.div`
  position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
  background: rgba(0,0,0,0.6); backdrop-filter: blur(5px);
  z-index: 200;
  display: flex; justify-content: center; align-items: center;
`;

const AppSelector = styled.div`
  background: #1c1c1e;
  padding: 24px;
  border-radius: 20px;
  width: 300px;
  border: 1px solid rgba(255,255,255,0.1);
  box-shadow: 0 20px 50px rgba(0,0,0,0.5);
  display: flex; flex-direction: column; gap: 16px;
`;

const InputModal = styled(AppSelector)`
  width: 400px;
`;

const ModalHeader = styled.div`
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 8px;
  h3 { margin: 0; font-size: 18px; font-weight: 600; }
`;

const AppOption = styled.button`
  background: rgba(255,255,255,0.05);
  border: none;
  padding: 16px;
  border-radius: 12px;
  color: white;
  display: flex; align-items: center; gap: 12px;
  cursor: pointer;
  transition: all 0.2s;
  font-size: 16px; font-weight: 500;
  
  &:hover { background: rgba(255,255,255,0.1); transform: translateY(-2px); }
`;

const UrlInput = styled.input`
  width: 100%;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.2);
  color: white;
  padding: 12px;
  border-radius: 10px;
  outline: none;
  font-size: 16px;
  
  &:focus { border-color: #0a84ff; }
`;

const ActionButton = styled.button`
  background: #0a84ff;
  color: white;
  border: none; padding: 12px;
  border-radius: 10px;
  font-weight: 600; cursor: pointer;
  transition: background 0.2s;
  
  &:hover { background: #007aff; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;


// --- SDP Utils ---
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

const Video = ({ stream, userName, peerState, peer, isFullScreen }) => {
    const ref = useRef();
    const [videoEnabled, setVideoEnabled] = useState(true);
    const [showStats, setShowStats] = useState(false);
    const [stats, setStats] = useState({ rtt: '0ms', packetLoss: '0', resolution: 'N/A', fps: '0' });

    useEffect(() => {
        if (stream && ref.current) ref.current.srcObject = stream;
    }, [stream]);

    useEffect(() => {
        if (peerState) setVideoEnabled(peerState.video);
    }, [peerState]);

    useEffect(() => {
        if (!showStats || !peer || !peer._pc) return;
        const interval = setInterval(async () => {
            try {
                if (peer.destroyed) return;
                const stats = await peer._pc.getStats();
                let rtt = '0'; let packetsLost = 0; let fps = 0; let width = 0; let height = 0;
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') rtt = (report.currentRoundTripTime * 1000).toFixed(0);
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        packetsLost = report.packetsLost;
                        if (report.framesPerSecond) fps = report.framesPerSecond;
                        if (report.frameWidth) width = report.frameWidth;
                        if (report.frameHeight) height = report.frameHeight;
                    }
                });
                setStats({ rtt: `${rtt}ms`, bitrate: 'High', packetLoss: `${packetsLost}`, resolution: width ? `${width}x${height}` : 'N/A', fps: fps ? fps.toFixed(0) : '0' });
            } catch (e) { console.error("Stats error", e); }
        }, 1000);
        return () => clearInterval(interval);
    }, [showStats, peer]);

    const initials = userName ? userName.split(" ").map(n => n[0]).join("").toUpperCase().substring(0, 2) : "?";
    const isMuted = peerState ? !peerState.audio : false;

    return (
        <VideoWrapper isFullScreen={isFullScreen}>
            <StyledVideo playsInline autoPlay ref={ref} isHidden={!videoEnabled} />
            {!videoEnabled && <InitialsAvatar>{initials}</InitialsAvatar>}
            <MenuTrigger onClick={() => setShowStats(!showStats)}><FaEllipsisV size={14} /></MenuTrigger>
            {showStats && (
                <StatsMenu>
                    <StatItem><span>Ping</span><span>{stats.rtt}</span></StatItem>
                    <StatItem><span>Loss</span><span>{stats.packetLoss}</span></StatItem>
                    <StatItem><span>Res</span><span>{stats.resolution}</span></StatItem>
                    <StatItem><span>FPS</span><span>{stats.fps}</span></StatItem>
                </StatsMenu>
            )}
            <NameTag>
                {userName}
                {isMuted && <StatusIcon><FaMicrophoneSlash /></StatusIcon>}
                {!videoEnabled && <StatusIcon><FaVideoSlash /></StatusIcon>}
            </NameTag>
        </VideoWrapper>
    );
};

const Room = ({ socket, roomId, userName, leaveRoom, userStream, initialMuted, initialVideoOff }) => {
    const [peers, setPeers] = useState([]);
    const peersRef = useRef([]);
    const [activeStream, setActiveStream] = useState(userStream);
    const userVideo = useRef();

    const [muted, setMuted] = useState(initialMuted);
    const [videoOff, setVideoOff] = useState(initialVideoOff);
    const [peerStates, setPeerStates] = useState({});
    const [viewMode, setViewMode] = useState('grid'); // 'grid' or 'pip'

    // --- YOUTUBE SYNC STATE ---
    const [youtubeUrl, setYoutubeUrl] = useState('');
    const [isPlaying, setIsPlaying] = useState(false);
    const [isBuffering, setIsBuffering] = useState(false);
    const [isPlayerReady, setIsPlayerReady] = useState(false); // New state to track if stream is loaded
    const [inputUrl, setInputUrl] = useState('');
    const playerRef = useRef(null);
    const isRemoteUpdate = useRef(false);

    // SharePlay UI State
    const [showAppSelector, setShowAppSelector] = useState(false);
    const [showUrlInput, setShowUrlInput] = useState(false);

    // Draggable State
    const [dragPos, setDragPos] = useState({ x: 20, y: 20 });
    const [isDragging, setIsDragging] = useState(false);
    const dragOffset = useRef({ x: 0, y: 0 });

    const startDrag = (e) => {
        setIsDragging(true);
        dragOffset.current = {
            x: e.clientX - dragPos.x,
            y: e.clientY - dragPos.y
        };
    };

    const onDrag = (e) => {
        if (!isDragging) return;
        setDragPos({
            x: e.clientX - dragOffset.current.x,
            y: e.clientY - dragOffset.current.y
        });
    };

    const stopDrag = () => {
        setIsDragging(false);
    };

    const createDummyStream = () => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
        const ctx = canvas.getContext('2d');
        const draw = () => { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 640, 480); requestAnimationFrame(draw); };
        draw();
        const stream = canvas.captureStream(30);
        const audioCtx = new AudioContext(); const dst = audioCtx.createMediaStreamDestination();
        stream.addTrack(dst.stream.getAudioTracks()[0]); stream.getTracks().forEach(t => t.enabled = false);
        return stream;
    };

    // Re-attach local stream when viewMode or dragging renders a new video element
    useEffect(() => {
        if (userVideo.current && activeStream) {
            userVideo.current.srcObject = activeStream;
        }
    }, [viewMode, activeStream]);

    useEffect(() => {
        const currentStream = userStream || createDummyStream();
        setActiveStream(currentStream);
        if (currentStream.getAudioTracks()[0]) currentStream.getAudioTracks()[0].enabled = !initialMuted;
        if (currentStream.getVideoTracks()[0]) currentStream.getVideoTracks()[0].enabled = !initialVideoOff;
        if (userVideo.current) userVideo.current.srcObject = currentStream;

        socket.emit("join-room", roomId, userName);
        socket.emit('update-user-state', { roomId, type: 'audio', enabled: !initialMuted });
        socket.emit('update-user-state', { roomId, type: 'video', enabled: !initialVideoOff });

        // Request sync for YouTube
        socket.emit('sync-request', roomId);

        const handleUserConnected = ({ userId, userName: remoteName }) => {
            if (userId === socket.id) return;
            if (peersRef.current.some(p => p.peerID === userId)) return;
            console.log(`[Room] Connecting to new user: ${userId}`);
            const peer = createPeer(userId, socket.id, currentStream, remoteName);
            peersRef.current.push({ peerID: userId, peer, userName: remoteName });
            setPeers(users => [...users, { peer, userName: remoteName, peerID: userId, stream: null }]);
            socket.emit('update-user-state', { roomId, type: 'audio', enabled: !muted });
            socket.emit('update-user-state', { roomId, type: 'video', enabled: !videoOff });
        };

        const handleUserDisconnected = (userId) => {
            const peerObj = peersRef.current.find(p => p.peerID === userId);
            if (peerObj) peerObj.peer.destroy();
            const newPeers = peersRef.current.filter(p => p.peerID !== userId);
            peersRef.current = newPeers;
            setPeers(newPeers);
            setPeerStates(prev => { const next = { ...prev }; delete next[userId]; return next; });
        };

        const handleSignal = (payload) => {
            if (payload.from === socket.id) return;
            const peerObj = peersRef.current.find(p => p.peerID === payload.from);
            if (peerObj) peerObj.peer.signal(payload.signal);
            else {
                if (peersRef.current.some(p => p.peerID === payload.from)) return;
                const item = addPeer(payload.signal, payload.from, currentStream, payload.userName);
                peersRef.current.push({ peerID: payload.from, peer: item.peer, userName: payload.userName });
                setPeers(users => [...users, { peer: item.peer, userName: payload.userName, peerID: payload.from, stream: null }]);
            }
        };

        const handleStateUpdate = ({ userId, type, enabled }) => {
            setPeerStates(prev => ({ ...prev, [userId]: { ...prev[userId], [type]: enabled } }));
        };

        // --- YouTube Socket Handlers ---
        const handleYouTubeChange = (url) => {
            setYoutubeUrl(url);
            setIsPlaying(true);
        };

        const handleYouTubeState = ({ isPlaying: remotePlaying, timestamp }) => {
            isRemoteUpdate.current = true;

            setIsPlaying(remotePlaying);

            if (playerRef.current) {
                const currentTime = playerRef.current.getCurrentTime();
                // If time difference is > 2 seconds, sync it
                if (Math.abs(currentTime - timestamp) > 2) {
                    playerRef.current.seekTo(timestamp, 'seconds');
                }
            }

            // Reset flag after state settling (approx)
            setTimeout(() => isRemoteUpdate.current = false, 500);
        };

        socket.on("user-connected", handleUserConnected);
        socket.on("user-disconnected", handleUserDisconnected);
        socket.on("signal", handleSignal);
        socket.on("user-state-updated", handleStateUpdate);

        socket.on("youtube-change", handleYouTubeChange);
        socket.on("youtube-state-change", handleYouTubeState);

        return () => {
            socket.off("user-connected", handleUserConnected);
            socket.off("user-disconnected", handleUserDisconnected);
            socket.off("signal", handleSignal);
            socket.off("user-state-updated", handleStateUpdate);

            socket.off("youtube-change", handleYouTubeChange);
            socket.off("youtube-state-change", handleYouTubeState);

            peersRef.current.forEach(p => p.peer.destroy());
            peersRef.current = [];
        };
    }, []);

    const updatePeerStream = (peerId, stream) => {
        setPeers(currentPeers => currentPeers.map(p => p.peerID === peerId ? { ...p, stream: stream } : p));
    };

    function createPeer(userToSignal, callerID, stream, remoteName) {
        const peer = new Peer({ initiator: true, trickle: true, stream, config: PEER_CONFIG });
        peer.on("signal", signal => { socket.emit("signal", { signal, to: userToSignal, userName }); });
        peer.on("stream", remoteStream => { updatePeerStream(userToSignal, remoteStream); });
        return peer;
    }

    function addPeer(incomingSignal, callerID, stream, remoteName) {
        const peer = new Peer({ initiator: false, trickle: true, stream, config: PEER_CONFIG });
        peer.on("signal", signal => { socket.emit("signal", { signal, to: callerID, userName }); });
        peer.signal(incomingSignal);
        peer.on("stream", remoteStream => { updatePeerStream(callerID, remoteStream); });
        return { peer };
    }

    const toggleMute = () => {
        setMuted(!muted);
        if (activeStream?.getAudioTracks()[0]) activeStream.getAudioTracks()[0].enabled = !(!muted);
        socket.emit('update-user-state', { roomId, type: 'audio', enabled: !(!muted) });
    };

    const toggleVideo = () => {
        setVideoOff(!videoOff);
        if (activeStream?.getVideoTracks()[0]) activeStream.getVideoTracks()[0].enabled = !(!videoOff);
        socket.emit('update-user-state', { roomId, type: 'video', enabled: !(!videoOff) });
    };

    // --- YouTube Handlers ---
    const handleUrlSubmit = () => {
        if (!inputUrl) return;

        if (!ReactPlayer.canPlay(inputUrl)) {
            alert("Please enter a valid YouTube URL.");
            return;
        }

        // --- JSON Data Extraction for Console ---
        try {
            const urlObj = new URL(inputUrl);
            const videoId = urlObj.searchParams.get("v") || inputUrl.split('/').pop();
            const startTime = urlObj.searchParams.get("t") || 0;

            const metaData = {
                source: "youtube",
                originalUrl: inputUrl,
                videoId: videoId,
                params: Object.fromEntries(urlObj.searchParams),
                timestamp: Date.now()
            };

            console.log(">>> EXTRACTED VIDEO DATA:", JSON.stringify(metaData, null, 2));

        } catch (e) {
            console.error("Failed to parse URL metadata", e);
        }

        setYoutubeUrl(inputUrl);
        setIsPlayerReady(false); // Reset ready state
        socket.emit('youtube-change', { roomId, url: inputUrl });
        setInputUrl('');
        setShowUrlInput(false); // Close Modal
    };

    // --- Player Callbacks ---
    const onPlayerReady = () => {
        console.log(">>> STREAM FETCHED & READY. Playing:", youtubeUrl);
        setIsPlayerReady(true);
        setIsBuffering(false);
    };

    const onPlayerPlay = () => {
        setIsBuffering(false);
        if (!isRemoteUpdate.current && !isPlaying) {
            setIsPlaying(true);
            const time = playerRef.current ? playerRef.current.getCurrentTime() : 0;
            socket.emit('youtube-state-change', { roomId, isPlaying: true, timestamp: time });
        }
    };

    const onPlayerPause = () => {
        if (!isRemoteUpdate.current && isPlaying) {
            setIsPlaying(false);
            const time = playerRef.current ? playerRef.current.getCurrentTime() : 0;
            socket.emit('youtube-state-change', { roomId, isPlaying: false, timestamp: time });
        }
    };

    const onPlayerBuffer = () => {
        setIsBuffering(true);
    };

    const onPlayerBufferEnd = () => {
        setIsBuffering(false);
    };

    const myInitials = userName ? userName.split(" ").map(n => n[0]).join("").toUpperCase().substring(0, 2) : "ME";
    const uniquePeers = Array.from(new Set(peers.map(p => p.peerID))).map(id => peers.find(p => p.peerID === id));

    return (
        <RoomContainer onMouseMove={onDrag} onMouseUp={stopDrag}>

            {/* SharePlay Floating Button */}
            <ShareButton onClick={() => setShowAppSelector(true)}>
                <FaShareAlt />
            </ShareButton>

            {/* App Selector Modal */}
            {showAppSelector && (
                <ModalOverlay onClick={() => setShowAppSelector(false)}>
                    <AppSelector onClick={e => e.stopPropagation()}>
                        <ModalHeader>
                            <h3>SharePlay</h3>
                            <div style={{ cursor: 'pointer' }} onClick={() => setShowAppSelector(false)}><FaTimes /></div>
                        </ModalHeader>
                        <AppOption onClick={() => { setShowAppSelector(false); setShowUrlInput(true); }}>
                            <FaYoutube color="#ff0000" size={24} />
                            <span>YouTube</span>
                        </AppOption>
                        {/* More apps can go here later */}
                    </AppSelector>
                </ModalOverlay>
            )}

            {/* YouTube URL Input Modal */}
            {showUrlInput && (
                <ModalOverlay onClick={() => setShowUrlInput(false)}>
                    <InputModal onClick={e => e.stopPropagation()}>
                        <ModalHeader>
                            <h3>Paste Link</h3>
                            <div style={{ cursor: 'pointer' }} onClick={() => setShowUrlInput(false)}><FaTimes /></div>
                        </ModalHeader>
                        <UrlInput
                            placeholder="https://youtube.com/watch?v=..."
                            value={inputUrl}
                            autoFocus
                            onChange={(e) => setInputUrl(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
                        />
                        <ActionButton onClick={handleUrlSubmit} disabled={!inputUrl}>
                            Start Watching
                        </ActionButton>
                    </InputModal>
                </ModalOverlay>
            )}

            {/* Shared Player (Hidden if no URL) */}
            <SharedPlayerWrapper visible={!!youtubeUrl}>
                {youtubeUrl && (
                    <>
                        <ReactPlayer
                            ref={playerRef}
                            url={youtubeUrl}
                            playing={isPlaying}
                            controls={true}
                            width="100%"
                            height="100%"
                            onReady={onPlayerReady}
                            onStart={() => console.log(">>> PLAYBACK STARTED")}
                            onPlay={onPlayerPlay}
                            onPause={onPlayerPause}
                            onBuffer={onPlayerBuffer}
                            onBufferEnd={onPlayerBufferEnd}
                            onError={(e) => {
                                console.error(">>> PLAYER ERROR:", e);
                                alert("Error loading video. It might be restricted from embedding.");
                            }}
                            style={{ opacity: isPlayerReady ? 1 : 0, transition: 'opacity 0.5s' }}
                        />

                        {/* Loading/Buffering Overlay - Shows when not ready OR buffering */}
                        {(!isPlayerReady || isBuffering) && (
                            <LoadingOverlay>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                                    <Spinner />
                                    <span style={{ color: 'white', fontSize: '14px', fontWeight: '500' }}>
                                        {!isPlayerReady ? "Fetching Stream..." : "Buffering..."}
                                    </span>
                                </div>
                            </LoadingOverlay>
                        )}
                    </>
                )}
            </SharedPlayerWrapper>

            <VideoGrid mode={viewMode}>
                {/* LOCAL VIDEO: Conditional Rendering (PiP or Grid) */}
                {viewMode === 'grid' ? (
                    <VideoWrapper>
                        <StyledVideo muted ref={userVideo} autoPlay playsInline isHidden={videoOff} />
                        {videoOff && <InitialsAvatar>{myInitials}</InitialsAvatar>}
                        <NameTag>
                            {userName} (You)
                            {muted && <StatusIcon><FaMicrophoneSlash /></StatusIcon>}
                            {videoOff && <StatusIcon><FaVideoSlash /></StatusIcon>}
                        </NameTag>
                    </VideoWrapper>
                ) : (
                    <DraggableWrapper
                        x={dragPos.x}
                        y={dragPos.y}
                        onMouseDown={startDrag}
                    >
                        <StyledVideo muted ref={userVideo} autoPlay playsInline isHidden={videoOff} />
                        {videoOff && <InitialsAvatar>{myInitials}</InitialsAvatar>}
                        <NameTag style={{ fontSize: '10px', padding: '4px 8px' }}>
                            {userName} (You)
                        </NameTag>
                    </DraggableWrapper>
                )}

                {/* REMOTE PEERS */}
                {/* REMOTE PEERS - In PiP, only show the first one as background */}
                {uniquePeers
                    .slice(0, viewMode === 'pip' ? 1 : uniquePeers.length)
                    .map((p, index) => (
                        <Video
                            key={p.peerID}
                            stream={p.stream}
                            userName={p.userName}
                            peer={p.peer}
                            peerState={peerStates[p.peerID] || { audio: true, video: true }}
                            isFullScreen={viewMode === 'pip'}
                        />
                    ))}
                {/* If PiP mode and no peers, Grid background is empty or handled by CSS */}
            </VideoGrid>

            <ControlsBar>
                {/* LAYOUT TOGGLE */}
                <ControlButton onClick={() => setViewMode(viewMode === 'grid' ? 'pip' : 'grid')}>
                    {viewMode === 'grid' ? <FaExpand /> : <FaTh />}
                </ControlButton>

                <ControlButton active={muted} onClick={toggleMute}>
                    {muted ? <FaMicrophoneSlash /> : <FaMicrophone />}
                </ControlButton>
                <ControlButton active={videoOff} onClick={toggleVideo}>
                    {videoOff ? <FaVideoSlash /> : <FaVideo />}
                </ControlButton>
                <ControlButton danger onClick={leaveRoom}>
                    <FaPhoneSlash />
                </ControlButton>
            </ControlsBar>
        </RoomContainer>
    );
};

export default Room;
