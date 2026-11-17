import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let chromium;
for (const name of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
  try { ({ chromium } = require(name)); break; } catch { /* Optional local runtime. */ }
}
const directory = await mkdtemp(join(tmpdir(), 'timeline-scenes-'));
const ffmpeg = process.env.FFMPEG_PATH || fileURLToPath(new URL('../../../../jellyfin-sandbox/ffmpeg/ffmpeg', import.meta.url));
let browser;
try {
  // The original stream models a bad source index: plausible media timestamps,
  // but the blue scene from 2+ minutes appears at the selected one-minute time.
  // The encoded stream has independent, visually identifiable source scenes.
  for (const mode of ['original', 'encoded']) {
    const filter = mode === 'original' ? 'color=blue:s=64x64:r=4:d=180' : "nullsrc=s=64x64:r=4:d=180,geq=lum='if(lt(T,70),81,if(lt(T,140),145,41))':cb='if(lt(T,70),90,if(lt(T,140),54,240))':cr='if(lt(T,70),240,if(lt(T,140),34,110))'";
    await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '16', '-sc_threshold', '0', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(directory, `${mode}%d.ts`), join(directory, `${mode}.m3u8`)]);
  }
  const executablePath = process.env.BROWSER_EXECUTABLE || ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/quality', route => route.fulfill({ json: { mode: 'original', maxBitrate: 4000000, source: { bitrate: 4000000 }, revision: 0 } }));
  await page.route('**/stream.m3u8?**', async route => {
    const mode = new URL(route.request().url()).searchParams.has('original') ? 'original' : 'encoded';
    const manifest = await readFile(join(directory, `${mode}.m3u8`), 'utf8');
    await route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: manifest.replace(/(original|encoded)\d+\.ts/g, file => `/timeline-media/${file}`) });
  });
  await page.route('**/timeline-media/*', async route => route.fulfill({ contentType: 'video/mp2t', body: await readFile(join(directory, new URL(route.request().url()).pathname.split('/').at(-1))) }));
  await page.goto(`${process.env.UI_BASE_URL || 'http://127.0.0.1:5175'}/tests/jellyfin-timeline.html`);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  assert.equal(await page.locator('.jellyfin-player').getAttribute('data-delivery'), 'original');
  const slider = page.getByRole('slider', { name: 'Seek for everyone' });
  const clock = page.locator('.player-clock');
  const preview = page.locator('.player-seek-preview');
  // Use the actual seek control; assert image content as well as the clock.
  for (const [seconds, channel] of [[60, 0], [80, 1], [60, 0]]) {
    let target = seconds;
    if (seconds === 80) {
      await slider.scrollIntoViewIfNeeded();
      const bounds = await slider.boundingBox();
      await page.mouse.move(bounds.x + bounds.width * 0.38, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * seconds / 180, bounds.y + bounds.height / 2, { steps: 5 });
      target = Number(await slider.inputValue());
      assert.ok(Math.abs(target - seconds) < 1, `Dragging to ${seconds}s selected ${target}s`);
      assert.equal(await clock.textContent(), '1:00.0 / 3:00.0');
      const destination = (await slider.getAttribute('aria-valuetext')).split(' of ')[0];
      assert.equal(await preview.textContent(), `Seek to ${destination}`);
      assert.equal(await page.locator('video').evaluate(video => video.currentTime), 60);
      await page.mouse.up();
    } else {
      await slider.fill(String(target));
      await slider.blur();
    }
    await page.waitForFunction(({ target, channel }) => {
      const video = document.querySelector('video');
      if (video.seeking || video.readyState < 2 || Math.abs(video.currentTime - target) > 0.1) return false;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return pixel[channel] > 180 && pixel[(channel + 1) % 3] < 80 && pixel[(channel + 2) % 3] < 80;
    }, { target, channel });
    await preview.waitFor({ state: 'detached' });
    assert.equal(Number(await slider.inputValue()), target, 'The settled slider retains the exact seek position');
    assert.equal(await page.locator('.jellyfin-player').getAttribute('data-delivery'), 'compatible');
    console.log(`PASS ${target}s displays the correct source scene`);
  }
  const waitForPausedPosition = async target => {
    await page.waitForFunction(position => {
      const video = document.querySelector('video');
      return video.paused && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - position) < 0.005;
    }, target, { timeout: 5000 });
    await preview.waitFor({ state: 'detached' });
    assert.equal(Number(await slider.inputValue()), target);
  };
  // At 4 fps there is no frame at 60.1s. Skips must still build on that exact seek.
  await slider.fill('60.1');
  await slider.blur();
  await waitForPausedPosition(60.1);
  const forward = page.getByRole('button', { name: 'Forward 10 seconds' });
  await forward.click();
  await waitForPausedPosition(70.1);
  await forward.click();
  await waitForPausedPosition(80.1);
  await slider.fill('60.1');
  await slider.blur();
  await waitForPausedPosition(60.1);
  await forward.dblclick();
  await waitForPausedPosition(80.1);
  console.log('PASS two paused skips add exactly 20s to an absolute seek between frames');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
