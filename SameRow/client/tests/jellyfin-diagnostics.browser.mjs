import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
for (const name of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
  try { ({ chromium } = require(name)); break; } catch { /* Optional local runtime. */ }
}
assert.ok(chromium, 'Install Playwright to run browser checks');
const executablePath = process.env.BROWSER_EXECUTABLE || ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  // Exercise Hls.js consistently even on browsers advertising native HLS.
  await page.addInitScript(() => {
    const native = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) { return type.includes('mpegurl') ? '' : native.call(this, type); };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let requests = 0;
  await page.route('**/quality', route => {
    requests++;
    return requests === 1 ? route.fulfill({ status: 403, body: 'Join the room' }) : route.fulfill({ json: { mode: 'auto', maxBitrate: 4000000, revision: 0, source: { height: 1080 } } });
  });
  await page.route('**/stream.m3u8?**', route => route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6,\n/diagnostics-segment.ts\n#EXT-X-ENDLIST\n' }));
  await page.route('**/diagnostics-segment.ts', route => route.fulfill({ status: 503, body: 'upstream unavailable' }));
  await page.goto(`${process.env.UI_BASE_URL || 'http://127.0.0.1:5175'}/tests/jellyfin-diagnostics.html`);
  const retry = page.getByRole('button', { name: 'Retry playback settings', exact: true });
  await retry.waitFor();
  assert.match(await page.locator('.jellyfin-player-status').innerText(), /HTTP 403/);
  await retry.click();
  await page.locator('.jellyfin-playback-details summary').click();
  await page.waitForFunction(() => document.querySelector('.jellyfin-playback-details').innerText.includes('fragLoadError · HTTP 503'), null, { timeout: 15000 }).catch(async error => { console.log(await page.locator('body').innerText(), errors); throw error; });
  const text = await page.locator('.jellyfin-player-status').innerText();
  assert.match(text, /Downloading media segment/);
  assert.match(text, /No media metadata/);
  assert.match(text, /1080p/);
  assert.doesNotMatch(text, /diagnostics-test-secret|Preparing the stream|transcoding/i);
  await page.waitForFunction(() => /[1-9]\d*s elapsed/.test(document.querySelector('.jellyfin-player-status').innerText));
  await page.locator('.player-nerd-stats > summary').click();
  await page.getByText('HLS bandwidth estimate', { exact: true }).waitFor();
  await page.evaluate(() => {
    const video = document.querySelector('.jellyfin-player video');
    Object.defineProperties(video, {
      videoWidth: { configurable: true, get: () => 1920 }, videoHeight: { configurable: true, get: () => 1080 },
      getVideoPlaybackQuality: { configurable: true, value: () => ({ totalVideoFrames: 240, droppedVideoFrames: 2 }) },
      buffered: { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 12 }) },
    });
  });
  await page.waitForFunction(() => document.querySelector('.player-nerd-stats').innerText.includes('1920 × 1080'));
  const statsText = await page.locator('.player-nerd-stats').innerText();
  assert.match(statsText, /2 \/ 240/);
  assert.match(statsText, /12.0 s/);
  assert.match(statsText, /fragLoadError · HTTP 503/);
  assert.doesNotMatch(statsText, /diagnostics-test-secret/);
  const footer = await page.locator('.player-nerd-stats').boundingBox();
  const controls = await page.locator('.player-controls').boundingBox();
  assert.ok(footer.y >= controls.y + controls.height - 1, 'Stats stay below playback controls');
  if (process.env.UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.UI_ARTIFACT_DIR}/player-stats-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator('.jellyfin-playback-details').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
  const statsBounds = await page.locator('.player-nerd-stats').boundingBox();
  assert.ok(statsBounds.x >= 0 && statsBounds.x + statsBounds.width <= 391 && statsBounds.y + statsBounds.height <= 845);
  if (process.env.UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.UI_ARTIFACT_DIR}/player-stats-mobile.png` });
  await page.locator('.player-nerd-stats > summary').click();
  await page.getByText('HLS bandwidth estimate', { exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  const stalled = await browser.newPage();
  await stalled.clock.install();
  await stalled.route('**/quality', () => {});
  await stalled.goto(`${process.env.UI_BASE_URL || 'http://127.0.0.1:5175'}/tests/jellyfin-diagnostics.html`);
  await stalled.getByText('Requesting playback settings…', { exact: true }).waitFor();
  await stalled.clock.runFor(10100);
  await stalled.getByRole('button', { name: 'Retry playback settings' }).waitFor();
  assert.match(await stalled.locator('.jellyfin-player-status').innerText(), /request timed out after 10 seconds/);
  await stalled.close();
  console.log('PASS settings HTTP failure, timeout and retry; real HLS segment/HTTP diagnostics; elapsed time; live bottom-of-player stats; mobile layout; no credential exposure.');
} finally { await browser.close(); }
