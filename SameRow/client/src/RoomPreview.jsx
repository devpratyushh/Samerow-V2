import { useEffect, useRef, useState } from 'react';
import { FaCog, FaPlay } from 'react-icons/fa';
import RoomView, { MediaStatus } from './components/RoomView';
import Dialog from './components/Dialog';
import Chat from './Chat';
import Lobby from './Lobby';
import PlaybackControls from './components/PlaybackControls';
import './App.css';

const names = ['Alex Morgan', 'Jamie Chen', 'Sam Rivera', 'Taylor Brooks', 'Jordan Lee', 'Riley Carter', 'Casey Patel', 'Drew Wilson'];
const messages = [{ id: 'one', sender: 'Jamie Chen', text: 'Everyone ready? I brought the popcorn. 🍿', createdAt: new Date('2026-10-24T15:30:00Z') }, { id: 'two', sender: 'Alex Morgan', text: 'This is exactly what my evening needed.', createdAt: new Date('2026-10-24T15:31:00Z') }, { id: 'three', sender: 'Sam Rivera', text: 'Let’s make this a regular thing.', createdAt: new Date('2026-10-24T15:32:00Z') }];

function DemoMovie({ status }) {
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(754);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
    const context = canvas.getContext('2d');
    const sky = context.createLinearGradient(0,0,0,900); sky.addColorStop(0,'#173a4f'); sky.addColorStop(.55,'#bc8c6b'); sky.addColorStop(1,'#182d3a');
    context.fillStyle=sky;context.fillRect(0,0,1600,900);
    context.fillStyle='#e5b796';context.beginPath();context.arc(1010,340,80,0,Math.PI*2);context.fill();
    for(const [color,points] of [['#334e5c',[[0,590],[300,290],[670,620],[1050,370],[1600,620]]],['#213d49',[[0,720],[530,430],[950,750],[1370,530],[1600,700]]],['#122e3c',[[0,810],[250,720],[650,790],[1050,690],[1600,800]]]]) { context.fillStyle=color;context.beginPath();context.moveTo(0,900); for(const [x,y] of points)context.lineTo(x,y);context.lineTo(1600,900);context.fill(); }
    context.fillStyle='#f5e2d5';context.font='300 76px Georgia';context.fillText('A little further.',110,720);context.font='18px sans-serif';context.fillStyle='#d0d6d7';context.fillText('SOME STORIES ARE BETTER SHARED',115,770);
    const stream = canvas.captureStream(1); const video = videoRef.current; video.srcObject=stream;video.play().catch(()=>{});
    return () => stream.getTracks().forEach(track=>track.stop());
  }, []);
  useEffect(() => { if(!playing)return; const timer=setInterval(()=>setTime(value=>value+1),1000);return()=>clearInterval(timer); },[playing]);
  return <div style={{height:'100%',position:'relative',background:'#08090a'}}><video ref={videoRef} autoPlay muted playsInline style={{width:'100%',height:'100%',objectFit:'contain'}} data-preview-player="true" /><MediaStatus status={status} onRetry={['error','blocked'].includes(status.state)?()=>setPlaying(true):undefined} /><PlaybackControls label="Preview video" playing={playing} currentTime={time} duration={5400} volume={volume} muted={muted} onTogglePlay={()=>setPlaying(value=>!value)} onSeek={setTime} onVolumeChange={value=>{setVolume(value);setMuted(value===0);}} onMute={()=>{if(muted||volume===0){if(volume===0)setVolume(.5);setMuted(false);}else setMuted(true);}} note="Sample film" /></div>;

}

function DemoScreen() {
  return <div className="preview-screen"><div className="preview-screen-nav"><b>↗ Fieldnotes</b><span>A place for good ideas.</span><span>Journal &nbsp; Places &nbsp; About</span></div><div className="preview-screen-story"><small>THE WEEKEND EDIT · VOL. 08</small><h2>Find your<br />somewhere.</h2><p>Less scrolling. More getting lost.<br />A collection of places worth slowing down for.</p><div className="preview-screen-photo"><span>37° 46′ N &nbsp; 122° 25′ W</span></div></div></div>;
}

export default function RoomPreview() {
  const params = new URLSearchParams(window.location.search);
  const [scene,setScene]=useState(params.get('scene')||'screen');
  const [count,setCount]=useState(Math.max(1,Math.min(12,Number(params.get('count'))||4)));
  const [chatOpen,setChatOpen]=useState(params.get('chat')==='1');
  const [joinedRoom,setJoinedRoom]=useState('friday-movie');const [joinedName,setJoinedName]=useState('Alex Morgan');
  const [muted,setMuted]=useState(false);const [videoOff,setVideoOff]=useState(false);
  const [settings,setSettings]=useState(false);const [share,setShare]=useState(false);const [notice,setNotice]=useState('');const [unread,setUnread]=useState(0);
  const people=Array.from({length:scene==='alone'?1:count},(_,i)=>({id:`person-${i}`,name:i===0?joinedName:names[i%names.length]+(i>=8?' Jr.':''),isSelf:i===0,videoOff:i===0?videoOff:i===2,muted:i===0?muted:i===1}));
  const videoStatus={state:scene==='buffering'?'buffering':scene==='error'?'error':scene==='blocked'?'blocked':'playing'};
  const mediaScenes=['youtube','jellyfin','buffering','error','blocked','multiple'];
  const movie=<DemoMovie status={videoStatus}/>;
  const invite=()=>{setNotice('Invite link copied.');setTimeout(()=>setNotice(''),3000);};
  return <>
    {scene==='lobby'?<Lobby joinRoom={(room,name)=>{setJoinedRoom(room);setJoinedName(name);setScene('alone');}} userStream={null} isMuted={muted} isVideoOff={videoOff} toggleMute={()=>setMuted(!muted)} toggleVideo={()=>setVideoOff(!videoOff)} authUser={null} serverConnected={true} initialRoom="friday-movie" />:<RoomView roomId={joinedRoom} userName={joinedName} connected={scene!=='reconnecting'} participants={people} screenShares={['screen','multiple'].includes(scene)?[{id:'screen-demo',name:'Jamie',node:<DemoScreen/>}]:[]} youtube={{active:mediaScenes.includes(scene)&&scene!=='jellyfin',node:movie}} jellyfin={{active:scene==='jellyfin'||scene==='multiple',node:movie}} chat={<Chat roomId="preview" userName="Alex Morgan" open={chatOpen} onClose={()=>setChatOpen(false)} onUnreadChange={setUnread} preview previewMessages={messages}/>} chatOpen={chatOpen} onChatToggle={()=>setChatOpen(value=>!value)} unread={unread} muted={muted} videoOff={videoOff} onToggleMute={()=>setMuted(!muted)} onToggleVideo={()=>setVideoOff(!videoOff)} onShare={()=>setShare(true)} onLeave={()=>setScene('lobby')} onInvite={invite} notification={notice} preview />}
    <button className="preview-settings-button" onClick={()=>setSettings(true)} aria-label="Preview settings"><FaCog/></button>
    <Dialog open={settings} title="Explore the room" description="Development preview. These controls use sample data." onClose={()=>setSettings(false)}><label className="room-field">Scene<select value={scene} onChange={event=>setScene(event.target.value)}>{['lobby','alone','call','screen','youtube','jellyfin','multiple','buffering','error','blocked','reconnecting'].map(value=><option key={value}>{value}</option>)}</select></label><label className="room-field">Participants<input aria-label="Participant count" type="number" min="1" max="12" value={count} onChange={event=>setCount(Math.max(1,Math.min(12,Number(event.target.value)||1)))}/></label></Dialog>
    <Dialog open={share} title="Share with the room" description="Choose what to share." onClose={()=>setShare(false)}><div className="room-share-options">{[['screen','Your screen','Share a tab, an app, or your desktop.'],['youtube','A YouTube video','Watch a video together.'],['jellyfin','Your Jellyfin library','Stream a video from your server.']].map(([value,title,description])=><button key={value} onClick={()=>{setScene(value);setShare(false);}}><FaPlay/><span><strong>{title}</strong><small>{description}</small></span></button>)}</div></Dialog>
  </>;
}
