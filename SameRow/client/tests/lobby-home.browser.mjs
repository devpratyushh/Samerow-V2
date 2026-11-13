// Requires the Vite development server; checks home fit and host/join behavior.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
for (const name of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
 try { ({ chromium } = require(name)); break; } catch { /* Runtime fallback. */ }
}
assert.ok(chromium, 'Playwright is required');
(async () => {
 const browser = await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'});
 try {
  const page=await browser.newPage();
  await page.goto(`${process.env.UI_BASE_URL || 'http://127.0.0.1:5176'}/ui-preview?scene=lobby`);
  await page.evaluate(async()=>{
   const {default:React}=await import('/node_modules/.vite/deps/react.js');
   const {default:{createRoot}}=await import('/node_modules/.vite/deps/react-dom_client.js');
   const {default:Lobby}=await import('/src/Lobby.jsx');
   document.querySelector('#root').remove();
   const target=document.createElement('div');target.id='lobby-test';document.body.append(target);
   localStorage.setItem('recent_rooms_lobby-test',JSON.stringify(['ONE','TWO','THREE','FOUR','FIVE'].map((code,i)=>({code,timestamp:Date.now()-i*60000}))));
   window.generatedCount=0;window.joined=[];
   createRoot(target).render(React.createElement(Lobby,{authUser:{uid:'lobby-test',displayName:'Alex'},serverConnected:true,generateRoom:async()=>{window.generatedCount++;return {code:'HOST'};},joinRoom:async(code)=>window.joined.push(code),toggleMute:()=>{},toggleVideo:()=>{}}));
  });
  const lobby=page.locator('#lobby-test');
  await lobby.getByLabel('Room code',{exact:true}).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await lobby.getByLabel('Room code',{exact:true}).inputValue(),'');
  assert.equal(await page.evaluate(()=>window.generatedCount),0);
  assert.equal(await lobby.locator('.lobby-history li').count(),3);
  assert.equal(await lobby.locator('.lobby-join-card .lobby-history').count(),0);
  await lobby.getByLabel('Room code',{exact:true}).fill('FRIEND');
  await lobby.getByRole('button',{name:'Enter room',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.joined),['FRIEND']);
  await lobby.getByRole('button',{name:'Host a room',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#lobby-test #lobby-room').value==='HOST');
  assert.equal(await page.evaluate(()=>window.generatedCount),1);
  assert.equal(await lobby.locator('.lobby-history li').count(),3);
  for(const [width,height] of [[1440,900],[1280,720],[1280,650],[1024,768],[390,844],[375,812],[375,667]]) {
   await page.setViewportSize({width,height});
   const bounds=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,viewport:innerHeight}));
   assert.ok(bounds.width<=width,`horizontal overflow at ${width}`);
   assert.ok(bounds.height<=height,`vertical overflow at ${width}×${height}: ${JSON.stringify(bounds)}`);
  }
  await page.setViewportSize({width:1440,height:900});
  await page.screenshot({path:'/tmp/samerow-home-desktop.png'});
  await lobby.getByRole('button',{name:'Connect Jellyfin',exact:true}).click();
  await page.getByRole('dialog',{name:'Your account & Jellyfin',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/samerow-home-mobile.png'});
  console.log('PASS empty code, explicit host/manual join, three recent rooms, Jellyfin dialog, and no scrolling at seven desktop/tablet/mobile viewport sizes');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
