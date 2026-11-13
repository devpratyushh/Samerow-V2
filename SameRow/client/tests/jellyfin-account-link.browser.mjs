import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
const require=createRequire(import.meta.url);
let chromium;
for(const path of ['playwright','/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) { try { ({chromium}=require(path)); break; } catch { /* Runtime fallback. */ } }
const backend=require('../../server/application').createApplication({store:new (require('../../server/store').MemoryStore)()});
await backend.ready;
await new Promise(resolve=>backend.server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${backend.server.address().port}`;
const upstream=http.createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req) chunks.push(chunk);
 const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
 const path=new URL(req.url,'http://fixture').pathname;
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(path==='/QuickConnect/Initiate') {json({Secret:'fixture-quick-secret',Code:'654321'});return;}
 if(path==='/QuickConnect/Connect') {json({Authenticated:false});return;}
 if(path==='/Users/AuthenticateByName') { json(body.Username==='Viewer'&&body.Pw==='password'?{AccessToken:'fixture-jellyfin-token',User:{Id:'viewer',Name:'Viewer'},ServerId:'server'}:{},body.Pw==='password'?200:401);return; }
 if(path==='/System/Info/Public') {json({Id:'server',ServerName:'My Jellyfin'});return;}
 if(!req.headers.authorization?.includes('Token="fixture-jellyfin-token"')) {json({},401);return;}
 if(path==='/Users/Me') {json({Id:'viewer',Name:'Viewer'});return;}
 if(path==='/Users/viewer/Items') {json({Items:[{Id:'movie',Name:'Multitrack fixture',Type:'Movie'}],TotalRecordCount:1});return;}
 json({},404);
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const fixture={url:`http://127.0.0.1:${upstream.address().port}`,close:async()=>{upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}};
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'});
const errors=[];
async function dashboard(uid, binding = false) {
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://media.fixture.invalid/api/jellyfin/**', async route => { const response = await route.fetch({url:base + new URL(route.request().url()).pathname + new URL(route.request().url()).search}); await route.fulfill({response}); });
 await page.route('**/api/config',route=>route.fulfill({json:{jellyfinRelay:true,mediaOrigin:'https://media.fixture.invalid'}}));
 await page.route('**/api/jellyfin-relay/connectors',route=>{
  if(route.request().url().startsWith(base))return route.fulfill({status:404,body:'Cannot GET /api/jellyfin-relay/connectors'});
  assert.equal(route.request().url(),'https://media.fixture.invalid/api/jellyfin-relay/connectors');
  assert.equal(route.request().headers()['x-samerow-token'],`dev:${uid}`);
  return route.fulfill({json:{connectors:uid==='owner'?[{id:'a'.repeat(32),address:fixture.url,name:'My Jellyfin',online:true}]:[]}});
 });
 if (binding) await page.route('**/api/jellyfin/connections', route => route.fulfill({status:403,json:{error:'Saved-library lookup denied'}}));
 await page.goto(`${process.env.UI_BASE_URL||'http://127.0.0.1:5175'}/ui-preview?scene=lobby`);
 await page.evaluate(async ({base,uid,binding})=>{
  const {default:React}=await import('/node_modules/.vite/deps/react.js');
  const {default:{createRoot}}=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {default:Lobby}=await import('/src/Lobby.jsx');
  const {default:PluginAccountBinding}=await import('/src/PluginAccountBinding.jsx');
  const {configureSession}=await import('/src/session.js');
  configureSession(async()=>`dev:${uid}`);
  document.querySelector('#root').remove();const target=document.createElement('div');document.body.append(target);
  createRoot(target).render(binding ? React.createElement(PluginAccountBinding,{id:'a'.repeat(32),base,observeAccount:listener=>{listener({uid,email:'owner@example.com',isAnonymous:false});return()=>{};}}) : React.createElement(Lobby,{authUser:{uid,displayName:'Alex',email:'alex@example.com'},serverUrl:base,serverConnected:true,joinRoom:async()=>{},generateRoom:async()=>({code:'HOST'}),toggleMute:()=>{},toggleVideo:()=>{}}));
 },{base,uid,binding});
 return {page,context};
}
try {
 const launch=await dashboard('owner',true);
 await launch.page.getByRole('button',{name:'Continue and connect Jellyfin',exact:true}).click();
 await launch.page.getByRole('dialog',{name:'Connect your Jellyfin account',exact:true}).waitFor();
 await launch.page.getByRole('button',{name:'Use Quick Connect',exact:true}).waitFor();
 await launch.context.close();
 const {page,context}=await dashboard('owner');
 const dialog=page.getByRole('dialog',{name:'Connect your Jellyfin account',exact:true});
 await dialog.waitFor();
 assert.match(await dialog.innerText(),/alex@example.com/);
 await dialog.getByRole('button',{name:'Use Quick Connect',exact:true}).click();
 await dialog.getByLabel('Quick Connect code').waitFor();
 assert.equal(await dialog.getByLabel('Quick Connect code').innerText(),'654321');
 await dialog.getByRole('button',{name:'Cancel Quick Connect',exact:true}).click();
 await dialog.getByRole('button',{name:'Use Jellyfin username and password',exact:true}).click();
 await dialog.getByLabel('Username',{exact:true}).fill('Viewer');
 await dialog.getByLabel('Password',{exact:true}).fill('wrong');
 await dialog.getByRole('button',{name:'Connect accounts',exact:true}).click();
 await dialog.getByRole('alert').waitFor();
 await dialog.getByLabel('Password',{exact:true}).fill('password');
 await dialog.getByRole('button',{name:'Connect accounts',exact:true}).click();
 await dialog.getByRole('heading',{name:'Accounts connected',exact:true}).waitFor();
 assert.equal(await page.locator('.jellyfin-library-item').count(),0,'Linking does not start room browsing');
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'/tmp/samerow-linked-account-popup.png'});
 await page.setViewportSize({width:1280,height:900});
 await dialog.getByRole('button',{name:'Done',exact:true}).click();
 await page.getByRole('heading',{name:'Library connected',exact:true}).waitFor();
 assert.match(await page.locator('.lobby-integration').innerText(),/Viewer/);
 await context.close();
 const fresh=await dashboard('owner');
 await fresh.page.getByRole('heading',{name:'Library connected',exact:true}).waitFor();
 assert.equal(await fresh.page.getByRole('dialog').count(),0,'Fresh browser restores account link without another login');
 const other=await dashboard('different-owner');
 await other.page.getByRole('button',{name:'Connect Jellyfin',exact:true}).waitFor();
 assert.equal(await other.page.getByRole('heading',{name:'Library connected',exact:true}).count(),0);
 // The room library can recover the server-side link with empty browser storage.
 await fresh.page.evaluate(async ({base})=>{
  const {default:React}=await import('/node_modules/.vite/deps/react.js');
  const {default:{createRoot}}=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {default:JellyfinDialog}=await import('/src/components/JellyfinDialog.jsx');
  const target=document.createElement('div');document.body.append(target);
  createRoot(target).render(React.createElement(JellyfinDialog,{open:true,base,onClose:()=>{},onShare:async()=>{}}));
 },{base});
 await fresh.page.getByRole('button',{name:'Watch Multitrack fixture',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 await fresh.context.close(); await other.context.close();
 console.log('PASS control-404/media discovery, account-bound popup, Quick Connect, bad password, explicit account link, mobile confirmation, new-browser restore, room library restore and owner isolation');
} catch(error) { for(const context of browser.contexts()) for(const page of context.pages()) console.log((await page.locator('body').innerText()).slice(-4000)); throw error; } finally {await browser.close();await backend.close();await fixture.close();}
