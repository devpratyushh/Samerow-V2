// Run Vite first, then: UI_BASE_URL=http://127.0.0.1:5175 node tests/media-ui.browser.mjs
// These deterministic browser checks mock transport/media APIs; they do not verify codec decoding.
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
  try { ({ chromium } = require(candidate)); if (chromium) break; } catch { /* Try the configured runtime. */ }
}
assert.ok(chromium, 'Install Playwright or set BROWSER_PACKAGE_DIR to its package directory.');
const executablePath = process.env.BROWSER_EXECUTABLE || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(candidate => existsSync(candidate));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const baseUrl = process.env.UI_BASE_URL || 'http://127.0.0.1:5175';
const errors = [];
const check = name => console.log(`PASS ${name}`);

function installMocks({ mode }) {
  window.engines = [];
  window.revokedUrls = [];
  window.streamRequests = [];
  window.readerReads = 0;
  window.cancelCalls = 0;
  window.releaseCalls = 0;
  window.appendedChunks = [];
  window.eofCalls = [];
  window.codecSupported = true;
  window.autoplayBlocked = false;
  window.MediaSource = class extends EventTarget {
    static isTypeSupported() { return window.codecSupported; }
    constructor() {
      super(); this.readyState = 'closed'; window.engines.push(this);
      setTimeout(() => { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }, 20);
    }
    addSourceBuffer() {
      const buffer = new EventTarget();
      this.sourceBuffer = buffer;
      buffer.updating = false;
      buffer.appendBuffer = value => {
        window.appendedChunks.push([...value]);
        buffer.updating = true;
        setTimeout(() => { buffer.updating = false; buffer.dispatchEvent(new Event('updateend')); }, 10);
      };
      buffer.remove = () => {};
      return buffer;
    }
    endOfStream() {
      if (this.readyState !== 'open' || this.sourceBuffer?.updating) throw new DOMException('The buffer is busy.', 'InvalidStateError');
      window.eofCalls.push({ appended: window.appendedChunks.map(chunk => [...chunk]), updating: this.sourceBuffer.updating });
      this.readyState = 'ended';
    }
  };
  URL.createObjectURL = () => `blob:regression-${window.engines.length}`;
  URL.revokeObjectURL = url => window.revokedUrls.push(url);
  Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get() { return this._testSrc; }, set(value) { this._testSrc = value; } });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return this._testPaused !== false; } });
  HTMLMediaElement.prototype.load = function() {};
  HTMLMediaElement.prototype.pause = function() { this._testPaused = true; this.dispatchEvent(new Event('pause')); };
  HTMLMediaElement.prototype.play = function() {
    if (window.autoplayBlocked) return Promise.reject(new DOMException('Autoplay is blocked', 'NotAllowedError'));
    this._testPaused = false;
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  };
  const realFetch = window.fetch.bind(window);
  const pendingUntilAbort = signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  });
  window.fetch = async (url, options) => {
    if (!String(url).includes('jellyfin.test')) return realFetch(url, options);
    window.streamRequests.push({ url: String(url), options });
    if (String(url).includes('/Items')) {
      if (mode === 'pending-metadata') return pendingUntilAbort(options.signal);
      if (mode === 'metadata-failure') throw new TypeError('The metadata request failed.');
      return { ok: true, json: async () => ({ Items: [{ Name: 'Test Film', RunTimeTicks: 6000000000 }] }) };
    }
    if (mode === 'pending-stream') return pendingUntilAbort(options.signal);
    if (mode === 'unauthorized') return { ok: false, status: 401 };
    let resolveRead;
    let closed = false;
    let reads = 0;
    options.signal.addEventListener('abort', () => { closed = true; resolveRead?.({ done: true }); });
    return { ok: true, body: { getReader: () => ({
      read: async () => {
        reads += 1;
        window.readerReads += 1;
        if (closed || (mode === 'finite' && reads > 1)) return { done: true };
        if (reads === 1) return { done: false, value: new Uint8Array([1, 2, 3]) };
        return new Promise(resolve => { resolveRead = resolve; window.finishStream = () => resolve({ done: true }); });
      },
      cancel: async () => { window.cancelCalls += 1; closed = true; resolveRead?.({ done: true }); },
      releaseLock: () => { window.releaseCalls += 1; },
    }) } };
  };
}

async function openFixture(mode = 'streaming') {
  const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(installMocks, { mode });
  await page.goto(`${baseUrl}/tests/media-ui.html`);
  await page.getByRole('dialog').waitFor();
  return page;
}
const closePump = page => page.getByRole('button', { name: 'Close share from jellyfin' }).click();
const mediaState = (page, state) => page.waitForFunction(expected => window.mediaEvents.at(-1)?.state === expected, state);
const pumpState = (page, state) => page.waitForFunction(expected => window.pumpEvents.at(-1)?.state === expected, state);
async function connectPump(page) {
  await page.getByPlaceholder('https://jellyfin.example.com').fill('https://jellyfin.test');
  await page.getByPlaceholder('Your Jellyfin API token').fill('test-private-token');
  await page.getByPlaceholder('Paste the video’s item ID').fill('video-1');
  await page.getByRole('button', { name: 'Share video with room' }).click();
}

try {
  let page = await openFixture();
  assert.equal(await page.evaluate(() => window.engines.length), 0, 'disabled player activated MediaSource');
  assert.equal(await page.getByPlaceholder('Your Jellyfin API token').getAttribute('type'), 'password');
  assert.equal(await page.getByPlaceholder('Your Jellyfin API token').inputValue(), '');
  assert.equal(await page.getByPlaceholder('https://jellyfin.example.com').inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Share video with room' }).isDisabled(), true);
  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Jellyfin form overflows horizontally');
  }
  await closePump(page);
  await page.evaluate(() => { window.mediaHarness.enable(); window.mediaHarness.append([4, 5, 6]); });
  await page.waitForFunction(() => window.engines.length === 1 && window.appendedChunks.length === 1);
  assert.deepEqual(await page.evaluate(() => window.appendedChunks), [[4, 5, 6]], 'pre-open chunks must be retained');
  await page.evaluate(() => { for (let index = 0; index < 5; index += 1) window.mediaHarness.revise(); window.mediaHarness.setMuted(true); });
  await page.waitForFunction(() => document.querySelector('video').muted);
  assert.equal(await page.evaluate(() => window.engines.length), 1, 'callback/focus changes recreated MediaSource');
  assert.equal(await page.locator('main').textContent(), '', 'diagnostics or a duplicate spinner are always visible');
  check('lazy initialization, pre-open append queue, stable media engine, focus muting, responsive form, empty masked credentials');

  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('waiting')));
  await mediaState(page, 'buffering');
  assert.equal(await page.evaluate(() => window.isMediaBuffering), true);
  await page.evaluate(() => { window.autoplayBlocked = true; window.mediaHarness.play(); });
  await mediaState(page, 'blocked');
  assert.equal(await page.evaluate(() => window.isMediaBuffering), false);
  await page.evaluate(() => { window.autoplayBlocked = false; window.mediaHarness.play(); });
  await mediaState(page, 'playing');
  await page.evaluate(() => window.mediaHarness.pause());
  await mediaState(page, 'paused');
  await page.evaluate(() => window.engines[0].sourceBuffer.dispatchEvent(new Event('error')));
  await mediaState(page, 'error');
  await page.evaluate(() => window.mediaHarness.retry());
  await page.waitForFunction(() => window.engines.length === 2 && window.revokedUrls.length === 1);
  await page.evaluate(() => { window.codecSupported = false; window.mediaHarness.retry(); });
  await mediaState(page, 'error');
  assert.match(await page.evaluate(() => window.mediaEvents.at(-1).message), /does not support/);
  assert.equal(await page.evaluate(() => window.engines.length), 2);
  await page.evaluate(() => window.mediaHarness.unmountPlayer());
  assert.equal(await page.evaluate(() => window.revokedUrls.length), 2);
  check('buffering/playing/paused/blocked/error states, retry cleanup, unsupported codec fallback, unmount URL cleanup');
  await page.close();

  page = await openFixture();
  await closePump(page);
  await page.evaluate(() => window.mediaHarness.enable());
  await page.waitForFunction(() => window.engines[0]?.sourceBuffer);
  await page.evaluate(() => {
    window.mediaHarness.pause();
    window.engines[0].sourceBuffer.updating = true;
    window.mediaHarness.append([9, 9, 9]);
    window.mediaHarness.disable();
  });
  await mediaState(page, 'idle');
  await page.evaluate(() => window.mediaHarness.enable());
  await page.waitForFunction(() => window.engines[1]?.sourceBuffer);
  assert.deepEqual(await page.evaluate(() => window.appendedChunks), [], 'new session reused a stale queued chunk');
  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('canplay')));
  await mediaState(page, 'playing');
  check('explicit stop discards old queued data and restores playback intent for the next movie');
  await page.close();

  page = await openFixture();
  await closePump(page);
  await page.evaluate(() => window.mediaHarness.enable());
  await page.waitForFunction(() => window.engines[0]?.sourceBuffer);
  await page.evaluate(() => {
    window.mediaHarness.play();
    window.mediaHarness.append([1]);
    window.mediaHarness.append([2]);
    window.mediaHarness.append([3]);
    window.mediaHarness.endStream();
    window.eofAtSignal = window.eofCalls.length;
  });
  assert.equal(await page.evaluate(() => window.eofAtSignal), 0, 'EOF ran while the first chunk was still being appended');
  await page.waitForFunction(() => window.eofCalls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.eofCalls), [{ appended: [[1], [2], [3]], updating: false }]);
  assert.equal(await page.evaluate(() => window.engines.length), 1, 'EOF recreated the media engine');
  assert.equal(await page.evaluate(() => window.mediaEvents.at(-1).state), 'playing', 'EOF falsely marked buffered playback ended');
  await page.evaluate(() => window.mediaHarness.endStream());
  assert.equal(await page.evaluate(() => window.eofCalls.length), 1, 'duplicate completion ended the stream twice');
  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('ended')));
  await mediaState(page, 'ended');
  check('EOF waits for queued chunks and the final updateend without ending buffered playback or recreating MediaSource');
  await page.close();

  page = await openFixture();
  await closePump(page);
  await page.evaluate(() => {
    window.mediaHarness.enable();
    window.mediaHarness.append([7, 8]);
    window.mediaHarness.endStream();
  });
  await page.waitForFunction(() => window.eofCalls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.eofCalls[0].appended), [[7, 8]]);
  check('EOF received before sourceopen waits for initialization and all queued data');
  await page.close();

  for (const reset of ['flush', 'retry', 'disable']) {
    page = await openFixture();
    await closePump(page);
    await page.evaluate(() => window.mediaHarness.enable());
    await page.waitForFunction(() => window.engines[0]?.sourceBuffer);
    await page.evaluate(method => {
      window.engines[0].sourceBuffer.updating = true;
      window.mediaHarness.append([9]);
      window.mediaHarness.endStream();
      window.mediaHarness[method]();
    }, reset);
    if (reset === 'disable') {
      await mediaState(page, 'idle');
      await page.evaluate(() => window.mediaHarness.enable());
    }
    await page.waitForFunction(() => window.engines[1]?.sourceBuffer);
    await page.evaluate(() => window.mediaHarness.append([4]));
    await page.waitForFunction(() => window.appendedChunks.length === 1 && !window.engines[1].sourceBuffer.updating);
    assert.deepEqual(await page.evaluate(() => window.appendedChunks), [[4]], `${reset} retained an old queued chunk`);
    assert.equal(await page.evaluate(() => window.eofCalls.length), 0, `${reset} retained EOF from the old session`);
    await page.close();
  }
  check('flush, retry, and disable discard pending EOF before starting another stream');

  page = await openFixture();
  await page.evaluate(() => {
    window.handleMediaChunk = async (chunk, { signal }) => {
      window.handlerSignal = signal;
      window.deliveredChunks.push([...chunk]);
      await new Promise(resolve => { window.releaseChunkHandler = resolve; });
    };
  });
  await connectPump(page);
  await page.waitForFunction(() => window.deliveredChunks.length === 1);
  assert.equal(await page.evaluate(() => window.readerReads), 1, 'pump ignored awaited parent backpressure');
  assert.deepEqual(await page.evaluate(() => window.receivedMetadata), [{ title: 'Test Film', duration: 600 }]);
  assert.ok(await page.getByText('Test Film · 10:00').isVisible());
  assert.ok(await page.evaluate(() => window.streamRequests.every(request => !request.url.includes('test-private-token') && !request.url.includes('api_key'))));
  assert.equal(await page.evaluate(() => window.streamRequests.at(-1).options.headers['X-Emby-Token']), 'test-private-token');
  await closePump(page);
  assert.equal(await page.evaluate(() => window.streamRequests.at(-1).options.signal.aborted), false);
  await page.evaluate(() => { window.releaseChunkHandler(); window.mediaHarness.showPump(); });
  await page.waitForFunction(() => window.readerReads === 2);
  await page.getByRole('button', { name: 'Stop sharing video' }).click();
  await pumpState(page, 'idle');
  await page.waitForFunction(() => window.releaseCalls > 0);
  assert.ok(await page.evaluate(() => window.streamRequests.at(-1).options.signal.aborted && window.handlerSignal.aborted && window.cancelCalls > 0));
  assert.equal(await page.evaluate(() => window.streamRequests.length), 2, 'Stop accidentally resubmitted the form');
  check('metadata, header-only authentication, awaited backpressure, close keeps streaming, stop cancels without restarting');
  await page.close();

  page = await openFixture();
  await page.evaluate(() => {
    window.mockBufferAhead = 65;
    window.handlerStarted = false;
    window.handlerCancelled = false;
    window.handleMediaChunk = async (chunk, { signal }) => {
      window.handlerStarted = true;
      while (window.mockBufferAhead > 60) {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (signal.aborted) { window.handlerCancelled = true; return; }
      }
      if (!signal.aborted) window.deliveredChunks.push([...chunk]);
    };
  });
  await connectPump(page);
  await page.waitForFunction(() => window.handlerStarted);
  await page.getByRole('button', { name: 'Stop sharing video' }).click();
  await page.waitForFunction(() => window.handlerCancelled && window.releaseCalls > 0);
  await page.evaluate(() => { window.mockBufferAhead = 0; });
  assert.deepEqual(await page.evaluate(() => window.deliveredChunks), [], 'stopped backpressure handler delivered a stale chunk');
  assert.equal(await page.evaluate(() => window.readerReads), 1);
  check('Stop cancels a parent waiting behind 60 seconds of buffered video and prevents stale chunk delivery');
  await page.close();

  page = await openFixture();
  await page.evaluate(() => { window.handleMediaChunk = async () => new Promise(() => {}); });
  await connectPump(page);
  await page.waitForFunction(() => window.readerReads === 1);
  await page.evaluate(() => window.mediaHarness.unmountPump());
  await page.waitForFunction(() => window.cancelCalls > 0 && window.releaseCalls > 0);
  assert.equal(await page.evaluate(() => window.streamRequests.at(-1).options.signal.aborted), true);
  check('unmount releases reader even when a parent callback never resolves');
  await page.close();

  for (const mode of ['pending-metadata', 'pending-stream']) {
    page = await openFixture(mode);
    await connectPump(page);
    await page.waitForFunction(expected => window.streamRequests.length === expected, mode === 'pending-metadata' ? 1 : 2);
    await page.getByRole('button', { name: 'Stop sharing video' }).click();
    await pumpState(page, 'idle');
    assert.ok(await page.evaluate(() => window.streamRequests.every(request => request.options.signal.aborted)));
    assert.equal(await page.evaluate(() => window.readerReads), 0);
    check(`stop cancels ${mode === 'pending-metadata' ? 'metadata setup' : 'stream connection'} before any video is read`);
    await page.close();
  }

  page = await openFixture('finite');
  await closePump(page);
  await page.evaluate(() => { window.mediaHarness.enable(); window.mediaHarness.showPump(); });
  await page.waitForFunction(() => window.engines[0]?.sourceBuffer);
  await page.evaluate(() => window.mediaHarness.play());
  await connectPump(page);
  await pumpState(page, 'complete');
  assert.equal(await page.evaluate(() => window.mediaEvents.at(-1).state), 'playing', 'transfer completion falsely ended playback');
  assert.equal(await page.evaluate(() => window.pumpEvents.some(event => event.state === 'ended')), false);
  await closePump(page);
  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('ended')));
  await mediaState(page, 'ended');
  check('finishing the byte transfer preserves buffered playback; only the video ended event ends playback');
  await page.close();

  page = await openFixture('unauthorized');
  await connectPump(page);
  await pumpState(page, 'error');
  await page.getByRole('alert').filter({ hasText: 'rejected the API token' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Share video with room' }).isEnabled(), true);
  check('authentication errors are readable and leave the form ready to retry');
  await page.close();

  page = await openFixture('metadata-failure');
  await connectPump(page);
  await pumpState(page, 'streaming');
  await page.evaluate(() => { window.mediaHarness.restartPump(120); });
  await page.waitForFunction(() => window.streamRequests.some(request => request.url.includes('StartTimeTicks=1200000000')));
  assert.equal(await page.evaluate(() => window.streamRequests[1].options.signal.aborted), true);
  check('missing metadata does not block playback; seeking cancels the old stream and starts at the requested offset');
  await page.close();

  assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join('\n')}`);
  console.log('Media UI browser checks passed (mocked media and network APIs).');
} finally {
  await browser.close();
}
