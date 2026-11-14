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
  connected: true, id: 'fixture-self', roomConfig: { mediaMode: 'mesh' },
  timeout() { return { emit: (name, ...args) => { this.emit(name, ...args); if (name === 'join-room') args.at(-1)?.(null, { ok: true, mediaMode: 'mesh' }); } }; },
  on(name, listener) { if (!listeners.has(name)) listeners.set(name,new Set()); listeners.get(name).add(listener); },
  off(name, listener) { listeners.get(name)?.delete(listener); },
  emit(name, ...args) { window.socketEmissions.push({name,args}); },
};
window.socketEmissions = [];
const socket = params.get('server') ? io(params.get('server'), { auth: { clientId: crypto.randomUUID(), prepareJellyfin: true, ...(params.get('token') ? { token: params.get('token') } : {}) } }) : mockSocket;
if (params.get('server')) socket.onAnyOutgoing((name,...args)=>window.socketEmissions.push({name,args}));
window.fixtureSocket = socket;
function testStream() {
  const canvas = document.createElement('canvas');canvas.width=640;canvas.height=360;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#555';ctx.fillRect(0,0,640,360);
  const animated=params.get('motion')==='1';
  const stream=canvas.captureStream(animated?15:1);
  if(animated){
    let frame=0;
    const timer=setInterval(()=>{ctx.fillStyle=`hsl(${frame++*3%360} 45% 40%)`;ctx.fillRect(0,0,640,360);ctx.fillStyle='#fff';ctx.fillRect((frame*7)%600,120,40,80);},67);
    stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer),{once:true});
  }
  if (params.get('audio') === '1') {
    const audio = new AudioContext(), oscillator = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
    gain.gain.value = 0.001; oscillator.connect(gain).connect(destination); oscillator.start();
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    stream.getVideoTracks()[0].addEventListener('ended', () => { oscillator.stop(); audio.close(); }, { once: true });
  }
  return stream;
}
export function RoomFixture() {
  const [stream,setStream]=useState(null);
  useEffect(()=>{
    window.completeMediaPermission=()=>setStream(testStream());
    Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>testStream()});
    return ()=>{socket.disconnect?.();};
  },[]);
  return <Room socket={socket} roomId={params.get('room') || 'room-ui-test'} roomInvite={params.get('invite') || undefined} userName={params.get('name')||'Alex Morgan'} initialMuted={false} initialVideoOff={false} userStream={stream} leaveRoom={()=>{window.leftRoom=true;}}/>;
}
createRoot(document.getElementById('root')).render(<RoomFixture/>);
