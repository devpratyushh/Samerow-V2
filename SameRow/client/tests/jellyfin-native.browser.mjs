// Real-server acceptance test: Jellyfin Web, decoded media, native controls and
// SameRow's actual Room/Socket.IO transport. No mocked player or auth responses.
// Start Vite on 5175 and the disposable Jellyfin sandbox before running this.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let chromium;
for (const modulePath of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
  try { ({ chromium } = require(modulePath)); break; } catch { /* Try the bundled browser runtime. */ }
}
assert.ok(chromium, 'Install Playwright or provide the Codex bundled runtime.');
const executablePath = process.env.BROWSER_EXECUTABLE || [
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const jellyfinUrl = process.env.JELLYFIN_URL || 'http://127.0.0.1:8096';
const sandboxDb = process.env.JELLYFIN_SANDBOX_DB || join(workspace, 'jellyfin-sandbox/data/data/jellyfin.db');
// Capture credentials directly into memory; never print the API key or password.
const credentials = process.env.JELLYFIN_TEST_API_KEY && process.env.JELLYFIN_TEST_USER_ID
  ? { token: process.env.JELLYFIN_TEST_API_KEY, userId: process.env.JELLYFIN_TEST_USER_ID }
  : JSON.parse(execFileSync('python3', ['-c', `
import json,sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro&immutable=1',uri=True)
token=c.execute('select AccessToken from ApiKeys order by Id limit 1').fetchone()
user=c.execute('select Id from Users order by InternalId limit 1').fetchone()
if not token or not user: raise SystemExit('The sandbox needs an existing API key and user.')
print(json.dumps({'token':token[0],'userId':user[0].replace('-','')}))
`, sandboxDb], { encoding: 'utf8' }));
const dataDir = await mkdtemp(join(tmpdir(), 'samerow-native-accounts-'));
process.env.SAMEROW_DATA_DIR = dataDir;
const { default: backend } = await import('../../server/index.js');
await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
const server = `http://127.0.0.1:${backend.server.address().port}`;
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5175';
const browser = await chromium.launch({ headless: true, executablePath, args: process.env.JELLYFIN_TEST_AUTOPLAY === 'blocked' ? [] : ['--autoplay-policy=no-user-gesture-required'] });
const contexts = [], pages = [], errors = [], failedRequests = [], consoleErrors = [], playerConfigs = [];
const redact = value => String(value).replace(/[a-f0-9]{32,64}/gi, '[redacted]');
let rememberedToken;
const frameElement = page => page.locator('iframe.jellyfin-native-frame');
const diagnostic = frame => frame.evaluate(() => window.__sameRowNativeDiagnostics?.state);
const commandCount = page => page.evaluate(() => window.socketEmissions.filter(event => event.name === 'jellyfin-command').length);
const addViewer = async name => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  context.on('response', response => { if (response.status() >= 400 && response.url().includes('jellyfin')) failedRequests.push(redact(`${response.status()} ${response.url()}`)); });
  const page = await context.newPage(); pages.push(page);
  page.on('pageerror', error => errors.push(error.message.replace(/[a-f0-9]{48,64}/gi, '[redacted]')));
  page.on('console', message => { if (message.type() === 'error' || message.text().includes('SameRowBridge')) consoleErrors.push(redact(message.text()).slice(0, 500)); });
  page.on('response', response => { if (response.url().includes('/web/config.json')) response.json().then(value => playerConfigs.push(value.plugins)).catch(() => {}); });
  await page.goto(`${base}/tests/room-integration.html?server=${encodeURIComponent(server)}&name=${encodeURIComponent(name)}&motion=1`);
  await page.waitForFunction(() => window.socketEmissions.some(event => event.name === 'join-room'));
  await page.evaluate(() => window.completeMediaPermission());
  return page;
};
const shareDialog = async page => {
  await page.getByRole('button', { name: 'Share something', exact: true }).click();
  await page.getByRole('button', { name: /Your Jellyfin library/ }).click();
  return page.getByRole('dialog', { name: 'Your Jellyfin library', exact: true });
};
const nativeFrame = async page => {
  await frameElement(page).waitFor({ timeout: 30000 });
  const frame = await (await frameElement(page).elementHandle()).contentFrame();
  assert.ok(frame, 'The embedded Jellyfin player is attached.');
  return frame;
};
const waitPlaying = async frame => frame.waitForFunction(() => {
  const video = document.querySelector('video');
  return window.__sameRowNativeDiagnostics?.state.started && video && video.readyState >= 3 && !video.paused && video.currentTime > 0.1 && video.getVideoPlaybackQuality().totalVideoFrames > 0;
}, null, { timeout: 60000 });
const reveal = async (page, frame) => {
  const box = await frameElement(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.move(box.x + box.width * 0.5 + 15, box.y + box.height * 0.5 + 15);
  await frame.locator('.btnPause').waitFor({ state: 'visible' });
};
const approve = async code => {
  const response = await fetch(`${jellyfinUrl}/QuickConnect/Authorize?${new URLSearchParams({ code: code.trim(), userId: credentials.userId })}`, {
    method: 'POST', headers: { Authorization: `MediaBrowser Token="${credentials.token}"` },
  });
  assert.ok(response.ok, `The sandbox accepted Quick Connect approval (${response.status}).`);
};

try {
  const host = await addViewer('Host');
  const guest = await addViewer('Guest');
  let dialog = await shareDialog(host);
  await dialog.getByLabel('Server address', { exact: true }).fill(jellyfinUrl);
  await dialog.getByLabel('Username', { exact: true }).fill('samerow-nonexistent-user');
  await dialog.getByLabel('Password', { exact: true }).fill('invalid-password');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await frameElement(host).count(), 0, 'Invalid sign-in never starts playback.');
  await dialog.getByRole('button', { name: 'Use Quick Connect', exact: true }).click();
  const code = dialog.getByLabel('Quick Connect code', { exact: true });
  await code.waitFor();
  await approve(await code.textContent());
  console.log('Approved Quick Connect');
  await dialog.getByLabel('Search your library', { exact: true }).waitFor({ timeout: 20000 });
  const stored = await host.evaluate(() => localStorage.getItem('samerow.jellyfin.connection'));
  assert.ok(stored, 'Successful Quick Connect is remembered.');
  rememberedToken = stored;
  assert.ok(!JSON.stringify(stored).includes(credentials.token), 'The browser never receives the upstream API key.');
  const search = dialog.getByLabel('Search your library', { exact: true });
  await search.fill('Multitrack Test');
  await dialog.getByRole('button', { name: /^Watch Multitrack Test/ }).waitFor();
  await host.keyboard.press('Escape');
  await host.reload();
  await host.waitForFunction(() => window.socketEmissions.some(event => event.name === 'join-room'));
  await host.evaluate(() => window.completeMediaPermission());
  dialog = await shareDialog(host);
  await dialog.getByLabel('Search your library', { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('Password', { exact: true }).count(), 0, 'A remembered connection opens the library after reload.');
  await dialog.getByLabel('Search your library', { exact: true }).fill('Multitrack Test');
  await dialog.getByRole('button', { name: /^Watch Multitrack Test/ }).click();
  console.log('Started native open');
  const hostFrame = await nativeFrame(host), guestFrame = await nativeFrame(guest);
  await Promise.all([waitPlaying(hostFrame), waitPlaying(guestFrame)]);
  assert.equal(await host.locator('.player-controls').count(), 0, 'Jellyfin playback uses native Jellyfin controls.');
  assert.equal(await guest.evaluate(() => localStorage.getItem('samerow.jellyfin.connection')), null, 'A room guest can watch without logging into the host account.');
  assert.equal(await frameElement(host).getAttribute('title'), 'Jellyfin player');
  const sandbox = await frameElement(host).getAttribute('sandbox');
  assert.ok(sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin'), 'The native player has an opaque sandbox origin.');
  console.log('PASS invalid sign-in, real Quick Connect, remembered library search, and two decoded native Jellyfin players');

  await reveal(guest, guestFrame);
  await guestFrame.locator('.btnPause').click();
  await hostFrame.waitForFunction(() => window.__sameRowNativeDiagnostics.state.paused);
  await guestFrame.waitForFunction(() => window.__sameRowNativeDiagnostics.state.paused);
  const slider = guestFrame.locator('.osdPositionSlider');
  const sliderBox = await slider.boundingBox();
  await slider.click({ position: { x: sliderBox.width * 0.3, y: sliderBox.height / 2 } });
  await hostFrame.waitForFunction(() => { const s = window.__sameRowNativeDiagnostics.state; return s.paused && s.time > 70 && s.time < 110; });
  await guestFrame.waitForFunction(() => { const s = window.__sameRowNativeDiagnostics.state; return s.paused && s.time > 70 && s.time < 110; });
  await guestFrame.locator('.btnPause').click();
  if (process.env.NATIVE_TEST_DEBUG) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('Plugin check', await hostFrame.evaluate(async () => ({ bridge: typeof window.SameRowBridge, plugins: (await (await fetch('./config.json')).json()).plugins })));
    console.log('Browser config requests', playerConfigs); console.log('Browser console', consoleErrors.slice(-25));
  }
  await Promise.all([waitPlaying(hostFrame), waitPlaying(guestFrame)]);
  console.log('PASS guest native pause, seek and play synchronize both viewers');

  const hostBeforeTracks = await diagnostic(hostFrame);
  const commandsBeforeTracks = await commandCount(guest);
  await reveal(guest, guestFrame);
  await guestFrame.locator('.btnAudio').click();
  await guestFrame.getByRole('button', { name: /Spanish/i }).click();
  await guestFrame.waitForFunction(() => window.__sameRowNativeDiagnostics.state.audioIndex === 2);
  await waitPlaying(guestFrame);
  await reveal(guest, guestFrame);
  await guestFrame.locator('.btnSubtitles').click();
  await guestFrame.getByRole('button', { name: /Spanish/i }).click();
  await guestFrame.waitForFunction(() => window.__sameRowNativeDiagnostics.state.subtitleIndex === 4);
  await waitPlaying(guestFrame);
  const hostAfterTracks = await diagnostic(hostFrame);
  assert.equal(hostAfterTracks.audioIndex, hostBeforeTracks.audioIndex, 'Audio changes remain local.');
  assert.equal(hostAfterTracks.subtitleIndex, hostBeforeTracks.subtitleIndex, 'Subtitle changes remain local.');
  assert.equal(await commandCount(guest), commandsBeforeTracks, 'Native track changes do not emit room playback commands.');
  console.log('PASS native audio and subtitles remain independent for each viewer');

  const qualityCommands = await commandCount(guest);
  const qualityHostState = await diagnostic(hostFrame);
  await guest.locator('.jellyfin-native-quality summary').click();
  await guest.getByLabel('Quality on this device', { exact: true }).selectOption('original');
  await guestFrame.waitForFunction(() => window.__sameRowNativeDiagnostics.state.qualityMode === 'original');
  await waitPlaying(guestFrame);
  assert.equal((await diagnostic(hostFrame)).qualityMode, 'auto');
  const originalPolicy = await guestFrame.evaluate(async () => (await fetch(window.__SAMEROW_JELLYFIN__.serverAddress + '/samerow/quality')).json());
  const decodedHeight = await guestFrame.evaluate(() => document.querySelector('video').videoHeight);
  assert.equal(decodedHeight, originalPolicy.source.height, 'Original decodes at the source resolution');
  assert.equal((await diagnostic(guestFrame)).audioIndex, 2);
  assert.equal((await diagnostic(guestFrame)).subtitleIndex, 4);
  assert.equal((await diagnostic(hostFrame)).revision, qualityHostState.revision);
  assert.equal(await commandCount(guest), qualityCommands);
  await guest.getByLabel('Quality on this device', { exact: true }).selectOption('auto');
  await guestFrame.waitForFunction(() => window.__sameRowNativeDiagnostics.state.qualityMode === 'auto');
  await waitPlaying(guestFrame);
  await guest.locator('.jellyfin-native-quality summary').click();
  console.log('PASS Auto/Original changes preserve personal tracks and the shared timeline');

  const originalSource = await frameElement(host).getAttribute('src');
  const third = await addViewer('Late viewer');
  const thirdFrame = await nativeFrame(third);
  await waitPlaying(thirdFrame);
  assert.equal(await frameElement(host).getAttribute('src'), originalSource, 'A late viewer does not restart the existing player.');
  await host.waitForTimeout(3500);
  const states = await Promise.all([hostFrame, guestFrame, thirdFrame].map(diagnostic));
  assert.ok(Math.max(...states.map(s => s.time)) - Math.min(...states.map(s => s.time)) < 2, 'All three viewers converge after a late join.');
  console.log('PASS late join catches up without replacing active native players');
  await guest.getByRole('button', { name: 'Everyone', exact: true }).click();
  await guestFrame.waitForFunction(() => document.querySelector('video').muted);
  await guest.getByRole('button', { name: 'Jellyfin', exact: true }).click();
  await guestFrame.waitForFunction(() => !document.querySelector('video').muted);
  const oldThirdSource = await frameElement(third).getAttribute('src');
  await third.evaluate(() => { window.fixtureSocket.disconnect(); window.fixtureSocket.connect(); });
  await third.waitForFunction(old => document.querySelector('.jellyfin-native-frame')?.src !== old, oldThirdSource);
  const reconnectedFrame = await nativeFrame(third); await waitPlaying(reconnectedFrame);
  assert.equal(await frameElement(host).getAttribute('src'), originalSource);
  console.log('PASS source focus mutes locally and reconnect restores playback with fresh scoped access');

  await reveal(guest, guestFrame);
  await guestFrame.locator('.btnFullscreen').click();
  await guest.waitForFunction(() => document.querySelector('.room-shell').classList.contains('is-fullscreen'));
  await reveal(guest, guestFrame);
  await guestFrame.locator('.btnFullscreen').click();
  await guest.waitForFunction(() => !document.querySelector('.room-shell').classList.contains('is-fullscreen'));
  await guest.locator('.jellyfin-native-quality summary').click();
  for (const width of [390, 768, 1440]) {
    await guest.setViewportSize({ width, height: 900 });
    const bounds = await frameElement(guest).boundingBox();
    const menu = await guest.locator('.jellyfin-native-quality').boundingBox();
    assert.ok(menu.x >= -1 && menu.x + menu.width <= width + 1, `Quality selector fits ${width}px.`);
    assert.ok(bounds.width > 0 && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `Native frame fits ${width}px.`);
  }
  assert.equal(await guest.locator('.room-shell').count(), 1, 'Only one room layout is mounted.');
  await guest.waitForTimeout(350);
  await guest.screenshot({ path: process.env.JELLYFIN_SCREENSHOT || '/tmp/samerow-jellyfin-native.png' });
  await guest.locator('.jellyfin-native-quality summary').click();
  console.log('PASS native fullscreen preserves the room layout and frame fits mobile/tablet/desktop');

  const gateway = await hostFrame.evaluate(() => window.__SAMEROW_JELLYFIN__.serverAddress);
  for (const path of ['/Users', '/System/Configuration', '/Items/another-movie']) {
    const result = await fetch(`${gateway}${path}`);
    assert.ok([401, 403, 404].includes(result.status), 'A viewer cannot browse privileged or unrelated Jellyfin APIs.');
  }
  const restrictedLibrary = await (await fetch(`${gateway}/Items?Recursive=true`)).json();
  assert.deepEqual(restrictedLibrary.Items, [], 'A viewer receives no library entries outside the selected item.');
  // Trusted local playback UI can control the room; arbitrary parent messages cannot.
  const beforeForged = await commandCount(host);
  await host.evaluate(() => window.postMessage({ source: 'samerow-jellyfin', type: 'command', action: 'stop', channel: 'forged' }, '*'));
  await host.waitForTimeout(350);
  assert.equal(await commandCount(host), beforeForged);
  assert.equal(await frameElement(host).count(), 1);
  console.log('PASS gateway API restrictions and forged bridge-message rejection');

  await guest.getByRole('button', { name: 'Stop movie for everyone', exact: true }).click();
  await Promise.all(pages.map(page => frameElement(page).waitFor({ state: 'detached' })));
  assert.ok([401, 403, 404, 410].includes((await fetch(`${gateway}/System/Info/Public`)).status), 'Stopping the room revokes the old viewer gateway.');
  assert.deepEqual(errors, [], 'No browser page errors.');
  console.log('PASS shared stop removes every native player and revokes its gateway');
} catch (error) {
  // Keep failures reviewable without leaking room gateway or account tokens.
  for (const [index, page] of pages.entries()) {
    const frame = await frameElement(page).elementHandle({timeout:1000}).then(handle => handle?.contentFrame()).catch(() => null);
    console.error(`Viewer ${index + 1}:`, frame ? await diagnostic(frame).catch(() => 'frame unavailable') : 'no native frame');
  }
  console.error('Browser errors:', errors);
  console.error('Failed requests:', failedRequests.slice(-30));
  console.error('Player configs:', playerConfigs);
  console.error('Console errors:', consoleErrors.slice(-25));
  for (const [index, page] of pages.entries()) { await page.screenshot({path:`/tmp/samerow-native-failure-${index}.png`}).catch(()=>{}); const frame=await frameElement(page).elementHandle({timeout:1000}).then(h=>h?.contentFrame()).catch(()=>null); if(frame) console.error('Frame text', redact((await frame.locator('body').innerText().catch(()=>'' )).slice(0,2500))); }
  throw error;
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await browser.close();
  if (rememberedToken) await fetch(`${server}/api/jellyfin/logout`, { method: 'POST', headers: { Authorization: `Bearer ${rememberedToken}` } }).catch(() => {});
  await new Promise(resolve => backend.io.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
