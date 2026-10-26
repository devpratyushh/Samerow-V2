// Requires a real LiveKit server (for local verification: livekit --dev).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
for (const name of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
  try { ({ chromium } = require(name)); break; } catch { /* Optional browser runtime. */ }
}
assert.ok(chromium, 'Install Playwright or use the bundled browser runtime.');
const { configuration } = require('../../server/config');
const { createApplication } = require('../../server/application');
const config = configuration({ MEDIA_MODE: 'livekit', LIVEKIT_URL: process.env.LIVEKIT_TEST_URL || 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: process.env.LIVEKIT_TEST_API_KEY || 'devkey', LIVEKIT_API_SECRET: process.env.LIVEKIT_TEST_API_SECRET || 'secret' });
const backend = createApplication({ config }); await backend.ready;
await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${backend.server.address().port}`;
const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'].find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const pages = [], contexts = [], errors = [];
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5175';
const remoteVideo = page => page.locator('.media-tile:not([data-self]) video').first();
try {
  for (const name of ['Host', 'Guest']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); contexts.push(context);
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/tests/room-integration.html?server=${encodeURIComponent(address)}&name=${name}&motion=1&audio=1`);
    await page.waitForFunction(() => window.fixtureSocket.roomConfig?.mediaMode === 'livekit');
    await page.evaluate(() => window.completeMediaPermission());
  }
  const [host, guest] = pages;
  for (const page of pages) {
    await remoteVideo(page).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.media-tile:not([data-self]) video')].some(video => video.readyState >= 2 && video.getVideoPlaybackQuality().totalVideoFrames > 3), null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.socketEmissions.filter(value => value.name === 'signal').length), 0);
  }
  console.log('PASS two browsers decode remote video through the real LiveKit SFU without mesh signaling');
  const hostId = await host.evaluate(() => window.fixtureSocket.id);
  await host.getByRole('button', { name: 'Turn camera off', exact: true }).click();
  await guest.waitForFunction(id => document.querySelector(`[data-participant="${id}"] video`)?.classList.contains('camera-off'), hostId);
  await host.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await guest.waitForFunction(id => !document.querySelector(`[data-participant="${id}"] video`)?.classList.contains('camera-off'), hostId);
  await host.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await guest.locator(`[data-participant="${hostId}"] [aria-label="Microphone muted"]`).waitFor();
  await host.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await guest.locator(`[data-participant="${hostId}"] [aria-label="Microphone muted"]`).waitFor({ state: 'detached' });
  assert.ok(await guest.locator(`[data-participant="${hostId}"] video`).evaluate(video => video.srcObject.getAudioTracks().some(track => track.readyState === 'live')));
  console.log('PASS camera and microphone mute/unmute update remote track state');
  await host.getByRole('button', { name: 'Share something', exact: true }).click();
  await host.getByRole('button', { name: 'Your screen Share a tab, an app, or your desktop.' }).click();
  await guest.locator('.media-tile--screen').waitFor({ timeout: 20000 });
  await host.getByRole('button', { name: 'Stop sharing', exact: true }).click();
  await guest.locator('.media-tile--screen').waitFor({ state: 'detached', timeout: 20000 });
  console.log('PASS screen tracks publish and unpublish through the SFU');
  await host.evaluate(() => { window.oldSocketId = window.fixtureSocket.id; window.fixtureSocket.disconnect(); window.fixtureSocket.connect(); });
  await host.waitForFunction(() => window.fixtureSocket.id !== undefined && window.fixtureSocket.id !== window.oldSocketId);
  await host.waitForFunction(() => [...document.querySelectorAll('.media-tile:not([data-self]) video')].some(video => video.readyState >= 2 && video.getVideoPlaybackQuality().totalVideoFrames > 3), null, { timeout: 30000 });
  assert.ok(await host.evaluate(() => document.querySelector('[data-self] video').srcObject.getVideoTracks()[0].readyState === 'live'));
  await guest.waitForFunction(oldId => !document.querySelector(`[data-participant="${oldId}"]`), hostId);
  const newId = await host.evaluate(() => window.fixtureSocket.id);
  await guest.waitForFunction(id => document.querySelector(`[data-participant="${id}"] video`)?.readyState >= 2, newId, { timeout: 30000 });
  console.log('PASS Socket.IO reconnect creates a new scoped SFU session, keeps capture alive and restores remote video');
  assert.deepEqual(errors, []);
} catch (error) {
  for (const [index, page] of pages.entries()) {
    console.error(`Viewer ${index}:`, (await page.locator('body').innerText()).slice(-1200));
    await page.screenshot({ path: `/tmp/samerow-group-call-failure-${index}.png` });
  }
  throw error;
} finally {
  await Promise.all(contexts.map(context => context.close())); await browser.close(); await backend.close();
}
