import React, { useState } from 'react';
import styled from 'styled-components';

const LobbyContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
  width: 100vw;
  background-color: #36393f;
  color: white;
`;

const Card = styled.div`
  background-color: #2f3136;
  padding: 40px;
  border-radius: 8px;
  box-shadow: 0 4px 10px rgba(0,0,0,0.5);
  text-align: center;
  width: 100%;
  max-width: 400px;
`;

const Title = styled.h2`
  margin-bottom: 20px;
  color: #fff;
`;

const Input = styled.input`
  width: 100%;
  padding: 10px;
  margin-bottom: 20px;
  border-radius: 4px;
  border: 1px solid #202225;
  background-color: #202225;
  color: white;
  font-size: 16px;
  outline: none;

  &:focus {
      border-color: #7289da;
  }
`;

const Button = styled.button`
  width: 100%;
  padding: 12px;
  background-color: #5865f2;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  transition: background-color 0.2s;

  &:hover {
    background-color: #4752c4;
  }
`;

const Lobby = ({ joinRoom }) => {
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (roomId.trim() && userName.trim()) {
      joinRoom(roomId, userName);
    }
  };

  return (
    <LobbyContainer>
      <Card>
        <Title>Join a Room</Title>
        <form onSubmit={handleSubmit}>
          <Input
            placeholder="Enter Your Name"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            required
          />
          <Input
            placeholder="Enter Room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            required
          />
          <Button type="submit">Join Room</Button>
        </form>
      </Card>
    </LobbyContainer>
  );
};

export default Lobby;
