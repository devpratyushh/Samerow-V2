// Run against SameRow Local with fake Chromium camera devices.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
for (const runtime of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
 try { ({ chromium } = require(runtime)); break; } catch { /* Runtime fallback. */ }
}
assert.ok(chromium, 'Playwright is required');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
 const errors=[];let code;const pages=[];
 try{
 for(let i=0;i<4;i++){
  const context=await browser.newContext({permissions:['camera','microphone']});const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.UI_BASE_URL || 'http://127.0.0.1:8087');
  await page.waitForFunction(()=>document.querySelector('.lobby-preview-video')?.srcObject?.getVideoTracks()[0]?.getSettings().width===1920);
  await page.getByLabel('Your name',{exact:true}).fill(`Camera ${i}`);
  if(i===0){await page.getByRole('button',{name:'Host a room',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#lobby-room').value.length>0);code=await page.getByLabel('Room code',{exact:true}).inputValue();}
  else await page.getByLabel('Room code',{exact:true}).fill(code);
  await page.getByRole('button',{name:'Enter room',exact:true}).click();await page.locator('[data-self] video').waitFor();
 }
 const page=pages[0];
 await page.waitForFunction(()=>document.querySelectorAll('.participant-grid .media-tile').length===4);
 const camera=()=>page.locator('[data-self] video').evaluate(v=>v.srcObject.getVideoTracks()[0].getSettings());
 assert.equal((await camera()).width,1920);assert.equal((await camera()).height,1080);
 await page.getByRole('button',{name:'More options',exact:true}).click();await page.getByRole('button',{name:'Stats for nerds',exact:true}).click();
 assert.equal(await page.getByLabel('Call quality on this device').inputValue(),'high');
 await page.getByText('Camera capture / your preview:',{exact:false}).waitFor();
 await page.getByLabel('Call quality on this device').selectOption('balanced');await page.waitForTimeout(1200);
 assert.equal((await camera()).width,1920);assert.equal((await camera()).height,1080);
 await page.getByLabel('Call quality on this device').selectOption('high');
 assert.deepEqual(errors,[]);
 console.log('PASS real 1080p camera capture in lobby, unchanged preview across four peers and Balanced/High switching, High default and capture diagnostics');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
