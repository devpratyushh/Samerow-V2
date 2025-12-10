import React, { useState, useEffect, useRef } from 'react';
import styled from 'styled-components';
import { FaMicrophone, FaMicrophoneSlash, FaVideo, FaVideoSlash } from "react-icons/fa";

const LobbyContainer = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100vh;
  width: 100vw;
  background-color: #1a1a1a;
  color: white;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
`;

const ContentWrapper = styled.div`
  display: flex;
  gap: 40px;
  align-items: center;
  
  @media (max-width: 800px) {
    flex-direction: column;
  }
`;

const PreviewCard = styled.div`
  position: relative;
  width: 480px;
  height: 360px;
  background-color: #2c2c2e;
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 20px 40px rgba(0,0,0,0.4);
  display: flex;
  justify-content: center;
  align-items: center;
`;

const StyledVideo = styled.video`
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1); // Mirror for local preview
  display: ${props => props.isHidden ? 'none' : 'block'};
`;

const InitialsAvatar = styled.div`
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: linear-gradient(135deg, #a8c0ff, #3f2b96);
  color: white;
  display: flex;
  justify-content: center;
  align-items: center;
  font-size: 48px;
  font-weight: bold;
`;

const JoinCard = styled.div`
  background-color: rgba(44, 44, 46, 0.8);
  backdrop-filter: blur(20px);
  padding: 40px;
  border-radius: 20px;
  text-align: center;
  width: 380px;
  border: 1px solid rgba(255,255,255,0.1);
  display: flex;
  flex-direction: column;
  gap: 20px;
`;

const Title = styled.h1`
  margin: 0 0 10px 0;
  color: #fff;
  font-size: 24px;
`;

const Input = styled.input`
  width: 100%;
  padding: 15px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.1);
  background-color: rgba(0,0,0,0.3);
  color: white;
  font-size: 16px;
  outline: none;
  &:focus { border-color: #0a84ff; }
`;

const Button = styled.button`
  width: 100%;
  padding: 16px;
  background-color: #0a84ff;
  color: white;
  border: none;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  &:hover { background-color: #007aff; }
`;

const Controls = styled.div`
  position: absolute;
  bottom: 20px;
  display: flex;
  gap: 20px;
`;

const ControlButton = styled.button`
  background-color: ${props => props.active ? "rgba(255,255,255,0.9)" : "rgba(255,69,58,0.9)"};
  color: ${props => props.active ? "#000" : "#fff"};
  border: none;
  border-radius: 50%;
  width: 50px;
  height: 50px;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  transition: all 0.2s;
  &:hover { transform: scale(1.1); }
`;

const Lobby = ({ joinRoom, userStream, toggleMute, toggleVideo, isMuted, isVideoOff, streamError }) => {
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');
  const videoRef = useRef();

  useEffect(() => {
    if (videoRef.current && userStream) {
      videoRef.current.srcObject = userStream;
    }
  }, [userStream]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (roomId.trim() && userName.trim()) {
      joinRoom(roomId, userName);
    }
  };

  const myInitials = userName ? userName.split(" ").map(n => n[0]).join("").toUpperCase().substring(0, 2) : "ME";

  return (
    <LobbyContainer>
      <ContentWrapper>
        <PreviewCard>
          {!userStream || isVideoOff ? (
            <InitialsAvatar>{myInitials}</InitialsAvatar>
          ) : (
            <StyledVideo ref={videoRef} autoPlay playsInline muted />
          )}

          <Controls>
            <ControlButton active={!isMuted} onClick={(e) => { e.preventDefault(); toggleMute(); }}>
              {isMuted ? <FaMicrophoneSlash /> : <FaMicrophone />}
            </ControlButton>
            <ControlButton active={!isVideoOff} onClick={(e) => { e.preventDefault(); toggleVideo(); }}>
              {isVideoOff ? <FaVideoSlash /> : <FaVideo />}
            </ControlButton>
          </Controls>

          {streamError && (
            <div style={{ position: 'absolute', top: 10, color: '#ff453a', background: 'rgba(0,0,0,0.6)', padding: '5px 10px', borderRadius: 8 }}>
              {streamError}
            </div>
          )}
        </PreviewCard>

        <JoinCard>
          <Title>Ready to join?</Title>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <Input
              placeholder="Your Name"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              required
            />
            <Input
              placeholder="Room Code"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              required
            />
            <Button type="submit">Join Now</Button>
          </form>
        </JoinCard>
      </ContentWrapper>
    </LobbyContainer>
  );
};

export default Lobby;
