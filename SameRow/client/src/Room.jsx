import React, { useEffect, useRef, useState } from "react";
import Peer from "simple-peer";
import styled from "styled-components";
import { FaMicrophone, FaMicrophoneSlash, FaVideo, FaVideoSlash, FaPhoneSlash } from "react-icons/fa";

const RoomContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background-color: #202225;
  color: white;
`;

const VideoGrid = styled.div`
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  padding: 20px;
  gap: 20px;
  overflow-y: auto;
`;

const VideoWrapper = styled.div`
  position: relative;
  width: 400px;
  height: 300px;
  background-color: #2f3136;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
  display: flex;
  justify-content: center;
  align-items: center;
`;

const StyledVideo = styled.video`
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: ${props => props.isHidden ? 'none' : 'block'};
`;

const NameTag = styled.div`
  position: absolute;
  bottom: 10px;
  left: 10px;
  background-color: rgba(0, 0, 0, 0.6);
  color: white;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
  z-index: 10;
`;

const InitialsAvatar = styled.div`
  width: 100px;
  height: 100px;
  border-radius: 50%;
  background-color: #5865f2;
  color: white;
  display: flex;
  justify-content: center;
  align-items: center;
  font-size: 36px;
  font-weight: bold;
`;

const ControlsBar = styled.div`
  height: 80px;
  background-color: #2f3136;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 20px;
  border-top: 1px solid #202225;
`;

const ControlButton = styled.button`
  background-color: ${props => props.danger ? "#ed4245" : "#36393f"};
  color: white;
  border: none;
  border-radius: 50%;
  width: 50px;
  height: 50px;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  font-size: 20px;
  transition: all 0.2s;

  &:hover {
    background-color: ${props => props.danger ? "#d83c3e" : "#40444b"};
    transform: scale(1.05);
  }
`;

const LoadingMessage = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
  font-size: 24px;
  color: white;
`;

const Video = ({ peer, userName }) => {
    const ref = useRef();
    const [videoEnabled, setVideoEnabled] = useState(true);

    useEffect(() => {
        peer.on("stream", stream => {
            ref.current.srcObject = stream;
            // Monitor track status
            stream.getVideoTracks()[0].onmute = () => setVideoEnabled(false);
            stream.getVideoTracks()[0].onunmute = () => setVideoEnabled(true);
            // Also check enabled state
            setVideoEnabled(stream.getVideoTracks()[0].enabled);

            // Since 'enabled' property changes don't fire events consistently, we rely on parent state or simple render logic
            // But for remote peers, we rely on the stream itself. 
            // Simple-peer usually handles the stream transmission. If remote mutes, we receive empty frames or no frames. 
            // To show avatar on remote mute, we often need a separate signaling event 'toggle-video'.
            // For simplicity in this scaffold, we will show video if stream exists. 
        });
    }, [peer]);

    // Extract initials
    const initials = userName ? userName.split(" ").map(n => n[0]).join("").toUpperCase().substring(0, 2) : "?";

    return (
        <VideoWrapper>
            <StyledVideo playsInline autoPlay ref={ref} />
            <NameTag>{userName}</NameTag>
            {/* Note: Detecting remote video mute robustly requires more signaling. 
          For now, this video component blindly renders the stream. */}
        </VideoWrapper>
    );
};

const Room = ({ socket, roomId, userName, leaveRoom }) => {
    const [peers, setPeers] = useState([]);
    const [userStream, setUserStream] = useState();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const userVideo = useRef();
    const peersRef = useRef([]); // Stores { peerID, peer, userName }

    const [muted, setMuted] = useState(false);
    const [videoOff, setVideoOff] = useState(false);

    useEffect(() => {
        const init = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                setUserStream(stream);
                if (userVideo.current) {
                    userVideo.current.srcObject = stream;
                }
                setLoading(false);

                // Only join after stream is ready
                socket.emit("join-room", roomId, userName);

                socket.on("user-connected", ({ userId, userName: remoteName }) => {
                    const peer = createPeer(userId, socket.id, stream, remoteName);
                    peersRef.current.push({
                        peerID: userId,
                        peer,
                        userName: remoteName
                    });
                    setPeers(users => [...users, { peer, userName: remoteName, peerID: userId }]);
                });

                socket.on("user-disconnected", userId => {
                    const peerObj = peersRef.current.find(p => p.peerID === userId);
                    if (peerObj) peerObj.peer.destroy();
                    const newPeers = peersRef.current.filter(p => p.peerID !== userId);
                    peersRef.current = newPeers;
                    setPeers(newPeers);
                });

                socket.on("signal", payload => {
                    const peerObj = peersRef.current.find(p => p.peerID === payload.from);
                    if (peerObj) {
                        peerObj.peer.signal(payload.signal);
                    } else {
                        // Incoming signal from someone we don't know yet (Receiver)
                        const item = addPeer(payload.signal, payload.from, stream, payload.userName);
                        peersRef.current.push({
                            peerID: payload.from,
                            peer: item.peer,
                            userName: payload.userName
                        });
                        setPeers(users => [...users, { peer: item.peer, userName: payload.userName, peerID: payload.from }]);
                    }
                });

            } catch (err) {
                console.error("Error accessing media devices:", err);
                setError("Could not access camera/microphone. Please check permissions.");
                setLoading(false);
            }
        };

        init();

        return () => {
            socket.off("user-connected");
            socket.off("user-disconnected");
            socket.off("signal");
            // We generally don't stop the stream here to avoid flickering if component re-renders, 
            // but for a full leave, we should.
            // For now, relies on App.js reload to clear stream.
        };
    }, []);

    function createPeer(userToSignal, callerID, stream, remoteName) {
        const peer = new Peer({
            initiator: true,
            trickle: false,
            stream,
        });

        peer.on("signal", signal => {
            // Include my userName so the receiver knows who I am
            socket.emit("signal", { signal, to: userToSignal, userName });
        });

        return peer;
    }

    function addPeer(incomingSignal, callerID, stream, remoteName) {
        const peer = new Peer({
            initiator: false,
            trickle: false,
            stream,
        });

        peer.on("signal", signal => {
            // Include my userName in return signal too
            socket.emit("signal", { signal, to: callerID, userName });
        });

        peer.signal(incomingSignal);

        return { peer };
    }

    const toggleMute = () => {
        if (!userStream) return;
        setMuted(!muted);
        userStream.getAudioTracks()[0].enabled = !userStream.getAudioTracks()[0].enabled;
    };

    const toggleVideo = () => {
        if (!userStream) return;
        setVideoOff(!videoOff);
        userStream.getVideoTracks()[0].enabled = !userStream.getVideoTracks()[0].enabled;
    };

    // Initials for local user
    const myInitials = userName ? userName.split(" ").map(n => n[0]).join("").toUpperCase().substring(0, 2) : "ME";

    if (loading) return <LoadingMessage>Loading Camera...</LoadingMessage>;
    if (error) return <LoadingMessage>{error}</LoadingMessage>;

    return (
        <RoomContainer>
            <VideoGrid>
                {/* Local Video */}
                <VideoWrapper>
                    {videoOff ? (
                        <InitialsAvatar>{myInitials}</InitialsAvatar>
                    ) : (
                        <StyledVideo muted ref={userVideo} autoPlay playsInline />
                    )}
                    <NameTag>{userName} (You)</NameTag>
                </VideoWrapper>

                {/* Remote Videos */}
                {peers.map((p, index) => {
                    return <Video key={p.peerID} peer={p.peer} userName={p.userName} />;
                })}
            </VideoGrid>
            <ControlsBar>
                <ControlButton onClick={toggleMute}>
                    {muted ? <FaMicrophoneSlash /> : <FaMicrophone />}
                </ControlButton>
                <ControlButton onClick={toggleVideo}>
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
