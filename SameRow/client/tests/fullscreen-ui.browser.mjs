import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
for (const candidate of [process.env.BROWSER_PACKAGE_DIR && `${process.env.BROWSER_PACKAGE_DIR}/playwright`, 'playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'].filter(Boolean)) {
  try { ({ chromium } = require(candidate)); break; } catch { /* Optional local browser runtime. */ }
}
assert.ok(chromium, 'Install Playwright or set BROWSER_PACKAGE_DIR.');
const executablePath = process.env.BROWSER_EXECUTABLE || ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5175';
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const panel = page.locator('.floating-participants');
const layout = page.getByRole('combobox', { name: 'Fullscreen participant layout' });
const handle = page.getByRole('button', { name: 'Move participant panel' });
const fits = async () => {
  await settle();
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box.x >= 17 && box.y >= 17 && box.x + box.width <= viewport.width - 17 && box.y + box.height <= viewport.height - 17, `Panel escaped viewport: ${JSON.stringify({box, viewport})}`);
};
try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/ui-preview?scene=youtube&count=8`);
  await page.locator('.participant-grid video').first().waitFor({state: 'attached'});
  await page.evaluate(() => { window.originalVideos = [...document.querySelectorAll('.participant-grid video')]; });
  await page.getByRole('button', {name: 'Enter fullscreen', exact: true}).click();
  await panel.waitFor();
  const controls = page.getByRole('group', { name: 'Preview video playback controls' });
  const hitArea = page.locator('.source-pane:not([hidden]) .playback-hit-area');
  await page.mouse.move(720, 460);
  await controls.locator('xpath=self::*[contains(@class,"is-hidden")]').waitFor();
  await page.mouse.move(730, 470);
  await page.waitForFunction(() => {
    const bar = document.querySelector('.source-pane:not([hidden]) .player-controls');
    return !bar.classList.contains('is-hidden') && getComputedStyle(bar).opacity === '1';
  });
  const playbackTouch = await page.context().newCDPSession(page);
  for (const hidden of [true, false]) {
    await playbackTouch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 730, y: 470 }] });
    await playbackTouch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await controls.evaluate(el => el.classList.contains('is-hidden')), hidden);
    assert.ok(await controls.getByRole('button', { name: 'Pause preview video', exact: true }).count());
  }
  for (const viewport of [{width: 1920,height: 1080}, {width: 320,height: 700}, {width: 844,height: 390}]) {
    await page.setViewportSize(viewport);
    await hitArea.dispatchEvent('pointermove', { pointerType: 'mouse' });
    await settle();
    const box = await controls.boundingBox();
    const row = controls.locator('.player-controls-row');
    assert.ok(box.width <= 961 && box.x >= 10 && box.x + box.width <= viewport.width - 10);
    assert.ok(Math.abs(box.x - (viewport.width - box.x - box.width)) < 2, 'Playback bar is centered');
    assert.ok(await row.evaluate(el => el.scrollWidth <= el.clientWidth), 'Playback controls fit their bar');
  }
  await page.setViewportSize({width: 1440,height: 900});
  assert.ok(await panel.evaluate(el => el.classList.contains('floating-participants--strip')));
  for (const mode of ['strip', 'vertical', 'circles']) {
    await layout.selectOption(mode);
    await fits();
    const before = await panel.boundingBox();
    const grip = await handle.boundingBox();
    await page.mouse.move(grip.x + 15, grip.y + 15);
    await page.mouse.down();
    await page.mouse.move(grip.x + 250, grip.y + 200, {steps: 8});
    await page.mouse.up();
    const after = await panel.boundingBox();
    assert.ok(after.x > before.x + 10 && after.y > before.y + 10, `${mode} did not drag`);
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    assert.ok((await panel.boundingBox()).x < after.x);
    await page.mouse.move((await handle.boundingBox()).x + 15, (await handle.boundingBox()).y + 15);
    await page.mouse.down();
    await page.mouse.move(3000, 3000, {steps: 5});
    await page.mouse.up();
    await fits();
    await page.setViewportSize({width: 390, height: 844});
    await fits();
    await page.setViewportSize({width: 844, height: 390});
    await fits();
    await page.setViewportSize({width: 1440, height: 900});
    // Reset to the top left for the next layout's movement checks.
    await handle.focus();
    for (let i = 0; i < 40; i++) await page.keyboard.press('Shift+ArrowLeft');
    for (let i = 0; i < 25; i++) await page.keyboard.press('Shift+ArrowUp');
  }
  assert.ok(await page.evaluate(() => window.originalVideos.every((node, i) => node === document.querySelectorAll('.participant-grid video')[i])));
  await page.screenshot({path: '/tmp/samerow-fullscreen-circles.png'});
  await layout.selectOption('strip');
  await page.screenshot({path: '/tmp/samerow-fullscreen-strip.png'});
  await page.keyboard.press('Escape');
  // Exercise the browser fallback and touch pointer capture independently.
  await page.goto(`${base}/ui-preview?scene=screen&count=4`);
  await page.locator('.room-shell').waitFor();
  await page.evaluate(() => { document.querySelector('.room-shell').requestFullscreen = () => Promise.reject(new Error('Unavailable')); });
  await page.getByRole('button', {name: 'Enter fullscreen', exact: true}).click();
  await page.locator('.is-theater .floating-participants').waitFor();
  await fits();
  const touch = await page.context().newCDPSession(page);
  const grip = await handle.boundingBox();
  const before = await panel.boundingBox();
  await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: grip.x + 15, y: grip.y + 15}]});
  await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: grip.x + 180, y: grip.y + 160}]});
  await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await settle();
  const after = await panel.boundingBox();
  assert.ok(after.x > before.x && after.y > before.y, 'Touch drag did not move panel');
  await page.keyboard.press('Escape');
  await page.locator('.floating-participants').waitFor({state: 'detached'});
  assert.deepEqual(errors, []);
  console.log('PASS fullscreen layouts, mouse/touch/keyboard movement, viewport bounds, stable video nodes, and theater fallback');
} finally { await browser.close(); }
