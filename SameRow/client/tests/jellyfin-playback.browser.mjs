import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { jellyfinFixture } from './helpers/jellyfin-fixture.mjs';
const require=createRequire(import.meta.url);
// This legacy stress fixture intentionally exceeds the four-person mesh default.
const backend = require('../../server/application').createApplication({ config: { ...require('../../server/config').configuration({}), maxRoomSize: 5 } });
let chromium;
for(const path of ['playwright','/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']){try{({chromium}=require(path));break;}catch{}}
const executablePath=process.env.BROWSER_EXECUTABLE||['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const fixture=await jellyfinFixture({media:true});
await new Promise(resolve=>backend.server.listen(0,'127.0.0.1',resolve));
const server=`http://127.0.0.1:${backend.server.address().port}`;
const base=process.env.UI_BASE_URL||'http://127.0.0.1:5175';
const browser=await chromium.launch({headless:true,executablePath,args:['--autoplay-policy=no-user-gesture-required']});
const context=await browser.newContext({viewport:{width:1280,height:800}});
const errors=[];const pages=[];
const video=page=>page.locator('.jellyfin-player video');
const add=async name=>{
 const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{window.rtcConnections=[];const Native=window.RTCPeerConnection;window.RTCPeerConnection=class extends Native{constructor(...args){super(...args);window.rtcConnections.push(this);}};});
 await page.goto(`${base}/tests/room-integration.html?server=${encodeURIComponent(server)}&name=${name}&motion=1`);
 await page.waitForFunction(()=>window.socketEmissions.some(event=>event.name==='join-room'));
 await page.evaluate(()=>window.completeMediaPermission());return page;
};
const playing=page=>page.waitForFunction(()=>{const v=document.querySelector('.jellyfin-player video');return v&&v.readyState>=3&&!v.paused&&v.currentTime>0.1;},null,{timeout:30000});
try{
 const host=await add('Host');const guest=await add('Guest');
 if (process.env.JELLYFIN_THROTTLE === '1') {
  const network = await context.newCDPSession(guest);
  await network.send('Network.enable');
  await network.send('Network.emulateNetworkConditions', {offline:false, latency:120, downloadThroughput:312500, uploadThroughput:125000});
 }
 const openLegacy = apiToken => host.evaluate(({serverUrl,apiToken})=>new Promise(resolve=>window.fixtureSocket.emit('jellyfin-open',{roomId:'room-ui-test',serverUrl,apiToken,itemId:'fixture-video'},resolve)),{serverUrl:fixture.url,apiToken});
 assert.ok((await openLegacy('wrong-token')).error);assert.equal(await video(host).count(),0);
 fixture.controls.delay=800;
 const pending=openLegacy('fixture-token');
 await host.waitForTimeout(100);assert.equal(await video(host).count(),0);assert.equal(await host.getByText('Preparing the stream…',{exact:true}).count(),0);
 assert.equal((await pending).ok,true);
 await playing(host);await playing(guest);
 assert.equal(await host.locator('.jellyfin-player').getAttribute('data-delivery'),'original');
 assert.equal(await guest.locator('.jellyfin-player').getAttribute('data-delivery'),'original');
 console.log('PASS copied video in fragmented MP4 decodes on two viewers');
 await guest.getByRole('button',{name:'Pause for everyone',exact:true}).click();
 await host.waitForFunction(()=>document.querySelector('.jellyfin-player video').paused);
 const paused=await video(host).evaluate(v=>v.currentTime);
 await guest.locator('.player-seek input').fill('20');await guest.locator('.player-seek input').press('ArrowRight');await guest.locator('.player-seek input').blur();
 await host.waitForFunction(()=>Math.abs(document.querySelector('.jellyfin-player video').currentTime-20.1)<0.3);
 assert.ok(paused<20);assert.ok(await video(host).evaluate(v=>v.paused));
 await guest.getByRole('button',{name:'Play for everyone',exact:true}).click();await playing(host);await playing(guest);
 console.log('PASS guest play/pause and seek control both players while preserving pause state');
 const originalLoads=fixture.requests.filter(r=>r.path==='/Videos/fixture-video/main.m3u8').length;
 await guest.getByLabel('Audio and subtitles',{exact:true}).click();
 await guest.getByLabel('Audio track',{exact:true}).selectOption('2');await playing(guest);
 assert.equal(fixture.requests.filter(r=>r.path==='/Videos/fixture-video/main.m3u8').length,originalLoads+1,'Only one viewer reloads after choosing audio');
 await guest.getByLabel('Subtitles',{exact:true}).selectOption('5');
 await guest.getByText(/Using compatible playback/).waitFor();
 await playing(guest);
 assert.equal(await guest.locator('.jellyfin-player').getAttribute('data-delivery'),'compatible');
 assert.equal(await host.locator('.jellyfin-player').getAttribute('data-delivery'),'original');
 await guest.getByLabel('Subtitles',{exact:true}).selectOption('4');
 await guest.waitForFunction(()=>{const t=document.querySelector('.jellyfin-player video').textTracks[0];return t?.mode==='showing'&&t.cues?.length>0;});
 assert.equal(await video(host).evaluate(v=>v.textTracks.length),0);
 assert.ok(await video(guest).evaluate(v=>v.textTracks[0].cues[0].text.includes('Hola')));
 await guest.getByRole('button',{name:'Done',exact:true}).click();
 console.log('PASS different audio streams and decoded subtitle cues stay local to each viewer');
 const oldSource=await video(host).getAttribute('src');
 const additional=[];for(const name of ['Third','Fourth','Fifth'])additional.push(await add(name));
 await Promise.all(additional.map(playing));
 await host.waitForFunction(()=>window.rtcConnections.filter(c=>c.connectionState==='connected').length>=4,null,{timeout:25000});
 assert.equal(await video(host).getAttribute('src'),oldSource,'Late join must not recreate the player');
 await host.waitForFunction(()=>window.rtcConnections.filter(c=>c.connectionState==='connected').every(c=>c.getSenders().filter(s=>s.track?.kind==='video').every(s=>s.getParameters().encodings.every(e=>e.maxBitrate<=300000))),null,{timeout:12000});
 const clocks=await Promise.all(pages.map(page=>video(page).evaluate(v=>v.currentTime)));
 assert.ok(Math.max(...clocks)-Math.min(...clocks)<1.5,`Five viewer drift ${clocks}`);
 await video(guest).evaluate(v=>{ window.sample = {start:v.currentTime, waits:0}; v.addEventListener('waiting',()=>window.sample.waits++); });
 await host.waitForTimeout(10000);
 const sample=await video(guest).evaluate(v=>({...window.sample,elapsed:v.currentTime-window.sample.start}));
 console.log('Guest playback over 10 seconds',JSON.stringify(sample));
 if (process.env.JELLYFIN_THROTTLE === '1') {
  assert.equal(sample.waits,0);
  assert.ok(sample.elapsed>9, 'The throttled guest keeps playing in real time');
 }
 const decoded=await Promise.all(pages.map(page=>video(page).evaluate(v=>({frames:v.getVideoPlaybackQuality().totalVideoFrames,drops:v.getVideoPlaybackQuality().droppedVideoFrames,time:v.currentTime}))));
 assert.ok(decoded.every(value=>value.frames>0));
 console.log('PASS five real WebRTC peers + five decoded HLS players, bounded camera bitrates, no restart on join',JSON.stringify(decoded));
 for(const width of [320,390,768,1280]){
  await guest.setViewportSize({width,height:800});
  const stage=await guest.locator('.jellyfin-player').boundingBox();const controls=await guest.locator('.jellyfin-player .player-controls').boundingBox();
  assert.ok(Math.abs(controls.y+controls.height-stage.y-stage.height)<2,`${width}: controls must anchor to the player bottom`);
  for(const label of ['Pause for everyone','Stop movie for everyone','Video fullscreen']){const box=await guest.getByRole('button',{name:label,exact:true}).boundingBox();assert.ok(box.x>=stage.x-1&&box.x+box.width<=stage.x+stage.width+1,`${width}: ${label} fits`);}
  await guest.getByLabel('Audio and subtitles',{exact:true}).click();const menu=await guest.locator('.player-track-panel').boundingBox();assert.ok(menu.x>=0&&menu.x+menu.width<=width+1);await guest.getByRole('button',{name:'Done',exact:true}).click();
 }
 console.log('PASS docked controls and track menu fit 320–1280px stages');
 await guest.bringToFront();
 await guest.screenshot({path:'/tmp/samerow-jellyfin-desktop.png'});
 await guest.getByRole('button',{name:'Video fullscreen',exact:true}).click();await guest.waitForFunction(()=>document.querySelector('.room-shell').classList.contains('is-fullscreen')); 
 await guest.mouse.move(700,200);await guest.waitForFunction(()=>document.querySelector('.jellyfin-player .player-controls').classList.contains('is-hidden'),null,{timeout:6000});
 await guest.locator('.jellyfin-player .playback-hit-area').dispatchEvent('pointermove',{pointerType:'mouse'});
 await guest.getByLabel('Audio and subtitles',{exact:true}).click();await guest.waitForTimeout(2500);assert.equal(await guest.locator('.jellyfin-player .player-controls').evaluate(el=>getComputedStyle(el).opacity),'1');
 await guest.getByRole('button',{name:'Done',exact:true}).click();await guest.getByRole('button',{name:'Exit video fullscreen',exact:true}).click();
 console.log('PASS fullscreen controls reveal and stay visible while selecting tracks');
 // A local drift must recover without broadcasting a seek to everyone.
 const commands=await host.evaluate(()=>window.socketEmissions.filter(e=>e.name==='jellyfin-command').length);
 await video(host).evaluate(v=>{v.currentTime=Math.max(0,v.currentTime-4);});
 await host.waitForTimeout(2000);const delta=Math.abs(await video(host).evaluate(v=>v.currentTime)-await video(guest).evaluate(v=>v.currentTime));assert.ok(delta<0.6,`Recovery drift ${delta}`);
 assert.equal(await host.evaluate(()=>window.socketEmissions.filter(e=>e.name==='jellyfin-command').length),commands);
 await host.close();
 await playing(guest);
 assert.equal(await guest.locator('.jellyfin-player').count(),1,'Host departure must not interrupt playback');
 await guest.getByRole('button',{name:'Stop movie for everyone',exact:true}).click();await Promise.all(pages.filter(page=>!page.isClosed()).map(page=>video(page).waitFor({state:'detached'})));
 assert.deepEqual(errors,[]);console.log('PASS local drift recovery, playback after host departure, shared stop, no browser page errors');
} finally {await context.close();await browser.close();await new Promise(resolve=>backend.io.close(resolve));await fixture.close();}
