// Development fixture exercising the actual Room and its transport lifecycle.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import Room from '../src/Room';
import '../src/index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only.');
const params = new URLSearchParams(window.location.search);
const listeners = new Map();
const mockSocket = {
  connected: true, id: 'fixture-self',
  on(name, listener) { if (!listeners.has(name)) listeners.set(name,new Set()); listeners.get(name).add(listener); },
  off(name, listener) { listeners.get(name)?.delete(listener); },
  emit(name, ...args) { window.socketEmissions.push({name,args}); },
};
window.socketEmissions = [];
const socket = params.get('server') ? io(params.get('server')) : mockSocket;
if (params.get('server')) socket.onAnyOutgoing((name,...args)=>window.socketEmissions.push({name,args}));
window.fixtureSocket = socket;
function testStream() {
  const canvas = document.createElement('canvas');canvas.width=640;canvas.height=360;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#555';ctx.fillRect(0,0,640,360);
  const stream=canvas.captureStream(1);
  return stream;
}
export function RoomFixture() {
  const [stream,setStream]=useState(null);
  useEffect(()=>{
    window.completeMediaPermission=()=>setStream(testStream());
    Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>testStream()});
    return ()=>{socket.disconnect?.();};
  },[]);
  return <Room socket={socket} roomId="room-ui-test" userName={params.get('name')||'Alex Morgan'} initialMuted={false} initialVideoOff={false} userStream={stream} leaveRoom={()=>{window.leftRoom=true;}}/>;
}
createRoot(document.getElementById('root')).render(<RoomFixture/>);
