import React, { useState, useEffect, useRef } from 'react';
import styled, { keyframes } from 'styled-components';
import { FaMicrophone, FaMicrophoneSlash, FaVideo, FaVideoSlash, FaGoogle, FaHistory, FaSignOutAlt, FaTrash } from "react-icons/fa";
import { signInWithPopup, signOut } from "firebase/auth";
import { auth, googleProvider } from "./firebase";

const gradientAnimation = keyframes`
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
`;

const LobbyContainer = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  width: 100%;
  background: linear-gradient(-45deg, #0f0f13, #1c1c20, #0a0a0c, #1f1f2e);
  background-size: 400% 400%;
  animation: ${gradientAnimation} 15s ease infinite;
  color: white;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  padding: 40px 20px;
  box-sizing: border-box;
`;

const ContentWrapper = styled.div`
  display: flex;
  gap: 40px;
  align-items: stretch; /* Make items same height */
  justify-content: center;
  flex-wrap: wrap;
  width: 100%;
  max-width: 1000px;
  
  @media (max-width: 800px) {
    flex-direction: column;
    align-items: center; /* Revert to center for mobile stack */
  }
`;

const PreviewCard = styled.div`
  position: relative;
  width: 100%;
  max-width: 480px;
  min-height: 360px;
  background-color: rgba(44, 44, 46, 0.4);
  backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 24px;
  overflow: hidden;
  box-shadow: 0 30px 60px rgba(0,0,0,0.6);
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
  font-weight: bold;
`;

const UserProfile = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(255,255,255,0.1);
  padding: 8px 16px;
  border-radius: 30px;
  margin-bottom: 20px;
  
  img { width: 32px; height: 32px; border-radius: 50%; }
  span { font-size: 14px; color: white; font-weight: 500; }
  button { 
    background: none; border: none; color: #ff453a; 
    cursor: pointer; display: flex; align-items: center;
    &:hover { opacity: 0.8; }
  }
`;

const HistoryContainer = styled.div`
  max-height: 150px;
  overflow-y: auto;
  width: 100%;
  background: rgba(0,0,0,0.2);
  border-radius: 12px;
  padding: 10px;
  margin-top: 10px;
  display: flex; flex-direction: column; gap: 8px;

  &::-webkit-scrollbar { width: 4px; }
  &::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
`;

const HistoryItem = styled.div`
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px;
  background: rgba(255,255,255,0.05);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
  
  &:hover { background: rgba(255,255,255,0.1); }
  
  div { display: flex; flex-direction: column; gap: 2px; }
  span.code { font-family: monospace; font-size: 14px; font-weight: bold; }
  span.time { font-size: 10px; color: #aaa; }
`;

const JoinCard = styled.div`
  background-color: rgba(30, 30, 34, 0.65);
  backdrop-filter: blur(24px);
  padding: 40px;
  border-radius: 24px;
  text-align: center;
  width: 100%;
  max-width: 380px;
  border: 1px solid rgba(255,255,255,0.1);
  display: flex;
  flex-direction: column;
  gap: 20px;
  box-shadow: 0 30px 60px rgba(0,0,0,0.4);
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
  background: linear-gradient(135deg, #0a84ff, #005bb5);
  color: white;
  border: none;
  border-radius: 14px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 8px 20px rgba(10, 132, 255, 0.3);
  &:hover { transform: translateY(-2px); box-shadow: 0 12px 24px rgba(10, 132, 255, 0.5); }
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
  width: 54px;
  height: 54px;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
  box-shadow: 0 8px 16px rgba(0,0,0,0.3);
  &:hover { transform: scale(1.15); box-shadow: 0 12px 24px rgba(0,0,0,0.4); }
`;

const Lobby = ({ joinRoom, initialRoom, userStream, toggleMute, toggleVideo, isMuted, isVideoOff, streamError, authUser, serverConnected }) => {
  const [roomId, setRoomId] = useState(initialRoom || '');

  useEffect(() => {
    if (initialRoom) setRoomId(initialRoom);
  }, [initialRoom]);
  const [userName, setUserName] = useState('');
  const videoRef = useRef();
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (videoRef.current && userStream) {
      videoRef.current.srcObject = userStream;
    }
  }, [userStream]);

  // Auto-fill name and load history on auth change
  useEffect(() => {
    if (authUser) {
      setUserName(authUser.displayName || '');
      // Load History
      const stored = localStorage.getItem(`recent_rooms_${authUser.uid}`);
      if (stored) {
        try {
          setHistory(JSON.parse(stored));
        } catch (e) {
          console.error("Failed to parse history", e);
        }
      }
    } else {
      setHistory([]);
    }
  }, [authUser]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
      alert("Login failed: " + error.message);
    }
  };

  const addToHistory = (code) => {
    if (!authUser) return;
    const newEntry = { code, timestamp: Date.now() };
    const newHistory = [newEntry, ...history.filter(h => h.code !== code)].slice(0, 5); // Keep top 5 unique
    setHistory(newHistory);
    localStorage.setItem(`recent_rooms_${authUser.uid}`, JSON.stringify(newHistory));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (roomId.trim() && userName.trim()) {
      addToHistory(roomId.trim());
      joinRoom(roomId, userName);
    }
  };

  const joinRecentRoom = (code) => {
    setRoomId(code);
    if (userName.trim()) {
      addToHistory(code);
      joinRoom(code, userName);
    }
  };

  // Format relative time helper
  const timeAgo = (ms) => {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return 'Just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return 'Long ago';
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

          {authUser ? (
            <UserProfile>
              <img src={authUser.photoURL} alt="Avatar" />
              <span>{authUser.displayName}</span>
              <button onClick={() => signOut(auth)} title="Sign Out">
                <FaSignOutAlt />
              </button>
            </UserProfile>
          ) : (
            <Button
              type="button"
              onClick={handleLogin}
              style={{ background: 'white', color: 'black', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginBottom: '20px' }}
            >
              <FaGoogle color="#DB4437" /> Sign in with Google
            </Button>
          )}

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
            <Button type="submit" disabled={!serverConnected} style={{ opacity: serverConnected ? 1 : 0.6 }}>
              {serverConnected ? "Join Now" : "Waking up server..."}
            </Button>
            {!serverConnected && (
              <div style={{ fontSize: '10px', color: '#aaa', marginTop: '-10px' }}>
                This may take up to 50s on the free plan.
              </div>
            )}
          </form>

          {authUser && history.length > 0 && (
            <div style={{ width: '100%', marginTop: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#888', fontSize: '12px', marginBottom: '5px' }}>
                <FaHistory /> Recent Rooms
              </div>
              <HistoryContainer>
                {history.map((h, i) => (
                  <HistoryItem key={i} onClick={() => joinRecentRoom(h.code)}>
                    <div>
                      <span className="code">{h.code}</span>
                      <span className="time">{timeAgo(h.timestamp)}</span>
                    </div>
                  </HistoryItem>
                ))}
              </HistoryContainer>
            </div>
          )}
        </JoinCard>
      </ContentWrapper>
    </LobbyContainer>
  );
};

export default Lobby;
