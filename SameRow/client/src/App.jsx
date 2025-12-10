import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import Lobby from './Lobby';
import Room from './Room';
import './App.css';

const socket = io('http://localhost:3000');

function App() {
  const [roomId, setRoomId] = useState(null);
  const [userName, setUserName] = useState('');

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
        <Lobby joinRoom={joinRoom} />
      ) : (
        <Room roomId={roomId} userName={userName} socket={socket} leaveRoom={leaveRoom} />
      )}
    </>
  );
}

export default App;
