// Real C# relay worker, Jellyfin server, gateway and four Chromium viewers.
// Loopback HTTP and development identities are confined to this test harness.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const sandbox = join(workspace, 'jellyfin-sandbox');
const jellyfin = process.env.JELLYFIN_URL || 'http://127.0.0.1:8096';
assert.ok(new URL(jellyfin).hostname === '127.0.0.1', 'Use a disposable loopback Jellyfin server');
const ui = process.env.UI_BASE_URL || 'http://127.0.0.1:5175';
const credentials = JSON.parse(execFileSync('python3', ['-c', `
import json,sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro&immutable=1',uri=True)
print(json.dumps({'token':c.execute('select AccessToken from ApiKeys limit 1').fetchone()[0],
'userId':c.execute('select Id from Users order by InternalId limit 1').fetchone()[0].replace('-','')}))
`, join(sandbox, 'data/data/jellyfin.db')], { encoding: 'utf8' }));
const dataDir = await mkdtemp(join(tmpdir(), 'samerow-plugin-acceptance-'));
process.env.SAMEROW_DATA_DIR = dataDir;
const { createApplication } = require('../../server/application');
const { configuration } = require('../../server/config');
const backend = createApplication({
  config: { ...configuration({}), jellyfinRelay: true, encryptionKey: 'a'.repeat(64), maxRoomSize: 4 },
  identity: { verify: async () => ({ uid: 'owner', exp: Math.floor(Date.now() / 1000) + 3600 }) },
});
await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
const gateway = 'http://127.0.0.1:' + backend.server.address().port;
backend.config.mediaOrigin = gateway;
let chromium;
for (const path of ['playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright']) {
  try { ({ chromium } = require(path)); break; } catch { }
}
assert.ok(chromium, 'Playwright is required');
const browser = await chromium.launch({
  headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext();
const pages = [];
let room;
let invite;
const errors = [];
let relay;
const relayMessages = [];
const title = 'SameRow Plugin 4K ' + randomUUID();
const mediaDir = join(sandbox, 'media', title);
const filename = join(mediaDir, title + '.mp4');
const api = async (base, path, body, headers = {}) => {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `API ${path.split('?')[0]} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
};
let adminToken = credentials.token;
const jf = (path, body) => api(jellyfin, path, body, { Authorization: `MediaBrowser Token="${adminToken}"` });
const cloud = (path, body, headers = {}) => api(gateway, path, body, { 'X-SameRow-Token': 'test:owner', ...headers });
const waitUntil = async (callback, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('Integration condition timed out');
};
const addViewer = async name => {
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${ui}/tests/room-integration.html?server=${encodeURIComponent(gateway)}&name=${name}&room=${room}&invite=${encodeURIComponent(invite)}`);
  await page.waitForFunction(() => window.fixtureSocket?.connected);
  await page.evaluate(() => window.completeMediaPermission());
  await page.waitForFunction(() => document.querySelector('.room-shell'));
  return page;
};
const playing = page => page.waitForFunction(() => {
  const video = document.querySelector('.jellyfin-player video');
  return video?.readyState >= 3 && !video.paused && video.videoWidth === 3840 && video.getVideoPlaybackQuality().totalVideoFrames > 0;
}, null, { timeout: 45000 });

try {
  const deviceHeader = { Authorization: 'MediaBrowser Client="SameRow acceptance", Device="Test", DeviceId="samerow-plugin-acceptance", Version="1.0.0"' };
  const adminQuick = await api(jellyfin, '/QuickConnect/Initiate', {}, deviceHeader);
  await jf('/QuickConnect/Authorize?' + new URLSearchParams({ code: adminQuick.Code, userId: credentials.userId }), {});
  const authenticated = await api(jellyfin, '/Users/AuthenticateWithQuickConnect', { Secret: adminQuick.Secret }, deviceHeader);
  adminToken = authenticated.AccessToken;
  await mkdir(mediaDir);
  const sourceFolder = join(sandbox, 'media/Multitrack Test (2026)');
  const source = (await readdir(sourceFolder)).find(name => name.endsWith('.mp4'));
  assert.ok(source, 'The disposable multitrack sample is required');
  execFileSync(join(sandbox, 'ffmpeg/ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-i', join(sourceFolder, source),
    '-map', '0', '-c', 'copy', '-c:v', 'libx264', '-vf', 'scale=3840:2160',
    '-preset', 'ultrafast', '-crf', '28', '-t', '60', filename,
  ], { timeout: 120000, stdio: 'pipe' });
  await jf('/Library/Refresh', {});
  const item = await waitUntil(async () => {
    const reply = await jf('/Users/' + credentials.userId + '/Items?' + new URLSearchParams({ Recursive: 'true', Fields: 'Path,MediaSources,MediaStreams' }));
    return reply.Items?.find(value => value.Path === filename && value.MediaSources?.[0]?.MediaStreams?.some(stream => stream.Width === 3840));
  }, 60000);
  assert.ok(item);
  const secret = 'b'.repeat(64);
  const approval = await cloud('/api/jellyfin-relay/approval/start', { claim: createHash('sha256').update(secret).digest('hex') });
  await cloud('/api/jellyfin-relay/approval/approve', { id: approval.id });
  const connector = await cloud('/api/jellyfin-relay/approval/claim', { id: approval.id, secret });
  relay = spawn(join(workspace, '.dotnet/dotnet'), [
    join(workspace, 'Samerow-V2/jellyfin-plugin-samerow.tests/bin/Release/net10.0/SameRow.Plugin.Tests.dll'), '--relay',
  ], {
    env: { ...process.env, JELLYFIN_SERVER_PATH: join(sandbox, 'jellyfin'), SAMEROW_TEST_GATEWAY: gateway,
      SAMEROW_TEST_CONNECTOR: connector.token, SAMEROW_TEST_JELLYFIN: jellyfin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let started = false;
  relay.stdout.on('data', value => { if (value.toString().includes('Test relay started')) started = true; relayMessages.push(value.toString().replace(/[a-f0-9]{32,}/gi, '[redacted]')); });
  relay.stderr.on('data', value => relayMessages.push(value.toString().replace(/[a-f0-9]{32,}/gi, '[redacted]')));
  await waitUntil(() => started);
  const address = 'https://' + approval.id + '.samerow-connector.invalid';
  const quick = await cloud('/api/jellyfin/quick-connect', { serverUrl: address, remember: false });
  await jf('/QuickConnect/Authorize?' + new URLSearchParams({ code: quick.code, userId: credentials.userId }), {});
  const login = await waitUntil(async () => {
    const reply = await cloud('/api/jellyfin/quick-connect/' + quick.id);
    return reply.token ? reply : null;
  });
  const library = await cloud('/api/jellyfin/library?' + new URLSearchParams({ search: item.Name }), undefined, { Authorization: 'Bearer ' + login.token });
  assert.ok(library.items.some(value => value.id === item.Id));
  console.log('PASS real C# relay pairing, Quick Connect and permitted library browsing');

  const { io } = require('../../server/node_modules/socket.io-client');
  const organizer = io(gateway, { auth: { token: 'test:owner' } });
  await new Promise(resolve => organizer.once('connect', resolve));
  const reservation = await new Promise(resolve => organizer.emit('generate-room', true, resolve));
  room = reservation.code;
  invite = reservation.invite;
  organizer.disconnect();
  assert.ok(room && invite, 'Create a private room for the paired server');
  const host = await addViewer('Host');
  const guest = await addViewer('Guest');
  const opened = await host.evaluate(details => new Promise(resolve => window.fixtureSocket.emit('jellyfin-open', {
    ...details,
  }, resolve)), { roomId: room, connectionToken: login.token, itemId: item.Id });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  await Promise.all([playing(host), playing(guest)]);
  const third = await addViewer('Third');
  const fourth = await addViewer('Fourth');
  await Promise.all([playing(third), playing(fourth)]);
  assert.ok((await Promise.all(pages.map(page => page.locator('.jellyfin-player').getAttribute('data-delivery')))).every(value => value === 'original'));
  console.log('PASS four browsers decode 3840x2160 original video through C# relay');

  const state = await host.evaluate(room => new Promise(resolve => window.fixtureSocket.emit('jellyfin-sync-request', room, reply => resolve(reply.state))), room);
  const native = gateway + '/api/jellyfin-native/' + state.accessToken;
  const path = '/Videos/' + item.Id + '/stream.mp4?' + new URLSearchParams({ Static: 'true', MediaSourceId: item.MediaSources[0].Id });
  for (const range of ['bytes=0-65535', 'bytes=65536-131071']) {
    const direct = await fetch(jellyfin + path, { headers: { Authorization: `MediaBrowser Token="${adminToken}"`, Range: range } });
    const relayed = await fetch(native + path, { headers: { Range: range } });
    assert.equal(direct.status, 206);
    assert.equal(relayed.status, 206);
    assert.equal(relayed.headers.get('content-range'), direct.headers.get('content-range'));
    assert.deepEqual(Buffer.from(await relayed.arrayBuffer()), Buffer.from(await direct.arrayBuffer()));
  }
  console.log('PASS original byte ranges match exactly across Jellyfin, C# relay and gateway');
  await guest.getByLabel('Audio and subtitles', { exact: true }).click();
  await guest.getByLabel('Audio track', { exact: true }).selectOption('2');
  await guest.getByLabel('Subtitles', { exact: true }).selectOption('4');
  await guest.getByRole('button', { name: 'Done', exact: true }).click();
  await playing(guest);
  await guest.waitForFunction(() => document.querySelector('.jellyfin-player video').textTracks[0]?.cues?.length > 0);
  assert.equal(await host.locator('.jellyfin-player video').evaluate(video => video.textTracks.length), 0);
  await guest.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
  await host.waitForFunction(() => document.querySelector('.jellyfin-player video').paused);
  await guest.locator('.player-seek input').fill('20');
  await guest.locator('.player-seek input').press('ArrowRight');
  await guest.locator('.player-seek input').blur();
  await Promise.all(pages.map(page => page.waitForFunction(() => Math.abs(document.querySelector('.jellyfin-player video').currentTime - 20.1) < 0.6)));
  await guest.getByRole('button', { name: 'Play for everyone', exact: true }).click();
  await Promise.all(pages.map(playing));
  await fourth.evaluate(() => { window.fixtureSocket.disconnect(); window.fixtureSocket.connect(); });
  await playing(fourth);
  await host.waitForTimeout(3000);
  const clocks = await Promise.all(pages.map(page => page.locator('.jellyfin-player video').evaluate(video => video.currentTime)));
  assert.ok(Math.max(...clocks) - Math.min(...clocks) < 2);
  assert.deepEqual(errors, []);
  console.log('PASS independent tracks, subtitles, shared seek and reconnect; clocks', JSON.stringify(clocks));
  const logNames = (await readdir(join(sandbox, 'logs'))).filter(name => name.startsWith('FFmpeg.Remux'));
  let copied = false;
  for (const name of logNames) {
    const log = await readFile(join(sandbox, 'logs', name), 'utf8');
    if (log.includes(title) && /Stream #0:0 -> #0:0 \(copy\)/.test(log)) copied = true;
  }
  assert.ok(copied, 'Jellyfin FFmpeg logs must prove original video stream copy');
  console.log('PASS Jellyfin confirms 4K video stream copy');
} catch (error) {
  console.error(relayMessages.slice(-20).join(""));
  throw error;
} finally {
  await context.close();
  await browser.close();
  relay?.kill('SIGTERM');
  await backend.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(mediaDir, { recursive: true, force: true });
  await jf('/Library/Refresh', {}).catch(() => {});
  if (adminToken !== credentials.token) await jf('/Sessions/Logout', {}).catch(() => {});
}
