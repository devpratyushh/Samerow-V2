import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import Lobby from './Lobby';
import Room from './Room';
import './App.css';

const socket = io('http://localhost:3000');

function App() {
  const [roomId, setRoomId] = useState(null);
  const [userName, setUserName] = useState('');

  // Media State
  const [userStream, setUserStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false); // Start unmuted
  const [isVideoOff, setIsVideoOff] = useState(false); // Start with video
  const [streamError, setStreamError] = useState(null);

  useEffect(() => {
    // Acquire stream immediately on load
    const getMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
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
