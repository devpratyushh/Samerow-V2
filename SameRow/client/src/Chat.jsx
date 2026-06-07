import React, { useState, useEffect, useRef } from 'react';
import styled from 'styled-components';
import { db } from './firebase';
import { collection, query, orderBy, onSnapshot, addDoc, serverTimestamp } from 'firebase/firestore';
import { FaPaperPlane, FaTimes } from 'react-icons/fa';

const ChatContainer = styled.div`
  width: 320px;
  background-color: rgba(28, 28, 30, 0.85);
  backdrop-filter: blur(20px);
  display: flex;
  flex-direction: column;
  height: 100%;
  border-left: 1px solid rgba(255,255,255,0.1);
  transition: all 0.3s ease;
  z-index: 90;

  @media (max-width: 768px) {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 100%;
    max-width: 320px;
  }
`;

const ChatHeader = styled.div`
  padding: 16px;
  border-bottom: 1px solid rgba(255,255,255,0.1);
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  font-size: 16px;
  color: white;
`;

const CloseButton = styled.button`
  background: none;
  border: none;
  color: rgba(255,255,255,0.6);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  &:hover { color: white; }
`;

const MessagesArea = styled.div`
  flex: 1;
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;

  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
`;

const MessageBubble = styled.div`
  max-width: 85%;
  align-self: ${props => props.isMine ? 'flex-end' : 'flex-start'};
  background-color: ${props => props.isMine ? '#0a84ff' : 'rgba(255,255,255,0.1)'};
  color: white;
  padding: 10px 14px;
  border-radius: 18px;
  border-bottom-right-radius: ${props => props.isMine ? '4px' : '18px'};
  border-bottom-left-radius: ${props => !props.isMine ? '4px' : '18px'};
  word-wrap: break-word;
`;

const SenderName = styled.div`
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  margin-bottom: 4px;
  text-align: ${props => props.isMine ? 'right' : 'left'};
  padding: 0 4px;
`;

const InputContainer = styled.form`
  display: flex;
  padding: 16px;
  gap: 10px;
  border-top: 1px solid rgba(255,255,255,0.1);
  background-color: rgba(0,0,0,0.2);
`;

const ChatInput = styled.input`
  flex: 1;
  background-color: rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.1);
  color: white;
  padding: 10px 14px;
  border-radius: 20px;
  outline: none;
  font-size: 14px;
  
  &:focus { border-color: #0a84ff; }
`;

const SendButton = styled.button`
  background-color: #0a84ff;
  color: white;
  border: none;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  transition: background-color 0.2s;
  
  &:hover { background-color: #007aff; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const Chat = ({ roomId, userName, onClose }) => {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!roomId) return;
    const messagesRef = collection(db, 'rooms', roomId, 'messages');
    const q = query(messagesRef, orderBy('createdAt', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setMessages(msgs);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    });

    return () => unsubscribe();
  }, [roomId]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    try {
      const messagesRef = collection(db, 'rooms', roomId, 'messages');
      await addDoc(messagesRef, {
        text: newMessage,
        sender: userName,
        createdAt: serverTimestamp()
      });
      setNewMessage('');
    } catch (error) {
      console.error("Error sending message:", error);
    }
  };

  return (
    <ChatContainer>
      <ChatHeader>
        Room Chat
        <CloseButton onClick={onClose}><FaTimes /></CloseButton>
      </ChatHeader>
      
      <MessagesArea>
        {messages.map((msg) => {
          const isMine = msg.sender === userName;
          return (
            <div key={msg.id} style={{ display: 'flex', flexDirection: 'column' }}>
              {!isMine && <SenderName isMine={isMine}>{msg.sender}</SenderName>}
              <MessageBubble isMine={isMine}>
                {msg.text}
              </MessageBubble>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </MessagesArea>

      <InputContainer onSubmit={handleSend}>
        <ChatInput 
          placeholder="Type a message..." 
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
        />
        <SendButton type="submit" disabled={!newMessage.trim()}>
          <FaPaperPlane size={14} />
        </SendButton>
      </InputContainer>
    </ChatContainer>
  );
};

export default Chat;
