import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
for (const name of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
  try { ({ chromium } = require(name)); break; } catch { /* Runtime fallback. */ }
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' });
try {
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/jellyfin/connections', route => route.fulfill({ json: { connections: route.request().headers()['x-samerow-token'] === 'owner-a' ? [{ account: { serverUrl: 'https://paired.example', serverName: 'Home cinema', userName: 'Alex', userId: 'viewer' } }] : [] } }));
  await page.route('**/api/config', route => route.fulfill({ json: { jellyfinRelay: true } }));
  await page.route('**/api/jellyfin-relay/connectors', async route => {
    const owner = route.request().headers()['x-samerow-token'];
    if (owner === 'owner-a') await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ json: { connectors: owner === 'owner-a' ? [{id:'a'.repeat(32),name:'Home cinema',address:`https://${'a'.repeat(32)}.samerow-connector.invalid`,online:true}] : [] } });
  });
  await page.goto(`${process.env.UI_BASE_URL || 'http://127.0.0.1:5175'}/ui-preview?scene=lobby`);
  await page.evaluate(async () => {
    const {default:React} = await import('/node_modules/.vite/deps/react.js');
    const {default:{createRoot}} = await import('/node_modules/.vite/deps/react-dom_client.js');
    const {default:Lobby} = await import('/src/Lobby.jsx');
    const {configureSession} = await import('/src/session.js');
    const {accountActions} = await import('/src/firebase.js');
    document.querySelector('#root').remove();
    const target = document.createElement('div'); document.body.append(target);
    const root = createRoot(target);
    window.authCalls = [];
    accountActions.signIn = async (provider, options) => {
      window.authCalls.push([provider, options]);
      return {user:{uid:'owner-a',providerData:[{providerId:'google.com'},{providerId:provider}]}};
    };
    window.renderAccount = uid => {
      configureSession(async () => uid || 'guest');
      root.render(React.createElement(Lobby, {authUser:uid ? {uid,displayName:'Alex',email:'alex@example.com',providerData:[{providerId:'google.com'}]} : null, serverUrl:'',serverConnected:true, generateRoom:async()=>({code:'HOST'}),joinRoom:async()=>{},toggleMute:()=>{},toggleVideo:()=>{}}));
    };
    window.renderAccount('owner-a');
  });
  await page.getByRole('heading',{name:'Library connected',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Connect Jellyfin',exact:true}).count(),0);
  await page.getByRole('button',{name:'Manage connections',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'Your account & Jellyfin'});
  await dialog.getByText('Home cinema',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Google linked',exact:true}).waitFor();
  assert.ok(await dialog.getByRole('button',{name:'Google linked',exact:true}).isDisabled());
  await dialog.getByRole('button',{name:'Link GitHub',exact:true}).click();
  await dialog.getByRole('button',{name:'GitHub linked',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.authCalls),[['github.com',{link:true}]]);
  await page.keyboard.press('Escape');
  for (const [width,height] of [[1440,900],[1280,650],[390,844],[375,667]]) {
    await page.setViewportSize({width,height});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), `No overflow at ${width}`);
    await page.screenshot({path:`/tmp/samerow-account-${width}.png`});
  }
  await page.evaluate(()=>window.renderAccount('owner-b'));
  await page.getByRole('button',{name:'Connect Jellyfin',exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Library connected',exact:true}).count(),0);
  await page.evaluate(()=>window.renderAccount(null));
  await page.getByRole('button',{name:'Continue with GitHub',exact:true}).click();
  assert.deepEqual((await page.evaluate(()=>window.authCalls)).at(-1),['github.com',{link:false}]);
  await page.getByRole('button',{name:'Continue with Google',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS account connector discovery, linked state, GitHub sign-in/link actions, account isolation and responsive dashboard');
} finally { await browser.close(); }
