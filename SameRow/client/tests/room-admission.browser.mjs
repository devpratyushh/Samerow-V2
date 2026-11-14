import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { jellyfinFixture } from './helpers/jellyfin-fixture.mjs';
const require = createRequire(import.meta.url);
let chromium;
for (const name of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
  try { ({ chromium } = require(name)); break; } catch { /* Runtime fallback. */ }
}
const { createApplication } = require('../../server/application');
const { configuration } = require('../../server/config');
const app = createApplication({ config: configuration({ JELLYFIN_ORIGIN_BANDWIDTH_MBPS: '75' }) });
await app.ready;
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const vite = await createServer({ server: { port: 0, host: '127.0.0.1' } });
await vite.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', args: ['--autoplay-policy=no-user-gesture-required'] });
let fixture;
try {
  const errors = [];
  const signedOut = await browser.newPage();
  await signedOut.goto(vite.resolvedUrls.local[0]);
  await signedOut.getByText('Sign in with Google or GitHub to host or join a room.', { exact: true }).waitFor();
  assert.ok(await signedOut.getByRole('button', { name: 'Host a room', exact: true }).isDisabled());
  assert.ok(await signedOut.getByRole('button', { name: 'Sign in to join', exact: true }).isDisabled());
  await signedOut.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
  await signedOut.getByRole('button', { name: 'Continue with GitHub', exact: true }).waitFor();
  assert.equal(await signedOut.getByText('No account needed to join.', { exact: true }).count(), 0);
  await signedOut.close();
  const pages = await Promise.all(['Host', 'Member', 'Declined'].map(async name => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', error => errors.push(error.message));
    return { page, name };
  }));
  const open = async ({ page, name }) => {
    const query = new URLSearchParams({ server: `http://127.0.0.1:${app.server.address().port}`, room: 'approval-test', name, token: `dev:${name}` });
    await page.goto(`${vite.resolvedUrls.local[0]}tests/room-integration.html?${query}`);
    await page.locator('.room-shell').waitFor();
  };
  const [{ page: host }, { page: guest }, { page: declined }] = pages;
  await open(pages[0]);
  await host.waitForFunction(() => window.fixtureSocket.roomConfig?.isOwner);
  await host.getByRole('button', { name: 'Mute microphone', exact: true }).focus();
  await open(pages[1]);
  await guest.getByRole('dialog', { name: 'Joining private room' }).waitFor();
  const requestPopup = host.getByRole('dialog', { name: 'Someone wants to join' });
  await requestPopup.waitFor();
  assert.equal(await requestPopup.getAttribute('aria-modal'), null);
  assert.equal(await host.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Mute microphone');
  await host.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await host.getByRole('button', { name: 'Unmute microphone', exact: true }).waitFor();
  assert.equal(await app.store.get(`member:approval-test:${await guest.evaluate(() => window.fixtureSocket.id)}`), null);
  await host.getByRole('button', { name: 'Accept', exact: true }).click();
  await guest.getByRole('dialog', { name: 'Joining private room' }).waitFor({ state: 'detached' });
  const joinsBeforeReconnect = await guest.evaluate(() => window.socketEmissions.filter(event => event.name === 'join-room').length);
  await guest.evaluate(() => { window.fixtureSocket.io.engine.close(); });
  await guest.waitForFunction(() => window.fixtureSocket.connected && window.fixtureSocket.roomConfig?.ok);
  await guest.waitForFunction(count => window.socketEmissions.filter(event => event.name === 'join-room').length > count, joinsBeforeReconnect);
  await guest.waitForFunction(() => window.fixtureSocket.connected && window.fixtureSocket.roomConfig?.ok);
  assert.equal(await host.getByRole('dialog', { name: 'Someone wants to join' }).count(), 0);
  await open(pages[2]);
  await host.getByRole('dialog', { name: 'Someone wants to join' }).waitFor();
  await host.getByRole('button', { name: 'Decline', exact: true }).click();
  await declined.getByRole('dialog', { name: 'Joining private room' }).getByText('The host declined your join request.', { exact: true }).waitFor();
  await declined.getByRole('button', { name: 'Cancel and leave' }).click();
  assert.equal(await declined.evaluate(() => window.leftRoom), true);
  assert.deepEqual(errors, []);
  console.log('PASS required sign-in, host acceptance, member waiting, reconnect and decline dialogs on mobile');

  await Promise.all(pages.map(({ page }) => page.close()));
  fixture = await jellyfinFixture({ media: true });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const enter = async (room, name, setup) => {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await setup?.(page);
    const query = new URLSearchParams({ server: base, room, name, token: `dev:${name}` });
    await page.goto(`${vite.resolvedUrls.local[0]}tests/room-integration.html?${query}`);
    return page;
  };
  const emit = (page, event, ...args) => page.evaluate(({ event, args }) =>
    window.fixtureSocket.timeout(5000).emitWithAck(event, ...args), { event, args });
  const mockYouTube = async (page, hold) => {
    await page.route('https://www.youtube.com/embed/**', route => route.fulfill({ body: '' }));
    await page.addInitScript(hold => {
      window.YT = {
        PlayerState: { PLAYING: 1, PAUSED: 2, BUFFERING: 3, ENDED: 0 },
        Player: class {
          constructor(iframe, { events }) {
            iframe.src = 'about:blank';
            this.state = -1;
            this.time = 0;
            this.listeners = new Map();
            window.resumeYouTube = () => { hold = false; this.playVideo(); };
            setTimeout(events.onReady, 350);
          }
          addEventListener(name, listener) { this.listeners.set(name, listener); }
          removeEventListener(name) { this.listeners.delete(name); }
          getOption() { return []; }
          getDuration() { return 600; }
          getVolume() { return 100; }
          setVolume() {}
          mute() {}
          unMute() {}
          getPlayerState() { return this.state; }
          getAvailablePlaybackRates() { return [1]; }
          getPlaybackRate() { return 1; }
          setPlaybackRate() {}
          getVideoLoadedFraction() { return this.loaded ? 1 : 0; }
          getCurrentTime() { return this.time + (this.state === 1 ? (performance.now() - this.started) / 1000 : 0); }
          seekTo(time) { this.time = time; this.started = performance.now(); }
          playVideo() {
            if (hold || this.state === 1) return;
            this.loaded = true;
            this.state = 1;
            this.started = performance.now();
            this.listeners.get('onStateChange')?.({ data: 1 });
          }
          pauseVideo() {
            if (this.state === 2) return;
            this.time = this.getCurrentTime();
            this.state = 2;
            this.listeners.get('onStateChange')?.({ data: 2 });
          }
        },
      };
    }, hold);
  };
  const youtubeRoom = 'buffered-join-youtube';
  const youtubeHost = await enter(youtubeRoom, 'YouTube host', page => mockYouTube(page, false));
  await youtubeHost.waitForFunction(() => window.fixtureSocket.roomConfig?.isOwner);
  const youtubeMember = await enter(youtubeRoom, 'YouTube member', page => mockYouTube(page, false));
  await youtubeHost.getByRole('button', { name: 'Accept', exact: true }).click();
  await youtubeMember.waitForFunction(() => window.fixtureSocket.roomConfig?.ok);
  await youtubeHost.evaluate(roomId => window.fixtureSocket.emit('youtube-change', {
    roomId, url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE', timestamp: 10,
  }), youtubeRoom);
  for (const viewer of [youtubeHost, youtubeMember]) {
    await viewer.waitForFunction(() => {
      const player = document.querySelector('youtube-video');
      return player?.readyState >= 3 && !player.paused;
    }, null, { timeout: 8000 }).catch(async error => {
      console.error(await viewer.evaluate(() => ({ text: document.body.innerText, player: document.querySelector('youtube-video')?.outerHTML, mock: typeof window.resumeYouTube })), errors);
      throw error;
    });
  }
  const youtubeGuest = await enter(youtubeRoom, 'YouTube guest', page => mockYouTube(page, true));
  await youtubeHost.getByRole('button', { name: 'Accept', exact: true }).click();
  const youtubeWaiting = youtubeGuest.getByRole('dialog', { name: 'Joining private room' });
  await youtubeWaiting.getByText(/The host accepted/).waitFor();
  await youtubeGuest.waitForFunction(() => typeof window.resumeYouTube === 'function');
  const youtubeGuestId = await youtubeGuest.evaluate(() => window.fixtureSocket.id);
  assert.equal(await app.store.get(`member:${youtubeRoom}:${youtubeGuestId}`), null);
  const { state: staleYouTube } = await emit(youtubeGuest, 'sync-request', youtubeRoom);
  await youtubeHost.evaluate(({ roomId, sessionId }) => window.fixtureSocket.emit('youtube-state-change', {
    roomId, sessionId, timestamp: 42, isPlaying: false,
  }), { roomId: youtubeRoom, sessionId: staleYouTube.sessionId });
  const { state: pausedYouTube } = await emit(youtubeHost, 'sync-request', youtubeRoom);
  assert.ok(pausedYouTube.revision > staleYouTube.revision);
  assert.equal((await emit(youtubeGuest, 'room-playback-ready', youtubeRoom, { youtube: staleYouTube })).preparing, true);
  await youtubeGuest.evaluate(() => window.resumeYouTube());
  await youtubeWaiting.waitFor({ state: 'detached' });
  assert.ok(await app.store.get(`member:${youtubeRoom}:${youtubeGuestId}`));
  for (const viewer of [youtubeHost, youtubeMember, youtubeGuest]) {
    await viewer.waitForFunction(() => {
      const player = document.querySelector('youtube-video');
      return player?.paused && Math.abs(player.currentTime - 42) < 0.75;
    });
  }
  assert.equal((await emit(youtubeHost, 'sync-request', youtubeRoom)).state.revision, pausedYouTube.revision);
  await Promise.all([youtubeHost, youtubeMember, youtubeGuest].map(page => page.close()));
  console.log('PASS YouTube guest buffers the latest paused position without changing host or member playback');

  const playing = page => page.waitForFunction(() => {
    const video = document.querySelector('.jellyfin-player video');
    return video?.readyState >= 3 && !video.paused && video.currentTime > 0.1;
  });
  for (const delivery of ['original', 'compatible']) {
    const room = `buffered-join-${delivery}`;
    const hostPage = await enter(room, 'Host');
    await hostPage.waitForFunction(() => window.fixtureSocket?.roomConfig?.isOwner);
    assert.equal((await emit(hostPage, 'jellyfin-open', {
      roomId: room, serverUrl: fixture.url, apiToken: 'fixture-token', itemId: 'fixture-video',
    })).ok, true);
    await playing(hostPage);
    if (delivery === 'compatible') {
      await hostPage.getByLabel('Audio and subtitles', { exact: true }).click();
      await hostPage.getByLabel('Quality on this device', { exact: true }).selectOption('auto');
      await hostPage.locator('.jellyfin-player[data-delivery="compatible"]').waitFor();
      await playing(hostPage);
    }
    const source = await hostPage.locator('.jellyfin-player video').getAttribute('src');
    const hostState = (await emit(hostPage, 'jellyfin-sync-request', room)).state;
    const hostQuality = `${base}/api/jellyfin/${hostState.accessToken}/quality`;
    assert.equal((await (await fetch(hostQuality)).json()).maxBitrate, 50_000_000);
    await hostPage.evaluate(() => {
      window.hostReloads = 0;
      document.querySelector('.jellyfin-player video').addEventListener('emptied', () => window.hostReloads++);
    });

    const late = await enter(room, 'Late guest');
    let resume;
    const held = new Promise(resolve => { resume = resolve; });
    await late.route('**/stream.m3u8?*', async route => { await held; await route.continue(); });
    await hostPage.getByRole('button', { name: 'Accept', exact: true }).click();
    const waiting = late.getByRole('dialog', { name: 'Joining private room' });
    await waiting.getByText(/The host accepted/).waitFor();
    const socketId = await late.evaluate(() => window.fixtureSocket.id);
    assert.equal(await app.store.get(`member:${room}:${socketId}`), null);
    assert.ok(!app.io.sockets.sockets.get(socketId).rooms.has(room));
    assert.equal((await emit(late, 'room-playback-ready', room, { sessionId: hostState.sessionId, revision: hostState.revision })).preparing, true);
    const guestState = (await emit(late, 'jellyfin-sync-request', room)).state;
    await hostPage.evaluate(({ roomId, sessionId }) => {
      window.fixtureSocket.emit('jellyfin-command', { roomId, sessionId, action: 'seek', time: 12 });
    }, { roomId: room, sessionId: hostState.sessionId });
    assert.ok((await emit(hostPage, 'jellyfin-sync-request', room)).state.revision > guestState.revision);
    assert.equal((await emit(late, 'room-playback-ready', room, guestState)).preparing, true, 'A host seek invalidates stale readiness');
    resume();
    await waiting.waitFor({ state: 'detached' });
    await playing(late);
    assert.ok(await app.store.get(`member:${room}:${socketId}`));
    const guestTime = await late.locator('.jellyfin-player video').evaluate(video => video.currentTime);
    const hostTime = await hostPage.locator('.jellyfin-player video').evaluate(video => video.currentTime);
    assert.ok(Math.abs(hostTime - guestTime) < 1, `Guest joined in sync (${hostTime} / ${guestTime})`);
    assert.equal((await (await fetch(hostQuality)).json()).maxBitrate, 30_000_000);
    await hostPage.waitForTimeout(10_500);
    assert.equal(await hostPage.locator('.jellyfin-player video').getAttribute('src'), source);
    assert.equal(await hostPage.evaluate(() => window.hostReloads), 0);
    assert.equal(await hostPage.locator('.jellyfin-player').getAttribute('data-delivery'), delivery);
    await late.close(); await hostPage.close();
    await new Promise(resolve => setTimeout(resolve, 150));
    console.log(`PASS late guest buffers and syncs before joining without restarting host ${delivery} playback`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close(); await vite.close(); await app.close(); await fixture?.close();
}
