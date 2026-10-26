import { Buffer } from 'node:buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import accounts from '../../server/jellyfinAccounts.js';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const express = require('express');
const { installJellyfinAccounts, validateServerUrl } = accounts;
const accessToken = 'private-jellyfin-token';
const quickSecret = 'private-quick-connect-secret';
const userId = 'viewer';
const item = { Id: 'movie', Name: 'A movie', Type: 'Movie', RunTimeTicks: 1250000000, ProductionYear: 2024, Overview: 'Movie overview', ImageTags: { Primary: 'poster' }, UserData: { PlaybackPositionTicks: 50000000 }, Path: '/private/media/file.mkv', MediaSources: [{ Path: '/private/media/file.mkv' }] };

const listen = async server => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async server => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};

async function fixture() {
  const requests = [];
  const controls = { authenticated: false, failurePath: '', failureStatus: 502, invalidJson: false, invalidToken: false, imageType: 'image/png', imageSize: 4, redirect: false, quickDelay: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://jellyfin');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    const resource = url.pathname.replace(/^\/jellyfin/, '');
    const authorized = req.headers.authorization?.includes(`Token="${accessToken}"`);
    requests.push({ resource, query: Object.fromEntries(url.searchParams), body, authorized, method: req.method, headers: req.headers });
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (controls.failurePath === resource) { json({ error: `upstream ${accessToken} secret must not leak` }, controls.failureStatus); return; }
    if (controls.redirect) { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end(); return; }
    if (resource === '/Users/AuthenticateByName') {
      if (body?.Username !== 'Viewer' || body?.Pw !== 'password') { json({}, 401); return; }
      if (controls.invalidJson) { res.writeHead(200).end('not JSON'); return; }
      json({ AccessToken: controls.invalidToken ? 'bad"token' : accessToken, User: { Id: userId, Name: 'Viewer' }, ServerId: 'server-1' }); return;
    }
    if (resource === '/System/Info/Public') { json({ Id: 'server-1', ServerName: 'Living room', Version: '12.3.0' }); return; }
    if (resource === '/QuickConnect/Initiate') { json({ Secret: quickSecret, Code: '123456' }); return; }
    if (resource === '/QuickConnect/Connect') {
      if (url.searchParams.get('secret') !== quickSecret) { json({}, 401); return; }
      if (controls.quickDelay) await new Promise(resolve => setTimeout(resolve, controls.quickDelay));
      json({ Authenticated: controls.authenticated }); return;
    }
    if (resource === '/Users/AuthenticateWithQuickConnect') {
      if (body?.Secret !== quickSecret || !controls.authenticated) { json({}, 401); return; }
      json({ AccessToken: accessToken, User: { Id: userId, Name: 'Viewer' }, ServerId: 'server-1' }); return;
    }
    if (!authorized) { json({}, 401); return; }
    if (resource === '/Users/Me') { json({ Id: userId, Name: 'Viewer' }); return; }
    if (resource === '/Sessions/Logout') { res.writeHead(204).end(); return; }
    if (resource === `/Users/${userId}/Items`) { json({ Items: [item, { Id: '../bad' }, {}, null], TotalRecordCount: 1 }); return; }
    if (resource === `/Users/${userId}/Items/movie`) { json(item); return; }
    if (resource === `/Users/${userId}/Items/episode`) { json({ ...item, Id: 'episode', Type: 'Episode', SeriesName: 'A series', ParentIndexNumber: 2, IndexNumber: 3 }); return; }
    if (resource.startsWith(`/Users/${userId}/Items/`)) { json({}, 403); return; }
    if (/^\/Items\/[^/]+\/Images\/Primary$/.test(resource)) { res.writeHead(200, { 'Content-Type': controls.imageType }).end(Buffer.alloc(controls.imageSize, 0x47)); return; }
    json({}, 404);
  });
  const origin = await listen(server);
  return { url: `${origin}/jellyfin`, requests, controls, close: () => close(server) };
}

async function harness(t) {
  const upstream = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'samerow-accounts-test-'));
  let server, service, origin;
  const start = async () => {
    const app = express();
    service = installJellyfinAccounts(app, { dataDir });
    server = http.createServer(app);
    origin = await listen(server);
  };
  await start();
  t.after(async () => { service.close(); await close(server); await upstream.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (path, { method = 'GET', body, token, rawBody } = {}) => {
    const response = await fetch(`${origin}/api/jellyfin${path}`, { method, headers: { ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined || rawBody !== undefined ? { body: rawBody ?? JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  };
  return {
    upstream, dataDir, request, get service() { return service; },
    login: (remember = false) => request('/login', { method: 'POST', body: { serverUrl: upstream.url, username: 'Viewer', password: 'password', remember } }),
    async restart() { service.close(); await close(server); await start(); },
  };
}

test('server URL validation supports base paths and rejects unsafe targets', () => {
  assert.equal(validateServerUrl(' https://jellyfin.example/jellyfin/web/index.html '), 'https://jellyfin.example/jellyfin');
  assert.equal(validateServerUrl('http://127.0.0.1:8096/'), 'http://127.0.0.1:8096');
  for (const value of ['file:///etc/passwd', 'https://user:password@example.org', 'https://example.org?token=secret', 'https://example.org#secret', 'http://169.254.169.254/', 'http://[::ffff:a9fe:a9fe]/', 'http://metadata.google.internal/', 'http://0.0.0.0', 'http://224.0.0.1', 'http://100.100.100.200', 'http://168.63.129.16', 'http://[fe80::1]/', 'http://[ff00::1]/']) {
    assert.throws(() => validateServerUrl(value), { status: 400 }, value);
  }
});

test('login uses modern authorization, returns an opaque connection, and supports scoped library browsing', async t => {
  const h = await harness(t);
  const login = await h.login();
  assert.equal(login.status, 200);
  assert.match(login.body.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(login.body.account, { serverUrl: h.upstream.url, serverId: 'server-1', serverName: 'Living room', userId, userName: 'Viewer' });
  assert.ok(!login.text.includes(accessToken));
  assert.ok(!login.text.includes('password'));
  assert.equal(login.headers.get('cache-control'), 'no-store');
  const token = login.body.token;
  assert.equal((await h.request('/account', { token })).status, 200);
  const library = await h.request('/library?search=A%20movie&parentId=collection&startIndex=10&limit=24&userId=administrator', { token });
  assert.equal(library.status, 200);
  assert.equal(library.body.items.length, 1);
  assert.equal(library.body.items[0].duration, 125);
  assert.equal(library.body.items[0].resumeTicks, 50000000);
  assert.ok(!library.text.includes('/private/media'));
  const upstreamLibrary = h.upstream.requests.find(req => req.resource === `/Users/${userId}/Items`);
  assert.equal(upstreamLibrary.query.SearchTerm, 'A movie');
  assert.equal(upstreamLibrary.query.ParentId, 'collection');
  assert.equal(upstreamLibrary.query.StartIndex, '10');
  assert.equal(upstreamLibrary.query.Limit, '24');
  assert.equal(upstreamLibrary.query.Recursive, 'true');
  assert.equal(upstreamLibrary.query.UserId, undefined);
  const episode = await h.request('/items/episode', { token });
  assert.equal(episode.body.item.seriesName, 'A series');
  assert.equal(episode.body.item.seasonNumber, 2);
  assert.equal(episode.body.item.episodeNumber, 3);
  const protectedRequests = h.upstream.requests.filter(req => req.resource.startsWith('/Users/') && req.resource !== '/Users/AuthenticateByName');
  assert.ok(protectedRequests.length > 0);
  assert.ok(protectedRequests.every(req => req.authorized && !req.headers['x-emby-token']));
  assert.ok(protectedRequests.every(req => req.headers.authorization.includes('Client="SameRow"') && req.headers.authorization.includes('DeviceId="')));
  assert.equal((await h.request('/library')).status, 401);
  assert.equal((await h.request('/library', { token: '0'.repeat(64) })).status, 401);
});

test('remembered connections survive restart with private file permissions; logout revokes both tokens', async t => {
  const h = await harness(t);
  const token = (await h.login(true)).body.token;
  const file = join(h.dataDir, 'jellyfin-accounts.json');
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.connections.length, 1);
  assert.equal(persisted.connections[0].apiToken, accessToken);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(file, 'utf8')).includes('password'));
  await h.restart();
  assert.equal((await h.request('/account', { token })).status, 200);
  assert.equal((await h.request('/logout', { method: 'POST', token })).status, 204);
  assert.equal(await h.service.getConnection(token), null);
  assert.ok(h.upstream.requests.some(req => req.resource === '/Sessions/Logout' && req.method === 'POST' && req.authorized));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).connections.length, 0);
  await h.restart();
  assert.equal((await h.request('/account', { token })).status, 401);
});

test('session-only connections are neither saved nor restored', async t => {
  const h = await harness(t);
  const token = (await h.login()).body.token;
  await assert.rejects(stat(join(h.dataDir, 'jellyfin-accounts.json')), { code: 'ENOENT' });
  await h.restart();
  assert.equal((await h.request('/account', { token })).status, 401);
});

test('expired remembered connections are not restored', async t => {
  const h = await harness(t);
  const token = (await h.login(true)).body.token;
  const file = join(h.dataDir, 'jellyfin-accounts.json');
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  persisted.connections[0].lastUsed = Date.now() - 31 * 24 * 60 * 60 * 1000;
  await writeFile(file, JSON.stringify(persisted));
  await h.restart();
  assert.equal((await h.request('/account', { token })).status, 401);
});

test('Quick Connect hides its secret, polls safely, authenticates once, and is removed on logout', async t => {
  const h = await harness(t);
  const initial = await h.request('/quick-connect', { method: 'POST', body: { serverUrl: h.upstream.url, remember: false } });
  assert.equal(initial.status, 200);
  assert.match(initial.body.id, /^[a-f0-9]{64}$/);
  assert.equal(initial.body.code, '123456');
  assert.ok(!initial.text.includes(quickSecret));
  const url = `/quick-connect/${initial.body.id}`;
  const pending = await h.request(url);
  assert.equal(pending.body.status, 'pending');
  await h.request(url);
  assert.equal(h.upstream.requests.filter(req => req.resource === '/QuickConnect/Connect').length, 1, 'Rapid polling should not flood Jellyfin');
  await new Promise(resolve => setTimeout(resolve, 1520));
  h.upstream.controls.authenticated = true;
  h.upstream.controls.quickDelay = 30;
  const results = await Promise.all([h.request(url), h.request(url)]);
  const completed = results.find(result => result.body.status === 'authenticated');
  assert.ok(completed);
  assert.ok(!completed.text.includes(accessToken) && !completed.text.includes(quickSecret));
  const repeated = await h.request(url);
  assert.equal(repeated.body.token, completed.body.token);
  assert.equal(h.upstream.requests.filter(req => req.resource === '/Users/AuthenticateWithQuickConnect').length, 1);
  assert.equal((await h.request('/account', { token: completed.body.token })).status, 200);
  await h.request('/logout', { method: 'POST', token: completed.body.token });
  assert.equal((await h.request(url)).status, 410);
  assert.equal((await h.request('/quick-connect/not-a-code')).status, 410);
});

test('poster proxy checks item permission, restricts content, and never returns upstream errors', async t => {
  const h = await harness(t);
  const token = (await h.login()).body.token;
  const poster = await h.request('/images/movie', { token });
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('content-type'), 'image/png');
  assert.equal(poster.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(poster.headers.get('cache-control'), 'no-store');
  const denied = await h.request('/images/restricted', { token });
  assert.equal(denied.status, 403);
  assert.ok(!h.upstream.requests.some(req => req.resource === '/Items/restricted/Images/Primary'));
  h.upstream.controls.imageType = 'text/html';
  assert.equal((await h.request('/images/movie', { token })).status, 502);
  h.upstream.controls.imageType = 'image/png';
  h.upstream.controls.imageSize = 8 * 1024 * 1024 + 1;
  assert.equal((await h.request('/images/movie', { token })).status, 502);
});

test('invalid requests and upstream failures are bounded and sanitized', async t => {
  const h = await harness(t);
  const login = body => h.request('/login', { method: 'POST', body: { serverUrl: h.upstream.url, username: 'Viewer', password: 'password', remember: false, ...body } });
  assert.equal((await login({ password: 'wrong' })).status, 401);
  assert.equal((await login({ username: '' })).status, 400);
  assert.equal((await login({ remember: 'yes' })).status, 400);
  assert.equal((await h.request('/login', { method: 'POST', rawBody: '{' })).status, 400);
  assert.equal((await h.request('/login', { method: 'POST', body: { huge: 'a'.repeat(17000) } })).status, 413);
  h.upstream.controls.invalidJson = true;
  assert.equal((await login({})).status, 502);
  h.upstream.controls.invalidJson = false;
  h.upstream.controls.invalidToken = true;
  assert.equal((await login({})).status, 502);
  h.upstream.controls.invalidToken = false;
  const token = (await login({})).body.token;
  for (const query of ['limit=101', 'limit=0', 'startIndex=-1', 'parentId=..', 'search=a&search=b', 'limit=1.5']) {
    assert.equal((await h.request(`/library?${query}`, { token })).status, 400, query);
  }
  h.upstream.controls.failurePath = '/Users/Me';
  for (const status of [403, 404, 429, 500]) {
    h.upstream.controls.failureStatus = status;
    const response = await h.request('/account', { token });
    assert.equal(response.status, status === 500 ? 502 : status);
    assert.ok(!response.text.includes(accessToken));
  }
  h.upstream.controls.failurePath = '';
  h.upstream.controls.redirect = true;
  const redirect = await h.request('/account', { token });
  assert.equal(redirect.status, 502);
  assert.match(redirect.body.error, /final server address/);
});

test('Jellyfin token expiration removes the saved connection', async t => {
  const h = await harness(t);
  const token = (await h.login(true)).body.token;
  h.upstream.controls.failurePath = '/Users/Me';
  h.upstream.controls.failureStatus = 401;
  assert.equal((await h.request('/account', { token })).status, 401);
  assert.equal(await h.service.getConnection(token), null);
  assert.equal(JSON.parse(await readFile(join(h.dataDir, 'jellyfin-accounts.json'), 'utf8')).connections.length, 0);
});

test('upstream bridge requests cannot escape the selected server or retain caller credentials', async t => {
  const h = await harness(t);
  const token = (await h.login()).body.token;
  const connection = await h.service.getConnection(token);
  for (const resource of ['//evil.example/Users/Me', '/../../Users/Me', '/%2e%2e/Users/Me', '/\\evil.example/Users/Me', 'http://evil.example/Users/Me']) {
    await assert.rejects(h.service.request(connection, resource), { status: 400 });
  }
  const response = await h.service.request(connection, '/Users/Me', { headers: { authorization: 'Bearer attacker-token', 'x-emby-token': 'attacker-token', 'x-emby-authorization': 'attacker-token', 'x-mediabrowser-token': 'attacker-token', cookie: 'secret-cookie' } });
  assert.equal(response.status, 200);
  await response.body.cancel();
  const last = h.upstream.requests.at(-1);
  assert.equal(last.authorized, true);
  assert.equal(last.headers.cookie, undefined);
  assert.equal(last.headers['x-emby-token'], undefined);
  assert.equal(last.headers['x-emby-authorization'], undefined);
  assert.equal(last.headers['x-mediabrowser-token'], undefined);
  assert.ok(!last.headers.authorization.includes('attacker-token'));
});
