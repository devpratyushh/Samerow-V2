const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');
const { randomBytes, randomUUID } = require('node:crypto');

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const validId = value => typeof value === 'string' && idPattern.test(value);
const tokenPattern = /^[a-f0-9]{64}$/;
const { connectorId } = require('./jellyfinRelay');
const upstreamTokenPattern = /^[A-Za-z0-9._~-]{1,4096}$/;
const idleLifetime = 30 * 24 * 60 * 60 * 1000;
const quickLifetime = 10 * 60 * 1000;
const mintToken = () => randomBytes(32).toString('hex');
const safeText = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const failure = (status, message) => Object.assign(new Error(message), { status });

function blockedAddress(hostname, policy = {}) {
  const address = hostname.replace(/^\[|\]$/g, "");
  if (policy.production && !policy.allowPrivate && require("ipaddr.js").isValid(address) && require("ipaddr.js").process(address).range() !== "unicast") return true;
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (['metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal'].includes(value)) return true;
  if (value === '100.100.100.200' || value === '168.63.129.16') return true;
  if (/^169\.254\./.test(value) || /^0\./.test(value) || /^(22[4-9]|23\d|24\d|25[0-5])\./.test(value)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(value) || /^ff[0-9a-f]{2}:/i.test(value) || value === '::') return true;
  // URL normalizes IPv4-mapped IPv6 addresses to their hexadecimal form.
  if (value.startsWith('::ffff:')) {
    const tail = value.slice(7);
    if (tail.includes('.')) return blockedAddress(tail);
    const parts = tail.split(':');
    if (parts.length === 2 && parts.every(part => /^[0-9a-f]{1,4}$/.test(part))) {
      const first = parseInt(parts[0], 16), second = parseInt(parts[1], 16);
      return blockedAddress(`${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`);
    }
  }
  return false;
}

function validateServerUrl(value, policy = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw failure(400, 'Enter a valid Jellyfin server address.');
  let url;
  try { url = new URL(value.trim()); } catch { throw failure(400, 'Enter the full Jellyfin address, including http:// or https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || blockedAddress(url.hostname, policy)) {
    throw failure(400, 'Use a Jellyfin HTTP or HTTPS address without credentials, query parameters, or a fragment.');
  }
  if (policy.origins?.length && !policy.origins.includes(url.origin)) throw failure(403, 'This Jellyfin server is not allowed by this SameRow deployment.');
  if (policy.production && url.protocol !== 'https:' && !policy.allowPrivate) throw failure(400, 'Use an HTTPS Jellyfin server.');
  // A copied Jellyfin web URL should connect to its server (including any base path).
  url.pathname = url.pathname.replace(/\/web(?:\/index\.html)?\/?$/i, '').replace(/\/+$/, '');
  return url.href.replace(/\/$/, '');
}

function safeLookup(hostname, options, callback, policy = {}) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(entry => blockedAddress(entry.address, policy))) return callback(failure(400, 'This address cannot be used as a Jellyfin server.'));
    if (options?.all) callback(null, addresses);
    else {
      const entry = addresses.find(address => !options?.family || address.family === options.family) || addresses[0];
      callback(null, entry.address, entry.family);
    }
  });
}

/** Uses Node's connection-time DNS lookup so hostnames cannot redirect credentials to metadata services. */
function upstreamRequest(connection, resource, options = {}) {
  if (!connection || typeof resource !== 'string' || !resource.startsWith('/') || resource.startsWith('//') || resource.includes('\\')) return Promise.reject(failure(400, 'Invalid Jellyfin resource.'));
  let url;
  try {
    url = new URL(`${connection.base}${resource}`);
    const base = new URL(connection.base);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`) || blockedAddress(url.hostname, options.networkPolicy)) throw new Error();
    if (options.networkPolicy?.origins?.length && !options.networkPolicy.origins.includes(url.origin)) throw new Error();
  } catch { return Promise.reject(failure(400, 'Invalid Jellyfin resource.')); }
  const headers = new Headers(options.headers || {});
  headers.delete('host'); headers.delete('cookie'); headers.delete('content-length');
  headers.set('accept-encoding', 'identity');
  headers.set('authorization', `MediaBrowser Client="SameRow", Device="SameRow Web", DeviceId="${connection.deviceId}", Version="1.0.0"${connection.apiToken ? `, Token="${connection.apiToken}"` : ''}`);
  headers.delete('x-emby-token');
  headers.delete('x-emby-authorization');
  headers.delete('x-mediabrowser-token');
  const timeoutMs = Math.min(120000, Math.max(1000, options.timeoutMs || 20000));
  const headerController = options.timeoutUntilHeaders ? new AbortController() : null;
  const headerTimer = headerController && setTimeout(() => headerController.abort(), timeoutMs);
  const timeout = headerController?.signal || AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method || 'GET', headers: Object.fromEntries(headers), lookup: (host, opts, callback) => safeLookup(host, opts, callback, options.networkPolicy),
      signal, maxHeaderSize: 32768,
    }, response => {
      if (headerTimer) clearTimeout(headerTimer);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume(); reject(failure(502, 'Jellyfin redirected this request. Connect using its final server address.')); return;
      }
      const responseHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      const bodyless = options.method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
      if (bodyless) response.resume();
      resolve(new Response(bodyless ? null : Readable.toWeb(response), { status: response.statusCode, headers: responseHeaders }));
    });
    request.on('error', error => { if (headerTimer) clearTimeout(headerTimer); reject(error); });
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}

const { readJson } = require('./upstreamBody');

function normalizeItem(item) {
  return {
    id: item.Id, name: safeText(item.Name), type: safeText(item.Type, 32),
    year: Number.isFinite(item.ProductionYear) ? item.ProductionYear : null,
    duration: Math.max(0, Number(item.RunTimeTicks) / 10000000 || 0),
    overview: safeText(item.Overview, 10000), imageTag: safeText(item.ImageTags?.Primary, 256),
    seriesName: safeText(item.SeriesName), seasonNumber: item.ParentIndexNumber ?? null,
    episodeNumber: item.Type === 'Episode' ? item.IndexNumber ?? null : null,
    resumeTicks: Math.max(0, Number(item.UserData?.PlaybackPositionTicks) || 0),
  };
}

function installJellyfinAccounts(app, options = {}) {
  const connections = new Map(), pending = new Map(), limits = new Map();
  const shared = options.store;
  const request = (connection, resource, opts = {}) => options.relay && connectorId(connection.base)
    ? options.relay.request(connection, resource, opts)
    : upstreamRequest(connection, resource, { ...opts, networkPolicy: options.networkPolicy });
  const resolveBase = async (value, uid) => {
    const candidate = typeof value === 'string' ? value.trim() : '';
    if (options.relay && await options.relay.authorize(candidate, uid)) return candidate;
    return validateServerUrl(value, options.networkPolicy);
  };
  const getPending = key => shared ? shared.get(`quick:${key}`) : pending.get(key);
  const putPending = (key, value) => shared ? shared.set(`quick:${key}`, value, 600) : pending.set(key, value);
  const deletePending = key => shared ? shared.set(`quick:${key}`, null) : pending.delete(key);
  const dataDir = path.resolve(options.dataDir || process.env.SAMEROW_DATA_DIR || path.join(__dirname, '.data'));
  const storePath = path.join(dataDir, 'jellyfin-accounts.json');
  let saveTimer;
  const save = () => {
    clearTimeout(saveTimer); saveTimer = undefined;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${storePath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, connections: [...connections.values()].filter(connection => connection.remember && connection.lastUsed > Date.now() - idleLifetime) }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, storePath); fs.chmodSync(storePath, 0o600);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  };
  const scheduleSave = () => { if (!saveTimer) { saveTimer = setTimeout(() => { try { save(); } catch { /* A later explicit login/logout reports persistence failure. */ } }, 1000); saveTimer.unref(); } };
  if (!shared) try {
    const stat = fs.statSync(storePath);
    if (stat.size > 16 * 1024 * 1024) throw new Error('size');
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (stored.version !== 1 || !Array.isArray(stored.connections)) throw new Error('format');
    fs.chmodSync(storePath, 0o600);
    for (const connection of stored.connections) {
      if (tokenPattern.test(connection.token) && typeof connection.apiToken === 'string' && upstreamTokenPattern.test(connection.apiToken) && validId(connection.userId) && validId(connection.deviceId) && connection.remember === true && Number.isFinite(connection.lastUsed) && connection.lastUsed > Date.now() - idleLifetime) {
        connection.base = validateServerUrl(connection.base);
        connections.set(connection.token, connection);
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('The saved Jellyfin connections could not be read. Check SAMEROW_DATA_DIR and its permissions.'); }

  const account = connection => ({ serverUrl: connection.base, serverId: connection.serverId, serverName: connection.serverName, userId: connection.userId, userName: connection.userName });
  const forget = async connection => {
    if (shared) await shared.set(`account:${connection.token}`, null);
    else { connections.delete(connection.token); if (connection.remember) save(); }
  };
  const getConnection = async token => {
    if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
    const connection = shared ? await shared.get(`account:${token}`) : connections.get(token);
    if (!connection) return null;
    if (connection.lastUsed <= Date.now() - idleLifetime) { await forget(connection); return null; }
    if (Date.now() - connection.lastUsed >= 60000) {
      connection.lastUsed = Date.now();
      if (shared) {
        // Never resurrect a credential revoked concurrently on another instance.
        await shared.update(`account:${token}`, current => current ? { ...current, lastUsed: connection.lastUsed } : null, connection.remember ? idleLifetime / 1000 : 43200);
      } else if (connection.remember) scheduleSave();
    }
    return connection;
  };
  const checkResponse = async (response, connection, auth = false) => {
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 401) {
      if (connection?.token) await forget(connection);
      throw failure(401, auth ? 'Jellyfin did not accept that sign-in. Check your username and password.' : 'Your Jellyfin connection expired. Sign in again.');
    }
    if (response.status === 403) throw failure(403, 'Jellyfin does not allow this action for your account.');
    if (response.status === 404) throw failure(404, 'Jellyfin could not find this item or feature.');
    throw failure(response.status === 429 ? 429 : 502, response.status === 429 ? 'Jellyfin is busy. Wait a moment and try again.' : 'Jellyfin could not complete this request.');
  };
  const jsonRequest = async (connection, resource, requestOptions, auth = false) => readJson(await checkResponse(await request(connection, resource, requestOptions), connection, auth));
  const completeLogin = async (connection, result, remember, ownerUid) => {
    if (typeof result?.AccessToken !== 'string' || !upstreamTokenPattern.test(result.AccessToken) || !validId(result.User?.Id)) throw failure(502, 'Jellyfin returned an invalid sign-in response.');
    const info = await jsonRequest(connection, '/System/Info/Public').catch(() => ({}));
    const value = { token: mintToken(), ownerUid, base: connection.base, apiToken: result.AccessToken, userId: result.User.Id, serverId: safeText(result.ServerId || info.Id, 128), userName: safeText(result.User.Name), serverName: safeText(info.ServerName) || 'Jellyfin', deviceId: connection.deviceId, remember: remember !== false, createdAt: Date.now(), lastUsed: Date.now() };
    if (!shared && connections.size >= 5000) throw failure(503, 'This SameRow server has reached its connection limit.');
    if (!shared) connections.set(value.token, value);
    try { if (shared) await shared.set(`account:${value.token}`, value, value.remember ? idleLifetime / 1000 : 43200); else if (value.remember) save(); }
    catch { connections.delete(value.token); request(value, '/Sessions/Logout', { method: 'POST', timeoutMs: 5000 }).then(response => response.body?.cancel()).catch(() => {}); throw failure(503, 'SameRow could not remember this connection. Check shared storage or try again shortly.'); }
    return { token: value.token, account: account(value) };
  };
  const throttle = async (req, kind, maximum, period) => {
    if (shared) {
      if (!await shared.limit(`jellyfin:${kind}:${req.identity?.uid || req.ip}`, maximum, period / 1000)) throw failure(429, 'Too many Jellyfin requests. Wait a moment and try again.');
      return;
    }
    const key = `${kind}:${req.ip || req.socket.remoteAddress}`;
    let limit = limits.get(key);
    if (!limit || limit.until <= Date.now()) { limit = { count: 0, until: Date.now() + period }; limits.set(key, limit); }
    limit.count += 1;
    if (limit.count > maximum) throw failure(429, 'Too many Jellyfin requests. Wait a moment and try again.');
  };
  const authenticate = async req => {
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization || '')?.[1];
    const connection = await getConnection(token);
    if (!connection || (connection.ownerUid && connection.ownerUid !== req.identity?.uid)) throw failure(401, 'Connect your Jellyfin account to continue.');
    return connection;
  };
  const wrap = (handler, auth = false) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await throttle(req, 'request', 600, 60000);
      if (auth) await throttle(req, 'login', 30, 15 * 60000);
      if (req.body && Buffer.byteLength(JSON.stringify(req.body)) > 16384) throw failure(413, 'The sign-in request is too large.');
      await handler(req, res);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const status = Number.isInteger(error.status) ? error.status : 502;
      res.status(status).json({ error: error.status ? error.message : error.name === 'AbortError' || error.name === 'TimeoutError' ? 'Jellyfin took too long to respond. Try again.' : 'SameRow could not reach Jellyfin. Use an address reachable from this SameRow server.' });
    }
  };
  const router = express.Router();
  const parseJson = express.json({ limit: '16kb' });
  router.post('/login', parseJson, wrap(async (req, res) => {
    const { serverUrl, username, password, remember } = req.body || {};
    if (typeof username !== 'string' || !username.trim() || username.length > 256 || typeof password !== 'string' || password.length > 4096 || (remember !== undefined && typeof remember !== 'boolean')) throw failure(400, 'Enter your Jellyfin username and password.');
    const connection = { base: await resolveBase(serverUrl, req.identity?.uid), deviceId: randomUUID() };
    const result = await jsonRequest(connection, '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: username.trim(), Pw: password }) }, true);
    res.json(await completeLogin(connection, result, remember, req.identity?.uid));
  }, true));
  router.get('/account', wrap(async (req, res) => {
    const connection = await authenticate(req);
    await jsonRequest(connection, '/Users/Me');
    res.json({ account: account(connection) });
  }));
  router.post('/logout', parseJson, wrap(async (req, res) => {
    const connection = await authenticate(req); await forget(connection);
    for (const [key, value] of pending) if (value.result?.token === connection.token) pending.delete(key);
    try { const response = await request(connection, '/Sessions/Logout', { method: 'POST', timeoutMs: 5000 }); await response.body?.cancel(); } catch {}
    res.status(204).end();
  }));
  router.post('/quick-connect', parseJson, wrap(async (req, res) => {
    const { serverUrl, remember } = req.body || {};
    if (remember !== undefined && typeof remember !== 'boolean') throw failure(400, 'Choose whether to remember this connection.');
    if (pending.size >= 1000) throw failure(503, 'Too many sign-ins are waiting. Try again shortly.');
    const connection = { base: await resolveBase(serverUrl, req.identity?.uid), deviceId: randomUUID() };
    const result = await jsonRequest(connection, '/QuickConnect/Initiate', { method: 'POST' });
    if (typeof result.Secret !== 'string' || !result.Secret || result.Secret.length > 4096 || typeof result.Code !== 'string' || !/^[A-Z0-9]{4,16}$/i.test(result.Code)) throw failure(502, 'Jellyfin did not return a Quick Connect code. Check that Quick Connect is enabled.');
    const id = mintToken(), expiresAt = Date.now() + quickLifetime;
    await putPending(id, { connection, secret: result.Secret, code: result.Code, remember, expiresAt, lastPoll: 0, ownerUid: req.identity?.uid });
    res.json({ id, code: result.Code, expiresAt });
  }, true));
  router.get('/quick-connect/:id', wrap(async (req, res) => {
    let entry = tokenPattern.test(req.params.id) ? await getPending(req.params.id) : null;
    if (!entry || entry.expiresAt <= Date.now()) { await deletePending(req.params.id); throw failure(410, 'This Quick Connect code expired. Generate a new code.'); }
    if (entry.ownerUid && entry.ownerUid !== req.identity?.uid) throw failure(403, 'This sign-in belongs to another user.');
    if (entry.result) { if (!await getConnection(entry.result.token)) throw failure(410, 'This sign-in has ended.'); res.json({ status: 'authenticated', ...entry.result }); return; }
    const waiting = () => res.json({ status: 'pending', code: entry.code, expiresAt: entry.expiresAt });
    if (entry.busyUntil > Date.now() || entry.busy || Date.now() - entry.lastPoll < 1500) { waiting(); return; }
    if (shared) {
      const pollId = mintToken(), now = Date.now();
      entry = await shared.update(`quick:${req.params.id}`, current => current && (!current.busyUntil || current.busyUntil < now) ? { ...current, pollId, busyUntil: now + 45000, lastPoll: now } : current, 600);
      if (!entry || entry.pollId !== pollId) { waiting(); return; }
    } else { entry.busy = true; entry.lastPoll = Date.now(); }
    try {
      const state = await jsonRequest(entry.connection, `/QuickConnect/Connect?${new URLSearchParams({ secret: entry.secret })}`);
      if (!state.Authenticated) { waiting(); return; }
      const result = await jsonRequest(entry.connection, '/Users/AuthenticateWithQuickConnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Secret: entry.secret }) });
      entry.result = await completeLogin(entry.connection, result, entry.remember, entry.ownerUid); entry.secret = '';
      res.json({ status: 'authenticated', ...entry.result });
    } finally { entry.busy = false; entry.busyUntil = 0; await putPending(req.params.id, entry); }
  }));
  router.get('/library', wrap(async (req, res) => {
    const connection = await authenticate(req);
    const { parentId, search = '' } = req.query;
    const startIndex = Number(req.query.startIndex ?? 0), limit = Number(req.query.limit ?? 48);
    if ((parentId !== undefined && !validId(parentId)) || typeof search !== 'string' || search.length > 200 || !Number.isInteger(startIndex) || startIndex < 0 || startIndex > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw failure(400, 'Invalid library query.');
    const query = new URLSearchParams({ IncludeItemTypes: parentId ? 'Movie,Series,Season,Episode,BoxSet,Folder,CollectionFolder' : search.trim() ? 'Movie,Series,Episode' : 'Movie,Series', Recursive: String(!parentId || !!search.trim()), SortBy: parentId ? 'ParentIndexNumber,IndexNumber,SortName' : 'SortName', SortOrder: 'Ascending', Fields: 'Overview,PrimaryImageAspectRatio', EnableUserData: 'true', StartIndex: String(startIndex), Limit: String(limit) });
    if (parentId) query.set('ParentId', parentId);
    if (search.trim()) query.set('SearchTerm', search.trim());
    const result = await jsonRequest(connection, `/Users/${connection.userId}/Items?${query}`);
    if (!Array.isArray(result.Items)) throw failure(502, 'Jellyfin returned an invalid library response.');
    res.json({ items: result.Items.filter(item => validId(item?.Id)).map(normalizeItem), total: Math.max(0, Number(result.TotalRecordCount) || 0), startIndex });
  }));
  router.get('/items/:id', wrap(async (req, res) => {
    const connection = await authenticate(req);
    if (!validId(req.params.id)) throw failure(400, 'Invalid Jellyfin item.');
    const item = await jsonRequest(connection, `/Users/${connection.userId}/Items/${req.params.id}`);
    if (!validId(item?.Id)) throw failure(502, 'Jellyfin returned an invalid item.');
    res.json({ item: normalizeItem(item) });
  }));
  router.get('/images/:id', wrap(async (req, res) => {
    const connection = await authenticate(req);
    if (!validId(req.params.id)) throw failure(400, 'Invalid Jellyfin image.');
    // Jellyfin image endpoints can be public; check this user's library access first.
    await jsonRequest(connection, `/Users/${connection.userId}/Items/${req.params.id}`);
    const response = await checkResponse(await request(connection, `/Items/${req.params.id}/Images/Primary?maxWidth=480&quality=85`), connection);
    const contentType = (response.headers.get('content-type') || '').split(';')[0];
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(contentType)) { await response.body?.cancel(); throw failure(502, 'Jellyfin returned an invalid image.'); }
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    try {
      while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > 8 * 1024 * 1024) { await reader.cancel(); throw failure(502, 'This Jellyfin image is too large.'); } chunks.push(Buffer.from(value)); }
    } finally { reader.releaseLock(); }
    res.set('Content-Type', contentType); res.set('X-Content-Type-Options', 'nosniff'); res.send(Buffer.concat(chunks));
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) { next(error); return; }
    res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: error.type === 'entity.too.large' ? 'The sign-in request is too large.' : 'Send a valid JSON request.' });
  });
  app.use('/api/jellyfin', router);
  const cleanup = setInterval(() => {
    for (const [key, value] of limits) if (value.until <= Date.now()) limits.delete(key);
    for (const [key, value] of pending) if (value.expiresAt <= Date.now()) pending.delete(key);
    let changed = false;
    for (const [key, connection] of connections) if (connection.lastUsed <= Date.now() - idleLifetime) { connections.delete(key); changed ||= connection.remember; }
    if (changed) scheduleSave();
  }, 60000); cleanup.unref();
  return { getConnection, request, close() { clearInterval(cleanup); if (saveTimer) save(); pending.clear(); } };
}

module.exports = { installJellyfinAccounts, validateServerUrl, normalizeItem, upstreamRequest };
