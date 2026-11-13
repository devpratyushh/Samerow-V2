import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'});
const context=await browser.newContext({viewport:{width:390,height:844}}), page=await context.newPage();
let state='ready', fail=false, user='owner', health='ready'; const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/config',r=>r.fulfill({json:{}}));
await page.route('**/api/jellyfin/status',r=>fail?r.fulfill({status:503,json:{error:'Gateway restarting'}}):r.fulfill({json:{checkedAt:Date.now(),servers:user==='owner'?[{id:'a'.repeat(32),address:'https://home.invalid',name:'Home cinema',sameRowEmail:'owner@example.com',account:{userName:'Viewer'},lastSeen:Date.now()-120000,status:state,message:state==='offline'?'Start Jellyfin on your home server. Your binding is saved.':'Ready to watch.'}]:[]}}));
await page.route('**/health-test',r=>r.fulfill({json:{status:health}}));
try {
 await page.goto((process.env.UI_BASE_URL||'http://127.0.0.1:5178')+'/ui-preview');
 await page.evaluate(async()=>{
  const {default:React}=await import('/node_modules/.vite/deps/react.js');const {default:{createRoot}}=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {useAccountConnectors}=await import('/src/useAccountConnectors.js');const {default:Status}=await import('/src/components/JellyfinStatus.jsx');const {configureSession}=await import('/src/session.js');const {useJellyfinRecovery}=await import('/src/useJellyfinRecovery.js');
  configureSession(async()=> 'dev:owner');
  function Test(){const [uid,setUid]=React.useState('owner');window.switchUser=setUid;const connections=useAccountConnectors(location.origin,uid);const recovery=useJellyfinRecovery('/health-test',()=>{window.recovered=(window.recovered||0)+1;});return React.createElement(React.Fragment,null,React.createElement(Status,{connections,base:location.origin,onConnect:()=>{},onBrowse:()=>{}}),React.createElement('p',{id:'recovery'},recovery));}
  document.querySelector('#root').remove();const target=document.createElement('div');document.body.append(target);createRoot(target).render(React.createElement(Test));
 });
 const badge=page.locator('.jellyfin-status-badge');
 await badge.getByText('Ready',{exact:true}).waitFor();
 state='offline';await page.getByRole('button',{name:'Check again'}).click();await badge.getByText('Offline',{exact:true}).waitFor();
 assert.match(await page.locator('body').innerText(),/Viewer/);assert.equal(await page.getByRole('button',{name:'Browse library'}).isDisabled(),true);
 fail=true;await page.getByRole('button',{name:'Check again'}).click();await badge.getByText('Status unavailable',{exact:true}).waitFor();assert.match(await page.locator('body').innerText(),/Viewer/);
 await context.setOffline(true);await badge.getByText('You’re offline',{exact:true}).waitFor();
 fail=false;state='ready';await context.setOffline(false);await badge.getByText('Ready',{exact:true}).waitFor();
 await page.waitForFunction(()=>window.recovered===1);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Phone layout must fit viewport');
 user='other';await page.evaluate(()=>window.switchUser('other'));await page.waitForFunction(()=>!document.querySelector('.jellyfin-status-card'));
 assert.doesNotMatch(await page.locator('body').innerText(),/owner@example.com|Viewer/);
 assert.deepEqual(errors,[]);
 console.log('PASS phone layout, offline binding, gateway uncertainty, client connectivity, playback recovery, account isolation');
} finally {await browser.close();}
