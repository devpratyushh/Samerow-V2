import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import Lobby from './Lobby';
import Room from './Room';
import './App.css';

import { auth } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';

// Use Render backend URL
const SOCKET_URL = 'https://samerow-v2.onrender.com';

const socket = io(SOCKET_URL, {
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 10, // Increase attempts for waking up
  timeout: 60000 // Higher timeout for cold start
});

socket.on('connect_error', (err) => {
  console.error("Socket Connection Error:", err.message);
});

function App() {
  const [roomId, setRoomId] = useState(null);
  const [userName, setUserName] = useState('');
  const [user, setUser] = useState(null);
  const [serverConnected, setServerConnected] = useState(socket.connected);

  useEffect(() => {
    const onConnect = () => setServerConnected(true);
    const onDisconnect = () => setServerConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    // Initial check
    if (socket.connected) setServerConnected(true);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  // Media State
  const [userStream, setUserStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false); // Start unmuted
  const [isVideoOff, setIsVideoOff] = useState(false); // Start with video
  const [streamError, setStreamError] = useState(null);

  useEffect(() => {
    // Auth Listener
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        setUserName(currentUser.displayName || '');
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    // Acquire stream immediately on load
    const getMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 }, // Lowered from 1920
            height: { ideal: 720 }, // Lowered from 1080
            frameRate: { ideal: 24 } // Lowered from 30
          },
          audio: true
        });
        setUserStream(stream);
      } catch (err) {
        console.error("Media Error:", err);
        setStreamError("Camera/Mic not found or denied. You can still join.");
        // If denied, we will generate a dummy stream later in joinRoom handled by Room or here? 
        // Better to handle in logic: If userStream is null when joining, create dummy.
      }
    };
    getMedia();
  }, []);

  const toggleMute = () => {
    setIsMuted(prev => {
      const newState = !prev;
      if (userStream) userStream.getAudioTracks().forEach(t => t.enabled = !newState);
      return newState;
    });
  };

  const toggleVideo = () => {
    setIsVideoOff(prev => {
      const newState = !prev;
      if (userStream) userStream.getVideoTracks().forEach(t => t.enabled = !newState);
      return newState;
    });
  };

  const joinRoom = (id, name) => {
    setRoomId(id);
    setUserName(name);
  };

  const leaveRoom = () => {
    setRoomId(null);
    setUserName('');
    window.location.reload();
  };

  return (
    <>
      {!roomId ? (
        <Lobby
          joinRoom={joinRoom}
          userStream={userStream}
          toggleMute={toggleMute}
          toggleVideo={toggleVideo}
          isMuted={isMuted}
          isVideoOff={isVideoOff}
          streamError={streamError}
          authUser={user}
          serverConnected={serverConnected}
        />
      ) : (
        <Room
          roomId={roomId}
          userName={userName}
          socket={socket}
          leaveRoom={leaveRoom}
          userStream={userStream} // Pass established stream
          initialMuted={isMuted}
          initialVideoOff={isVideoOff}
        />
      )}
    </>
  );
}

export default App;
