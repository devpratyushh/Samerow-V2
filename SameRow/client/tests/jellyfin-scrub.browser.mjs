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
 const query = new URLSearchParams({ server, name, token: `dev:${name}`, motion: '1' });
 await page.goto(`${base}/tests/room-integration.html?${query}`);
 await page.waitForFunction(()=>window.socketEmissions.some(event=>event.name==='join-room'));
 await page.evaluate(()=>window.completeMediaPermission());
 if (name !== 'Host') await pages[0].getByRole('button', { name: 'Accept', exact: true }).click();
 if (pages.length < 3) await page.waitForFunction(() => window.fixtureSocket.roomConfig?.ok);
 return page;
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
 // Hold outgoing controls longer than a sync tick to expose stale-timeline snapbacks.
 await guest.evaluate(() => {
  const socket = window.fixtureSocket;
  const original = socket.emit;
  socket.emit = function (name, ...args) {
   if (name === 'jellyfin-command') { setTimeout(() => original.call(this, name, ...args), 900); return this; }
   return original.call(this, name, ...args);
  };
  window.restoreSeekTransport = () => { socket.emit = original; };
 });
 await guest.locator('.player-seek input').fill('35');
 await guest.locator('.player-seek input').press('ArrowRight');
 await guest.waitForTimeout(500);
 assert.ok(Math.abs(await video(guest).evaluate(v => v.currentTime) - 35.1) < 0.3, 'Local scrub survives a sync tick before its server echo');
 await host.waitForFunction(() => Math.abs(document.querySelector('.jellyfin-player video').currentTime - 35.1) < 0.3);
 await guest.evaluate(() => window.restoreSeekTransport());
 console.log('PASS delayed scrub stays at the local target and reaches the other viewer');
 await guest.getByRole('button',{name:'Play for everyone',exact:true}).click();await playing(host);await playing(guest);
 console.log('PASS guest play/pause and seek control both players while preserving pause state');
 // Keep peers on different audio tracks while controls and reloads overlap.
 const hostLoads = fixture.requests.filter(request => request.path === '/Videos/fixture-video/main.m3u8' && request.query.AudioStreamIndex === '1').length;
 await guest.getByLabel('Audio and subtitles', { exact: true }).click();
 await guest.getByLabel('Audio track', { exact: true }).selectOption('2');
 await guest.getByRole('button', { name: 'Done', exact: true }).click();
 await playing(guest);
 assert.equal(fixture.requests.filter(request => request.path === '/Videos/fixture-video/main.m3u8' && request.query.AudioStreamIndex === '1').length, hostLoads);
 await host.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
 await guest.waitForFunction(() => document.querySelector('.jellyfin-player video').paused);
 // Reproduce a decoder waiting event while a peer sends a new room position.
 await guest.evaluate(() => {
  const v = document.querySelector('.jellyfin-player video');
  const hold = event => event.stopImmediatePropagation();
  v.addEventListener('canplay', hold, true);
  v.addEventListener('playing', hold, true);
  window.restoreWaitingPeer = () => {
   v.removeEventListener('canplay', hold, true);
   v.removeEventListener('playing', hold, true);
   v.dispatchEvent(new Event('canplay'));
  };
  v.dispatchEvent(new Event('waiting'));
 });
 await host.locator('.player-seek input').fill('15');
 await host.locator('.player-seek input').press('ArrowRight');
 await guest.waitForFunction(() => Math.abs(document.querySelector('.jellyfin-player video').currentTime - 15.1) < 0.3, null, { timeout: 5000 });
 await guest.evaluate(() => window.restoreWaitingPeer());
 await host.getByRole('button', { name: 'Play for everyone', exact: true }).click();
 await playing(host); await playing(guest);
 console.log('PASS shared controls reach a buffering peer with a different audio track');
 const third = await add('Third'); const fourth = await add('Fourth');
 const viewers = [host, guest, third, fourth];
 await Promise.all(viewers.map(playing));
 if (process.env.JELLYFIN_COMPATIBLE === '1') {
  await Promise.all(viewers.map(async page => {
   await page.getByLabel('Audio and subtitles', { exact: true }).click();
   await page.getByLabel('Quality on this device', { exact: true }).selectOption('auto');
   await page.getByRole('button', { name: 'Done', exact: true }).click();
   await page.locator('.jellyfin-player[data-delivery="compatible"]').waitFor();
   await playing(page);
  }));
 }
 await Promise.all(viewers.map(page => video(page).evaluate(video => {
  window.scrubStats = { stalls: 0, reloads: 0 };
  video.addEventListener('waiting', () => window.scrubStats.stalls++);
  video.addEventListener('emptied', () => window.scrubStats.reloads++);
 })));
 const commands = await guest.evaluate(() => window.socketEmissions.filter(event => event.name === 'jellyfin-command').length);
 await guest.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
 await host.waitForFunction(() => document.querySelector('.jellyfin-player video').paused);
 const slider = guest.locator('.player-seek input');
 await slider.fill('10'); await slider.press('ArrowRight');
 await slider.fill('40'); await slider.press('ArrowRight');
 await slider.fill('25'); await slider.press('ArrowRight');
 await host.waitForFunction(() => Math.abs(document.querySelector('.jellyfin-player video').currentTime - 25.1) < 0.3);
 await guest.waitForTimeout(700);
 assert.ok(Math.abs(await video(guest).evaluate(v => v.currentTime) - 25.1) < 0.3);
 assert.equal(await guest.evaluate(() => window.socketEmissions.filter(event => event.name === 'jellyfin-command').length), commands + 2, 'Rapid seeks commit only the final position');
 const beforeDrag = await guest.evaluate(() => window.socketEmissions.filter(event => event.name === 'jellyfin-command').length);
 const bounds = await slider.boundingBox();
 await guest.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height / 2);
 await guest.mouse.down();
 await guest.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + 100, { steps: 8 });
 await guest.mouse.up();
 await guest.waitForFunction(before => window.socketEmissions.filter(event => event.name === 'jellyfin-command').length === before + 1, beforeDrag);
 const dragTarget = await guest.evaluate(() => window.socketEmissions.filter(event => event.name === 'jellyfin-command').at(-1).args[0].time);
 await host.waitForFunction(target => Math.abs(document.querySelector('.jellyfin-player video').currentTime - target) < 0.3, dragTarget);
 console.log('PASS releasing a scrub outside the slider commits once');
 await Promise.all(viewers.map(page => page.waitForFunction(target => Math.abs(document.querySelector('.jellyfin-player video').currentTime - target) < 0.3, dragTarget)));
 await fourth.getByRole('button', { name: 'Play for everyone', exact: true }).click();
 await Promise.all(viewers.map(playing));
 const finalTime = 53.1;
 const beforeBurst = await guest.evaluate(() => window.socketEmissions.filter(event => event.name === 'jellyfin-command').length);
 for (const target of [8, 52, 5, 49, 11, 43, 17, 38, 20, 53]) {
  await slider.fill(String(target));
  await slider.press('ArrowRight');
 }
 await Promise.all(viewers.map(page => page.waitForFunction(target => {
  const video = document.querySelector('.jellyfin-player video');
  return video && !video.paused && !video.seeking && video.readyState >= 3 && video.currentTime >= target - 0.2 && video.currentTime <= target + 10;
 }, finalTime, { timeout: 10000 })));
 assert.equal(await guest.evaluate(() => window.socketEmissions.filter(event => event.name === 'jellyfin-command').length), beforeBurst + 1);
 const positions = await Promise.all(viewers.map(page => video(page).evaluate(video => video.currentTime)));
 assert.ok(Math.max(...positions) - Math.min(...positions) < 1.25, `Post-seek drift: ${positions}`);
 const scrubStats = await Promise.all(viewers.map(page => page.evaluate(() => window.scrubStats)));
 assert.ok(scrubStats.every(stats => stats.reloads === 0));
 console.log('Four-viewer rapid seek recovery', JSON.stringify({ positions, scrubStats }));
 await host.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
 await Promise.all(viewers.map(page => page.waitForFunction(() => document.querySelector('.jellyfin-player video').paused)));
 await fourth.getByRole('button', { name: 'Stop movie for everyone', exact: true }).click();
 await Promise.all(viewers.map(page => video(page).waitFor({ state: 'detached' })));
 console.log('PASS play, pause, seek and stop reach all four peers with independent audio');
 assert.deepEqual(errors, []);
 console.log('PASS rapid forward/backward scrubs converge without extra shared commands');
} finally {await context.close();await browser.close();await new Promise(resolve=>backend.io.close(resolve));await fixture.close();}
