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
try {
 const host = await add('Host');
 let release;
 const gate = new Promise(resolve => { release = resolve; });
 await host.route('**/stream.m3u8?**', async route => { await gate; await route.continue(); });
 const opened = await host.evaluate(({serverUrl}) => new Promise(resolve => window.fixtureSocket.emit('jellyfin-open', {roomId:'room-ui-test', serverUrl, apiToken:'fixture-token', itemId:'fixture-video'}, resolve)), {serverUrl:fixture.url});
 assert.equal(opened.ok, true);
 await host.getByText(/No response bytes yet/).waitFor();
 await host.getByText('Playback & network details', {exact:true}).click();
 assert.match(await host.locator('.jellyfin-playback-details').innerText(), /Waiting for response/);
 release();
 await playing(host);
 await host.locator('.player-nerd-stats > summary').click();
 await host.waitForFunction(() => document.querySelector('.player-nerd-stats').textContent.includes('HTTP 200'));
 const text = await host.locator('.player-nerd-stats').innerText();
 assert.match(text, /ms first byte/);
 assert.match(text, /MiB/);
 assert.match(text, /Mbps/);
 assert.doesNotMatch(text, /fixture-token|must-not-leak|api_key|accessToken/);
 for (const width of [390, 1280]) {
  await host.setViewportSize({width,height:800});
  assert.ok(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await host.screenshot({path:`/tmp/samerow-network-${width}.png`});
 }
 assert.deepEqual(errors, []);
 console.log('PASS delayed manifest diagnosis, real HLS request timings and bytes, credential redaction, responsive network stats, decoded playback');
} finally { await context.close(); await browser.close(); await backend.close(); await fixture.close(); }
