// Exercise production YouTube controls through ReactPlayer's public custom-player API.
// Only the network/media provider is replaced; room UI, synchronization, and controls are real.
import { forwardRef, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactPlayer from 'react-player';
import RoomView from '../src/components/RoomView';
import YouTubePlayer from '../src/YouTubePlayer';
import Chat from '../src/Chat';
import '../src/index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only.');
window.playerCommands = [];
window.playerMounts = 0;
const params = new URLSearchParams(location.search);
window.blockPlayback = params.has('blocked');
window.playAttempts = 0;
window.metadataLoaded = false;
const FixtureProvider = forwardRef(function FixtureProvider(props, ref) {
  const bind = useCallback(node => {
    if (node && !node._fixtureReady) {
      node._fixtureReady = true; node._clock = 0; node._paused = true; window.playerMounts++;
      Object.defineProperties(node, {
        currentTime: { configurable: true, get() { return this._clock; }, set(value) { this._clock = value; queueMicrotask(() => { this.dispatchEvent(new Event('seeked')); this.dispatchEvent(new Event('timeupdate')); }); } },
        duration: { configurable: true, get() { return 600; } },
        paused: { configurable: true, get() { return this._paused; } },
      });
      if (params.has('event-blocked')) {
        const events = new Map();
        node.api = { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) };
        window.signalAutoplayBlocked = () => { events.get('onAutoplayBlocked')?.(); node.dispatchEvent(new Event('pause')); };
      }
      node.play = function() { window.playAttempts++; if (window.blockPlayback) {
        if (params.has('event-blocked')) queueMicrotask(() => window.signalAutoplayBlocked());
        return params.has('hang') ? new Promise(() => {}) : Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
      } this._paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); };
      node.pause = function() { this._paused = true; this.dispatchEvent(new Event('pause')); };
      window.fixturePlayer = node;
    }
    if (typeof ref === 'function') ref(node); else if (ref) ref.current = node;
  }, [ref]);
  useEffect(() => { const timer = setTimeout(() => { window.metadataLoaded = true; window.fixturePlayer.dispatchEvent(new Event('loadedmetadata')); }, Number(params.get('delay')) || 30); return () => clearTimeout(timer); }, []);
  const events = Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith('on')));
  return <video {...events} ref={bind} controls={props.controls} muted={props.muted} style={{width:'100%',height:'100%',background:'#181b20'}} aria-label="Fixture media provider" />;
});
if (!new URLSearchParams(location.search).has('live')) ReactPlayer.addCustomPlayer({ key: 'fixture', canPlay: () => true, player: FixtureProvider });
const initial = {url:'https://www.youtube.com/watch?v=M7lc1UVf-VE',sessionId:'fixture',timestamp:42,isPlaying:window.blockPlayback,receivedAt:performance.now()};
const people = ['Alex Morgan','Jamie Chen','Sam Rivera','Taylor Brooks'].map((name,index)=>({id:`person-${index}`,name,isSelf:index===0,muted:index===1}));
export function PlaybackFixture() {
  const [state,setState] = useState(initial);
  const [active,setActive] = useState(true);
  const [chatOpen,setChatOpen] = useState(false);
  const [connected,setConnected] = useState(true);
  const socket = {connected,emit:(event,payload)=>{window.playerCommands.push({event,...payload});}};
  useEffect(()=>{
    window.applyRemotePlayback = value => setState(previous=>({...previous,...value,receivedAt:performance.now()}));
    window.setFixtureConnection = setConnected;
  },[]);
  return <RoomView roomId="playback-test" userName="Alex Morgan" participants={people} chatOpen={chatOpen} onChatToggle={()=>setChatOpen(value=>!value)} chat={<Chat roomId="fixture" userName="Alex Morgan" open={chatOpen} onClose={()=>setChatOpen(false)} preview />} muted={false} videoOff={false} onToggleMute={()=>{}} onToggleVideo={()=>{}} onShare={()=>{}} onLeave={()=>{}} onInvite={()=>{}} youtube={{active,node:focused=>active?<YouTubePlayer state={state} socket={socket} roomId="playback-test" focused={focused} onClose={()=>setActive(false)}/>:null}} />;
}
createRoot(document.getElementById('root')).render(<PlaybackFixture/>);
