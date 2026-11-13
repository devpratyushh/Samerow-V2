// Real peer-mesh RTP counters and the stats dialog, using generated camera tracks.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
for (const path of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
  try { ({ chromium } = require(path)); break; } catch { /* Runtime fallback. */ }
}
const { createApplication } = require('../../server/application');
const backend = createApplication(); await backend.ready;
await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${backend.server.address().port}`;
const executablePath = ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [], contexts = [], pages = [];
try {
  for (const name of ['Alice', 'Bob']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); contexts.push(context);
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${process.env.UI_BASE_URL || 'http://127.0.0.1:5175'}/tests/room-integration.html?server=${encodeURIComponent(address)}&name=${name}&motion=1&audio=1`);
    await page.waitForFunction(() => window.fixtureSocket.roomConfig?.mediaMode === 'mesh');
    await page.evaluate(() => window.completeMediaPermission());
  }
  for (const page of pages) await page.waitForFunction(() => [...document.querySelectorAll('.media-tile:not([data-self]) video')].some(video => video.videoWidth > 0), null, { timeout: 30000 });
  const page = pages[0];
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('button', { name: 'Stats for nerds', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stats for nerds' });
  await dialog.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.nerd-stats tbody tr')].some(row => row.textContent.includes('Receiving') && row.textContent.includes('Mbps')), null, { timeout: 20000 });
  assert.match(await dialog.innerText(), /Bob/);
  assert.match(await dialog.innerText(), /Sending/);
  assert.match(await dialog.innerText(), /video\/VP8|video\/H264|video\/VP9|video\/AV1/i);
  await page.getByLabel('Call quality on this device').selectOption('high');
  assert.equal(await page.getByLabel('Call quality on this device').inputValue(), 'high');
  await page.screenshot({ path: '/tmp/samerow-nerd-stats-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await dialog.isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: '/tmp/samerow-nerd-stats-mobile.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.nerd-stats').count(), 0, 'Closing diagnostics stops its polling component');
  assert.deepEqual(errors, []);
  console.log('PASS real mesh upload/download, RTP codec, LAN quality control, responsive stats dialog and cleanup');
} finally {
  await Promise.all(contexts.map(context => context.close())); await browser.close(); await backend.close();
}
