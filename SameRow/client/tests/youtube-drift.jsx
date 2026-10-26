// Production player and synchronization; only media timing and network delay are simulated.
import { forwardRef, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import ReactPlayer from 'react-player';
import RoomView from '../src/components/RoomView';
import YouTubePlayer from '../src/YouTubePlayer';
import { connectYouTubeRoom } from '../src/youtubeRoom';
import '../src/index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only.');
const params=new URLSearchParams(location.search);
const url='https://www.youtube.com/watch?v=M7lc1UVf-VE';
window.syncMetrics={commands:[],seeks:[],rates:[],playedAt:[]};
const ClockVideo=forwardRef(function ClockVideo(props,ref) {
  const bind=useCallback(node=>{
    if(node&&!node._clockReady){
      node._clockReady=true;node._position=0;node._anchor=performance.now();node._paused=true;node._buffering=false;node._rate=1;
      Object.defineProperties(node,{
        currentTime:{configurable:true,get(){return this._position+(!this._paused&&!this._buffering?(performance.now()-this._anchor)/1000*this._rate:0);},set(value){this._position=value;this._anchor=performance.now();window.syncMetrics.seeks.push({value,at:performance.now()});queueMicrotask(()=>{this.dispatchEvent(new Event('seeked'));this.dispatchEvent(new Event('timeupdate'));});}},
        paused:{configurable:true,get(){return this._paused;}},
        duration:{configurable:true,get(){return 600;}},
        playbackRate:{configurable:true,get(){return this._rate;},set(value){if(value===this._rate)return;window.syncMetrics.rates.push(value);if(params.has('reject-rate')&&value!==1)return;this._position=this.currentTime;this._anchor=performance.now();this._rate=value;}},
      });
      const events=new Map();
      node.api={getAvailablePlaybackRates:()=>params.has('soft')?[0.95,1,1.05]:[0.25,0.5,1,1.25,1.5,2],addEventListener:(name,callback)=>events.set(name,callback),removeEventListener:name=>events.delete(name)};
      const begin=()=>{node._buffering=false;node._paused=false;node._anchor=performance.now();window.syncMetrics.playedAt.push(performance.now());node.dispatchEvent(new Event('playing'));};
      node.play=function(){
        this._paused=false;
        if(!this._started&&Number(params.get('startDelay'))>0){this._started=true;this._buffering=true;this.dispatchEvent(new Event('waiting'));return new Promise(resolve=>setTimeout(()=>{begin();resolve();},Number(params.get('startDelay'))));}
        this._started=true;begin();return Promise.resolve();
      };
      node.pause=function(){this._position=this.currentTime;this._anchor=performance.now();this._paused=true;this.dispatchEvent(new Event('pause'));};
      window.syncPlayer=node;
      window.nudge=delta=>{node._position=node.currentTime+delta;node._anchor=performance.now();};
      window.buffer=()=>{node._position=node.currentTime;node._buffering=true;node.dispatchEvent(new Event('waiting'));};
      window.unbuffer=()=>begin();
    }
    if(typeof ref==='function')ref(node);else if(ref)ref.current=node;
  },[ref]);
  useEffect(()=>{const timer=setTimeout(()=>window.syncPlayer.dispatchEvent(new Event('loadedmetadata')),30);return()=>clearTimeout(timer);},[]);
  return <video {...Object.fromEntries(Object.entries(props).filter(([key])=>key.startsWith('on')))} ref={bind} aria-label="Clock media provider" style={{width:'100%',height:'100%',background:'#17191d'}}/>;
});
ReactPlayer.addCustomPlayer({key:'clock',canPlay:()=>true,player:ClockVideo});
const raw=params.get('server')?io(params.get('server'),{transports:['websocket']}):null;
const tx=Number(params.get('tx'))||0,rx=Number(params.get('rx'))||0;
const wrappers=new Map();
const delayedCallback=callback=>(...args)=>setTimeout(()=>callback(...args),rx);
const send=(target,name,args)=>{
  if(name==='youtube-state-change')window.syncMetrics.commands.push({...args[0],at:performance.now()});
  const values=[...args];
  if(typeof values.at(-1)==='function')values[values.length-1]=delayedCallback(values.at(-1));
  setTimeout(()=>target.emit(name,...values),tx);
};
const transport=raw?{
  get connected(){return raw.connected;},get id(){return raw.id;},
  on(name,callback){const wrapper=delayedCallback(callback);wrappers.set(callback,wrapper);raw.on(name,wrapper);},
  off(name,callback){raw.off(name,wrappers.get(callback));wrappers.delete(callback);},
  emit(name,...args){send(raw,name,args);},
  timeout(ms){return{emit:(name,...args)=>send(raw.timeout(ms),name,args)};},
}:null;
const people=[{id:'self',name:'Viewer',isSelf:true}];
export function Fixture(){
  const [state,setState]=useState(()=>raw?null:{url,sessionId:'fixture',revision:1,timestamp:42,isPlaying:!params.has('paused'),receivedAt:performance.now()});
  const [connected,setConnected]=useState(raw?.connected??true);
  const socket=transport||{connected,emit:(name,payload)=>{if(name==='youtube-state-change')window.syncMetrics.commands.push({...payload,at:performance.now()});}};
  useEffect(()=>{
    window.remote=value=>setState(previous=>({...previous,...value,receivedAt:performance.now()}));
    window.connection=setConnected;
    if(!raw)return;
    const room=connectYouTubeRoom({socket:transport,roomId:'drift-test',userName:'Viewer',onState:setState,onSubmitted:()=>{},onError:error=>{window.roomError=error;}});
    const onConnect=()=>setConnected(true),onDisconnect=()=>setConnected(false);
    raw.on('connect',onConnect);raw.on('disconnect',onDisconnect);
    window.openVideo=()=>room.submit({url,startTime:42});window.reconnect=()=>raw.connect();window.disconnect=()=>raw.disconnect();
    return()=>{room.dispose();raw.off('connect',onConnect);raw.off('disconnect',onDisconnect);raw.disconnect();};
  },[]);
  useEffect(()=>{window.roomState=state;window.fixtureConnected=connected;},[state,connected]);
  return <RoomView roomId="drift-test" userName="Viewer" participants={people} connected={connected} muted={false} videoOff={false} onToggleMute={()=>{}} onToggleVideo={()=>{}} onShare={()=>{}} onLeave={()=>{}} onInvite={()=>{}} youtube={{active:!!state?.url,node:focused=>state?.url?<YouTubePlayer key={state.sessionId} state={state} socket={socket} roomId="drift-test" focused={focused} onClose={()=>{}}/>:null}}/>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
