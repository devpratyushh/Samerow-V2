import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { jellyfinFixture } from './helpers/jellyfin-fixture.mjs';

const require = createRequire(import.meta.url);
const { createApplication } = require('../../server/application');
const { configuration } = require('../../server/config');
const { MemoryStore, createStore } = require('../../server/store');
let playwright;
for (const path of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
  try { playwright = require(path); break; } catch { /* Try the next installation. */ }
}
const browserName = process.env.DIRECT_TEST_BROWSER || 'chromium';
const engine = playwright?.[browserName];
assert.ok(engine, 'Install Playwright and choose chromium, firefox or webkit');
const executablePath = process.env.BROWSER_EXECUTABLE || (browserName === 'chromium' ?
  ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync) : undefined);
const senderPath = process.env.SAMEROW_SENDER_PATH;
assert.ok(senderPath, 'Set SAMEROW_SENDER_PATH to the built Go sender');
const redisUrl = process.env.TEST_REDIS_URL;
const config = { ...configuration({}), redisUrl, prefix: `direct-browser:${randomUUID()}`,
  jellyfinRelay: true, jellyfinDirect: true, encryptionKey: 'a'.repeat(64) };
const store = redisUrl ? await createStore(config) : new MemoryStore();
const fixture = await jellyfinFixture({ media: true });
const media = redisUrl ? createApplication({ config: { ...config, serviceRole: 'media' }, store: await createStore(config) }) : null;
if (media) {
  await media.ready;
  await new Promise(resolve => media.server.listen(0, '127.0.0.1', resolve));
  config.serviceRole = 'control';
  config.mediaOrigin = `http://127.0.0.1:${media.server.address().port}`;
}
const backend = createApplication({ config, store });
await backend.ready;
await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
const server = `http://127.0.0.1:${backend.server.address().port}`;
const connector = 'd'.repeat(32);
const connectorToken = connector + '.' + 'e'.repeat(64);
const connectionToken = 'a'.repeat(64);
const sessionId = randomUUID();
const roomId = 'direct-movie';
const base = `https://${connector}.samerow-connector.invalid`;
const auth = { Authorization: `Bearer ${connectorToken}` };
const mediaOrigin = config.mediaOrigin || server;
const relayRoot = mediaOrigin + '/api/jellyfin-relay';
const relayAbort = new AbortController();
let relayMedia = 0;
(media || backend).server.prependListener('request', req => {
  if (req.method === 'GET' && /^\/api\/jellyfin\/[a-f0-9]{48}\/(?:stream\.m3u8|asset|subtitle)(?:[/?]|$)/.test(req.url)) relayMedia++;
});
await store.set(`connector:${connector}`, { ownerUid: 'owner', digest: createHash('sha256').update(connectorToken).digest('hex') });
await store.set(`account:${connectionToken}`, { token: connectionToken, ownerUid: 'owner', accountLinked: true, base, userId: 'fixture-user', apiToken: 'fixture-token', lastUsed: Date.now() });
await store.set(`room:${roomId}`, { ownerUid: 'owner', invite: 'fixture-invite' });
const sources = await fetch(fixture.url + '/Items', { headers: { 'X-Emby-Token': 'fixture-token' } }).then(r => r.json());
const item = sources.Items[0];
await store.set(`jellyfin-room:${roomId}`, { id: sessionId, base, connectionToken, apiToken: 'fixture-token', item,
  itemId: item.Id, sourceId: 'source', sourceIds: ['source'], title: item.Name, duration: 65, playing: true,
  timestamp: 0, updatedAt: Date.now(), revision: 1,
  audioTracks: [{ index: 1, title: 'English', default: true }, { index: 2, title: 'Spanish' }],
  subtitleTracks: [{ index: 3, text: true, title: 'English' }, { index: 4, text: true, title: 'Spanish' }] });
// Emulate the existing HTTPS relay workers against the same media fixture.
const relayWorker = async () => {
  const signal = relayAbort.signal;
  while (!signal.aborted) {
    const poll = await fetch(relayRoot + '/poll', { headers: auth, signal });
    if (poll.status === 204) continue;
    if (!poll.ok) return;
    const job = await poll.json();
    const upstream = await fetch(fixture.url + job.resource, { method: job.method,
      headers: { 'X-Emby-Token': job.apiToken, ...job.headers }, signal });
    const headers = Object.fromEntries(upstream.headers);
    const body = upstream.body ? Buffer.from(await upstream.arrayBuffer()) : undefined;
    try {
      await fetch(relayRoot + '/response/' + job.job, { method: 'POST', signal,
        headers: { ...auth, 'x-relay-headers': JSON.stringify(headers), 'x-relay-status': String(upstream.status) }, body });
    } catch (error) {
      // Cancelling playback can close an in-flight relay upload.
      if (!signal.aborted && error.cause?.code !== 'UND_ERR_SOCKET') throw error;
    }
  }
};
const pluginHarness = process.env.SAMEROW_PLUGIN_TEST_DLL;
const workers = pluginHarness ? null : Promise.allSettled(Array.from({ length: 3 }, () => relayWorker()));
const { SAMEROW_DIRECT_ENABLED: _, ...pluginEnv } = process.env;
const sender = pluginHarness ? spawn(process.env.DOTNET_PATH || 'dotnet', [pluginHarness, '--relay'], {
  env: { ...pluginEnv, SAMEROW_TEST_GATEWAY: mediaOrigin,
    SAMEROW_TEST_CONNECTOR: connectorToken, SAMEROW_TEST_JELLYFIN: fixture.url },
  stdio: ['ignore', 'ignore', 'inherit'],
}) : spawn(senderPath, { stdio: ['pipe', 'inherit', 'inherit'] });
sender.stdin?.write(JSON.stringify({ Gateway: mediaOrigin, LocalURL: fixture.url, Token: connectorToken }) + '\n');
const browser = await engine.launch({ executablePath, headless: true,
  ...(browserName === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {}),
  ...(browserName === 'firefox' ? { firefoxUserPrefs: { 'media.autoplay.default': 0 } } : {}),
});
const viewers = [];
const ui = process.env.UI_BASE_URL || 'http://127.0.0.1:5175';
const play = page => page.waitForFunction(() => {
  const video = document.querySelector('.jellyfin-player video');
  return video?.readyState >= 2 && !video.paused && video.getVideoPlaybackQuality().totalVideoFrames > 0;
}, null, { timeout: 45000 });
const addViewer = async (name, uid, failIce = false) => {
  const page = await browser.newPage();
  viewers.push(page);
  page.on('pageerror', error => console.error(error.message));
  page.on('response', response => {
    if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/')) {
      console.error('Fixture API status', response.status(), new URL(response.url()).pathname.replace(/[a-f0-9]{48}/g, '[viewer]'));
    }
  });
  await page.addInitScript(failIce => {
    const Peer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      createDataChannel(label, ...args) {
        const channel = super.createDataChannel(label, ...args);
        if (label === 'samerow-hls-v1') {
          window.movieChannel = channel;
          if (failIce) this.setRemoteDescription = async () => { throw new Error('Simulated ICE failure'); };
        }
        return channel;
      }
    };
  }, failIce);
  const params = new URLSearchParams({ server, name, token: `dev:${uid}`, room: roomId });
  await page.goto(`${ui}/tests/room-integration.html?${params}`);
  await page.waitForFunction(() => window.socketEmissions.some(event => event.name === 'join-room'));
  await page.evaluate(() => window.completeMediaPermission());
  return page;
};
try {
  for (let attempt = 0; attempt < 30 && !await store.get(`direct-online:${connector}`); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(await store.get(`direct-online:${connector}`));
  const owner = await addViewer('Owner', 'owner');
  await play(owner);
  assert.equal(await owner.locator('.jellyfin-player').getAttribute('data-transport'), 'webrtc');
  assert.equal(await owner.locator('.jellyfin-player').getAttribute('data-delivery'), 'original');
  const ownerOffer = await owner.evaluate(() => {
    return window.socketEmissions.find(event => event.name === 'jellyfin-direct-offer').args[0].sessionId;
  });
  assert.equal(ownerOffer, sessionId);
  const range = 'bytes=1-31';
  const initResource = '/Videos/fixture-video/hls/1/init.mp4';
  const asset = createHash('sha256').update(initResource + '?').digest('hex');
  const directRange = await owner.evaluate(({ asset, range }) => new Promise((resolve, reject) => {
    const channel = window.movieChannel;
    const id = 0xffffffff;
    const bytes = [];
    let headers, status;
    const timer = setTimeout(() => { channel.removeEventListener('message', receive); reject(new Error('Range request timed out')); }, 3000);
    function receive({ data }) {
      if (typeof data !== 'string') {
        if (new DataView(data).getUint32(0) === id) bytes.push(...new Uint8Array(data, 8));
        return;
      }
      const frame = JSON.parse(data);
      if (frame.id !== id) return;
      if (frame.op === 'headers') ({ headers, status } = frame);
      if (frame.op === 'end') {
        clearTimeout(timer);
        channel.removeEventListener('message', receive);
        resolve({ bytes, headers, status });
      }
    }
    channel.addEventListener('message', receive);
    channel.send(JSON.stringify({ op: 'get', asset, range, id }));
  }), { asset, range });
  const upstreamRange = await fetch(fixture.url + initResource, { headers: { Range: range, 'X-Emby-Token': 'fixture-token' } });
  assert.equal(directRange.status, 206);
  assert.equal(directRange.headers['content-range'], upstreamRange.headers.get('content-range'));
  assert.deepEqual(Buffer.from(directRange.bytes), Buffer.from(await upstreamRange.arrayBuffer()));
  const guest = await addViewer('Guest', 'guest');
  await owner.getByRole('button', { name: /accept/i }).click();
  const joining = guest.getByRole('dialog', { name: 'Joining private room' });
  await joining.getByText(/The host accepted/).waitFor();
  const guestId = await guest.evaluate(() => window.fixtureSocket.id);
  assert.equal(await store.get(`member:${roomId}:${guestId}`), null);
  await joining.waitFor({ state: 'detached' });
  assert.ok(await store.get(`member:${roomId}:${guestId}`));
  await play(guest);
  assert.equal(await guest.locator('.jellyfin-player').getAttribute('data-transport'), 'webrtc');
  assert.equal(relayMedia, 0);
  assert.ok(fixture.requests.filter(req => /\/original\d+\.m4s$/.test(req.path)).length >= 2);
  const guestToken = await guest.evaluate(async roomId => {
    const reply = await window.fixtureSocket.emitWithAck('jellyfin-sync-request', roomId);
    return reply.state.accessToken;
  }, roomId);
  const unauthorized = await owner.evaluate(async ({ sessionId, accessToken }) => {
    const pc = new RTCPeerConnection();
    pc.createDataChannel('samerow-hls-v1');
    const offer = await pc.createOffer();
    pc.close();
    return window.fixtureSocket.emitWithAck('jellyfin-direct-offer', { sessionId, accessToken, sdp: offer.sdp });
  }, { sessionId, accessToken: guestToken });
  assert.ok(unauthorized.error);
  await guest.getByLabel('Audio and subtitles', { exact: true }).click();
  await guest.getByLabel('Subtitles', { exact: true }).selectOption('4');
  await guest.getByLabel('Audio track').selectOption('2');
  await guest.waitForFunction(() => {
    const track = document.querySelector('video[aria-label="Shared Jellyfin video"]')?.textTracks[0];
    return track?.cues?.[0]?.text.includes('Hola');
  });
  assert.ok(fixture.requests.some(req => req.path.endsWith('/main.m3u8') && req.query.AudioStreamIndex === '2'));
  assert.equal(await owner.locator('video[aria-label="Shared Jellyfin video"]').evaluate(v => v.textTracks.length), 0);
  assert.equal(relayMedia, 0);
  const command = action => owner.evaluate(({ action, roomId, sessionId }) => {
    window.fixtureSocket.emit('jellyfin-command', { roomId, sessionId, action, time: 25 });
  }, { action, roomId, sessionId });
  await command('pause');
  await command('seek');
  await Promise.all([owner, guest].map(page => page.waitForFunction(() => {
    const video = document.querySelector('video[aria-label="Shared Jellyfin video"]');
    return video?.paused && Math.abs(video.currentTime - 25) < 0.75;
  })));
  await command('play');
  await guest.evaluate(() => window.movieChannel.close());
  await guest.locator('.jellyfin-player[data-transport=https]').waitFor();
  await guest.getByText('HTTPS relay connected', { exact: true }).waitFor();
  await play(guest);
  assert.equal(await owner.locator('.jellyfin-player').getAttribute('data-transport'), 'webrtc');
  assert.ok(relayMedia > 0);
  assert.equal(await guest.getByLabel('Audio track').inputValue(), '2');
  assert.equal(await guest.getByLabel('Subtitles', { exact: true }).inputValue(), '4');
  const guestPosition = await guest.locator('video[aria-label="Shared Jellyfin video"]').evaluate(video => video.currentTime);
  assert.ok(guestPosition >= 24 && guestPosition < 40);
  const restrictiveViewer = await addViewer('Restrictive network', 'owner', true);
  await play(restrictiveViewer);
  assert.equal(await restrictiveViewer.locator('.jellyfin-player').getAttribute('data-transport'), 'https');
  assert.ok(await restrictiveViewer.evaluate(() => window.socketEmissions.filter(event => event.name === 'jellyfin-direct-offer').length >= 2));
  await store.set(`connector:${connector}`, null);
  await owner.waitForFunction(() => window.movieChannel.readyState === 'closed');
  console.log(`PASS ${browserName}: two direct original HLS viewers with no gateway media, isolated tracks, shared seek and pause, startup and active fallback, and connector revocation`);
} catch (error) {
  for (const page of viewers) {
    console.error((await page.locator('body').innerText()).slice(0, 2200));
    console.error(await page.evaluate(() => {
      const video = document.querySelector('video[aria-label="Shared Jellyfin video"]');
      if (!video) return null;
      return { paused: video.paused, readyState: video.readyState, seeking: video.seeking, time: video.currentTime,
        frames: video.getVideoPlaybackQuality().totalVideoFrames, errorCode: video.error?.code };
    }));
  }
  console.error('Fixture resource requests', fixture.requests.map(request => request.path));
  throw error;
} finally {
  if (pluginHarness) sender.kill('SIGINT');
  else sender.stdin.end();
  await browser.close();
  relayAbort.abort();
  await workers;
  await backend.close();
  await media?.close();
  await fixture.close();
}
