import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageDirectory = process.env.BROWSER_PACKAGE_DIR;
const candidates = [
  ...(packageDirectory ? [path.join(packageDirectory, 'playwright'), packageDirectory] : []),
  'playwright',
  '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
];
let chromium;
for (const candidate of candidates) {
  try { ({ chromium } = require(candidate)); if (chromium) break; } catch { /* Try the next configured runtime. */ }
}
assert.ok(chromium, 'Install Playwright or set BROWSER_PACKAGE_DIR to its package directory.');

const executablePath = process.env.BROWSER_EXECUTABLE || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((candidate) => existsSync(candidate));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const baseUrl = process.env.UI_BASE_URL || 'http://127.0.0.1:5175';
const check = (name) => console.log(`PASS ${name}`);
const chatToggle = page.locator('.chat-toggle:visible');
const openChat = async () => { await page.mouse.move(200, 1); await chatToggle.click(); };
const composer = page.locator('#room-chat-message:visible');
const chatDialog = page.getByRole('dialog', { name: 'Room chat', exact: true });
const waitForLayout = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const noHorizontalOverflow = async () => {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, `Page overflows horizontally: ${JSON.stringify(dimensions)}`);
};

try {
  await page.goto(`${baseUrl}/ui-preview`, { waitUntil: 'networkidle' });
  await page.locator('.room-shell').waitFor({ state: 'visible' });
  if (!await page.locator('.sr-chat-container').isVisible()) await openChat();
  await composer.waitFor({ state: 'visible' });
  const dock = await page.locator('.sr-chat-container').boundingBox();
  const canvas = await page.locator('.room-canvas').boundingBox();
  const toolbar = await page.locator('.room-toolbar').boundingBox();
  assert.ok(dock.width >= 320 && dock.width <= 360, `Unexpected dock width: ${dock.width}`);
  assert.ok(canvas.x + canvas.width <= dock.x + 1, 'Chat overlaps the main stage.');
  assert.ok(dock.y + dock.height <= toolbar.y + 1, 'Chat overlaps the call toolbar.');
  await noHorizontalOverflow();
  check('desktop chat docks beside content and above the toolbar');

  const draft = 'Keep this draft while changing the view';
  await composer.fill(draft);
  await page.locator('.sr-chat-close').click();
  assert.ok(await page.locator('.sr-chat-container').isHidden());
  await openChat();
  assert.equal(await composer.inputValue(), draft);
  check('draft survives close and reopen');

  await page.setViewportSize({ width: 390, height: 844 });
  await chatDialog.waitFor({ state: 'visible' });
  assert.equal(await composer.inputValue(), draft);
  assert.equal(await chatDialog.getAttribute('aria-modal'), 'true');
  await noHorizontalOverflow();
  check('draft survives desktop to compact breakpoint and chat is an accessible dialog');

  await page.keyboard.press('Escape');
  await chatDialog.waitFor({ state: 'hidden' });
  await openChat();
  await chatDialog.waitFor({ state: 'visible' });
  await waitForLayout();
  assert.equal(await composer.inputValue(), draft);
  assert.equal(await composer.evaluate((element) => document.activeElement === element), true);
  // Tabbing forward and backward must remain inside the compact panel.
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press(index < 4 ? 'Tab' : 'Shift+Tab');
    assert.equal(await chatDialog.evaluate((element) => element.contains(document.activeElement)), true);
  }
  await page.keyboard.press('Escape');
  await chatDialog.waitFor({ state: 'hidden' });
  assert.equal(await chatToggle.evaluate((element) => document.activeElement === element), true);
  check('compact dialog traps focus, closes with Escape, and restores opener focus');

  await openChat();
  await composer.fill(`LONG_MESSAGE_${'x'.repeat(1800)}`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const longBubble = page.locator('.sr-chat-bubble').filter({ hasText: 'LONG_MESSAGE_' });
  await longBubble.waitFor({ state: 'visible' });
  assert.equal(await composer.inputValue(), '');
  const bubbleBox = await longBubble.boundingBox();
  const modalBox = await chatDialog.boundingBox();
  assert.ok(bubbleBox.x >= modalBox.x && bubbleBox.x + bubbleBox.width <= modalBox.x + modalBox.width + 1, 'Long message leaves the chat bounds.');
  await noHorizontalOverflow();
  check('preview sending works and long unbroken messages wrap inside chat');

  // Emulate the visual viewport shrinking when a mobile software keyboard opens.
  await page.evaluate(() => {
    window.chatViewportOriginal = Object.getOwnPropertyDescriptor(window.visualViewport, 'height');
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 430 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await waitForLayout();
  const keyboardComposer = await composer.boundingBox();
  const keyboardDialog = await chatDialog.boundingBox();
  assert.ok(keyboardDialog.height <= 431, `Dialog did not follow keyboard viewport: ${keyboardDialog.height}`);
  assert.ok(keyboardComposer.y + keyboardComposer.height <= 431, 'Composer is behind the keyboard.');
  await page.evaluate(() => {
    if (window.chatViewportOriginal) Object.defineProperty(window.visualViewport, 'height', window.chatViewportOriginal);
    else delete window.visualViewport.height;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  check('dialog and composer remain above a reduced visual viewport');

  await composer.fill(draft);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await chatDialog.waitFor({ state: 'hidden' });
  await composer.waitFor({ state: 'visible' });
  assert.equal(await composer.inputValue(), draft);
  assert.equal(await chatDialog.count(), 0);
  check('draft survives compact to desktop breakpoint');

  await page.locator('.sr-chat-close').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await openChat();
  await chatDialog.waitFor({ state: 'visible' });
  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await waitForLayout();
    const box = await composer.boundingBox();
    assert.ok(box.y + box.height <= viewport.height + 1, `Composer leaves ${viewport.width}×${viewport.height} viewport.`);
    assert.equal(await composer.inputValue(), draft);
    await noHorizontalOverflow();
  }
  check('compact chat fits narrow portrait and short landscape viewports');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('is-watching'));
  await page.mouse.move(400, 1);
  await page.locator('.fullscreen-topbar').waitFor({state:'visible'});
  await page.locator('.fullscreen-topbar .chat-toggle').click();
  await chatDialog.waitFor({ state: 'visible' });
  assert.equal(await chatDialog.evaluate((element) => element.parentElement.parentElement === document.fullscreenElement), true);
  await page.keyboard.press('Escape');
  await chatDialog.waitFor({ state: 'hidden' });
  await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
  check('compact dialog remains inside the room fullscreen element');

  assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join('\n')}`);
  console.log('Chat UI browser checks passed.');
} finally {
  await browser.close();
}
