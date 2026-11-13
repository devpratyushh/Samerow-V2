const { createHash, createHmac, randomBytes } = require('node:crypto');
const { PassThrough, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { installConnectorApproval } = require('./connectorApproval');

const ROOT = '/api/jellyfin-relay';
const suffix = '.samerow-connector.invalid';
const hash = value => createHash('sha256').update(value).digest('hex');
const random = bytes => randomBytes(bytes).toString('hex');
const unavailable = () => Object.assign(new Error('The Jellyfin connector is offline or busy.'), { status: 503 });
const responseFields = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
const pick = (headers, fields) => Object.fromEntries(fields.filter(key => headers.has(key)).map(key => [key, headers.get(key)]));

function connectorId(base) {
  const match = /^https:\/\/([a-f0-9]{32})\.samerow-connector\.invalid$/.exec(base);
  return match?.[1];
}

function installJellyfinRelay(app, { config, store, identity, io }) {
  if (!config.jellyfinRelay) return null;
  const polls = new Map(), queues = new Map(), jobs = new Map(), active = new Map();
  let queued = 0;
  const onMedia = config.serviceRole !== 'control';
  const internalToken = createHmac('sha256', config.encryptionKey).update('samerow jellyfin relay v1').digest('hex');
  if (config.serviceRole !== 'media') installConnectorApproval(app, { root: ROOT, config, store, identity });
  const abortConnector = id => {
    for (const response of polls.get(id) || []) response.sendStatus(401);
    for (const entry of queues.get(id) || []) entry.cancel();
    for (const job of jobs.values()) if (job.id === id) job.cancel();
    for (const [stream, details] of active) if (details.connector === id) stream.destroy();
  };
  io?.on('connector-revoked', abortConnector);

  async function authenticate(req) {
    const token = /^Bearer ([a-f0-9]{32}\.[a-f0-9]{64})$/.exec(req.get('authorization') || '')?.[1];
    if (!token) return null;
    const id = token.split('.')[0], record = await store.get(`connector:${id}`);
    return record?.digest === hash(token) ? { id, record } : null;
  }

  app.delete(`${ROOT}/pair/:id`, async (req, res) => {
    let user;
    const connector = await authenticate(req);
    try { user = connector?.id === req.params.id ? { uid: connector.record.ownerUid } : await identity.verify(req.get('X-SameRow-Token')); }
    catch { return res.sendStatus(401); }
    const id = req.params.id;
    if (!/^[a-f0-9]{32}$/.test(id)) return res.sendStatus(404);
    const record = await store.get(`connector:${id}`);
    if (record?.ownerUid !== user.uid) return res.sendStatus(404);
    await store.set(`connector:${id}`, null);
    await store.set(`connector-online:${id}`, null);
    await store.set(`connector-seen:${id}`, null);
    abortConnector(id);
    if (store.client) io?.serverSideEmit('connector-revoked', id);
    await store.update(`user-connectors:${user.uid}`, current => {
      return Array.isArray(current) ? current.filter(x => x.id !== id) : [];
    }, 0);
    res.sendStatus(204);
  });

  const indexedAt = new Map();
  async function ensureIndexed(id, record) {
    if (!record.ownerUid || (indexedAt.get(id) || 0) > Date.now() - 60000) return;
    const result = await store.guardedUpdate(`connector:${id}`, record, `user-connectors:${record.ownerUid}`, current => {
      const entries = Array.isArray(current) ? current : [];
      return [{ ...entries.find(entry => entry.id === id), id, address: `https://${id}${suffix}`, createdAt: record.createdAt || Date.now() }, ...entries.filter(entry => entry.id !== id)].slice(0, 20);
    }, 0);
    if (result) { if (indexedAt.size >= 500) indexedAt.delete(indexedAt.keys().next().value); indexedAt.set(id, Date.now()); }
  }
  app.get(`${ROOT}/connectors/:id`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let user;
    try { user = await identity.verify(req.get('X-SameRow-Token')); } catch { return res.sendStatus(401); }
    const id = req.params.id;
    if (!/^[a-f0-9]{32}$/.test(id)) return res.sendStatus(404);
    const record = await store.get(`connector:${id}`);
    if (!record || !record.ownerUid || record.ownerUid !== user.uid) return res.sendStatus(404);
    await ensureIndexed(id, record);
    res.json({ connector: { id, address: `https://${id}${suffix}`, online: Boolean(await store.get(`connector-online:${id}`)) } });
  });

  app.get(`${ROOT}/account-binding`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const connector = await authenticate(req);
    if (!connector) return res.sendStatus(401);
    await ensureIndexed(connector.id, connector.record);
    const uid = connector.record.ownerUid;
    const tokens = await store.get(`jellyfin-links:${uid}`);
    let bound = null, email = connector.record.ownerEmail || '';
    for (const token of Array.isArray(tokens) ? tokens.slice(0, 20) : []) {
      const connection = await store.get(`account:${token}`);
      if (connection?.ownerUid === uid && connection.accountLinked && connectorId(connection.base) === connector.id) {
        email ||= connection.sameRowEmail || '';
        bound = { userName: connection.userName, serverName: connection.serverName };
        break;
      }
    }
    if (!email && uid && identity.describe) {
      try {
        email = (await identity.describe(uid)).email || '';
        if (email) await store.update(`connector:${connector.id}`, current => current?.ownerUid === uid ? { ...current, ownerEmail: email } : current, 0);
      } catch { /* Binding remains usable if profile lookup is unavailable. */ }
    }
    res.json({ sameRowEmail: email, jellyfinAccount: bound });
  });

  app.get(`${ROOT}/connectors`, async (req, res) => {
    let user;
    try { user = await identity.verify(req.get('X-SameRow-Token')); }
    catch { return res.sendStatus(401); }
    const list = await store.get(`user-connectors:${user.uid}`);
    const result = [];
    if (Array.isArray(list)) {
      for (const entry of list) {
        const record = await store.get(`connector:${entry.id}`);
        if (record && record.ownerUid === user.uid) {
          await store.touch(`connector:${entry.id}`, 0);
          const online = Boolean(await store.get(`connector-online:${entry.id}`));
          result.push({ ...entry, online, lastSeen: await store.get(`connector-seen:${entry.id}`) });
        }
      }
    }
    res.set('Cache-Control', 'no-store').json({ connectors: result });
  });

  app.post(`${ROOT}/rotate`, async (req, res) => {
    const oldToken = /^Bearer ([a-f0-9]{32}\.[a-f0-9]{64})$/.exec(req.get('authorization') || '')?.[1];
    const nextToken = req.body?.token;
    if (!oldToken || typeof nextToken !== 'string' || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(nextToken) ||
        oldToken.split('.')[0] !== nextToken.split('.')[0]) return res.sendStatus(400);
    const id = oldToken.split('.')[0];
    try {
      await store.update(`connector:${id}`, current => {
        if (!current?.ownerUid || ![hash(oldToken), hash(nextToken)].includes(current.digest)) {
          throw Object.assign(new Error(), { status: 401 });
        }
        // The proposed token is generated and saved by the connector first.
        // Retrying a lost response therefore cannot strand its credential.
        return { ...current, digest: hash(nextToken), rotatedAt: Date.now() };
      }, 0);
    } catch (error) {
      if (error.status === 401) return res.sendStatus(401);
      throw error;
    }
    res.set('Cache-Control', 'no-store').sendStatus(204);
  });

  async function authorize(base, uid) {
    const id = connectorId(base);
    if (!id) return false;
    const record = await store.get(`connector:${id}`);
    if (!record || record.ownerUid !== uid) throw Object.assign(new Error('This connector is not paired to your SameRow account.'), { status: 403 });
    return true;
  }

  if (onMedia) {
    app.get(`${ROOT}/poll`, async (req, res) => {
      const authenticated = await authenticate(req);
      const id = authenticated?.id;
      if (!id) return res.sendStatus(401);
      await store.touch(`connector:${id}`, 0);
      await ensureIndexed(id, authenticated.record);
      if (res.destroyed) return;
      const available = polls.get(id) || new Set();
      if (available.size >= 8 || (!polls.has(id) && polls.size >= 500)) return res.sendStatus(429);
      // Register before awaiting heartbeat writes so simultaneous polls share one set.
      polls.set(id, available);
      available.add(res);
      const timeout = setTimeout(() => { if (!res.writableEnded) res.sendStatus(204); }, 18000);
      res.on('close', () => {
        clearTimeout(timeout);
        available.delete(res);
        if (!available.size && polls.get(id) === available) polls.delete(id);
      });
      const now = Date.now();
      await store.set(`connector-online:${id}`, { lastSeen: now }, 30);
      await store.set(`connector-seen:${id}`, now, 0);
      if (res.destroyed || res.writableEnded) return;
      const next = queues.get(id)?.values().next().value;
      if (next) { available.delete(res); return next.send(res); }
    });

    app.post(`${ROOT}/response/:job`, async (req, res) => {
      const job = jobs.get(req.params.job);
      if (!job || job.id !== (await authenticate(req))?.id || job.received || !jobs.has(req.params.job)) return res.sendStatus(404);
      let headers, status;
      try {
        status = Number(req.get('x-relay-status'));
        headers = pick(new Headers(JSON.parse(req.get('x-relay-headers') || '{}')), responseFields);
        if (!Number.isInteger(status) || status < 200 || status > 599 || (status >= 300 && status < 400)) throw Error();
      } catch { return res.sendStatus(400); }
      job.received = true;
      if (job.method === 'HEAD' || [204, 205].includes(status)) {
        delete headers['content-length'];
        job.resolve(new Response(null, { status, headers }));
        req.resume();
        res.sendStatus(204);
        return;
      }
      if (active.size >= 1000 || [...active.values()].filter(stream => stream.connector === job.id).length >= 8) {
        job.cancel();
        return res.sendStatus(429);
      }
      const stream = new PassThrough({ highWaterMark: 64 * 1024 });
      active.set(stream, { connector: job.id });
      req.setTimeout(30000, () => req.destroy());
      const abort = () => stream.destroy();
      job.signal.addEventListener('abort', abort, { once: true });
      if (job.signal.aborted) abort();
      const body = Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } });
      job.resolve(new Response(body, { status, headers }));
      try { await pipeline(req, stream); res.sendStatus(204); }
      catch { res.destroy(); }
      finally { active.delete(stream); job.signal.removeEventListener('abort', abort); }
    });

    app.post(`${ROOT}/request`, async (req, res) => {
      if (req.get('authorization') !== `Bearer ${internalToken}`) return res.sendStatus(401);
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      try {
        const response = await dispatch(req.body, controller.signal);
        res.status(response.status).set(Object.fromEntries(response.headers));
        if (response.body) await pipeline(Readable.fromWeb(response.body), res);
        else res.end();
      } catch (error) {
        if (!res.headersSent && !res.destroyed) res.sendStatus(error.status || 503);
        else res.destroy();
      }
    });
  }

  async function dispatch(payload, signal) {
    if (payload?.protocolVersion !== undefined && payload.protocolVersion !== 1) {
      throw Object.assign(new Error('Unsupported connector protocol.'), { status: 400 });
    }
    const id = connectorId(payload?.base);
    if (!id || !await store.get(`connector:${id}`) || signal.aborted || jobs.size >= 2000) throw unavailable();
    const available = polls.get(id);
    const waiting = available?.values().next().value;
    const queue = queues.get(id) || new Set();
    if (!waiting && (queued >= 1000 || queue.size >= 64)) throw unavailable();
    const key = random(16);
    return new Promise((resolve, reject) => {
      const unqueue = () => {
        if (queue.delete(entry)) queued--;
        if (!queue.size && queues.get(id) === queue) queues.delete(id);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        jobs.delete(key);
        unqueue();
      };
      const cancel = () => { cleanup(); reject(signal.reason || unavailable()); };
      const timer = setTimeout(cancel, waiting ? 20000 : 12000);
      const entry = {
        cancel,
        send(response) {
          unqueue();
          jobs.set(key, { id, signal, method: payload.method, resolve(value) { cleanup(); resolve(value); }, cancel });
          response.json({ ...payload, protocolVersion: 1, job: key });
        },
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (waiting) {
        available.delete(waiting);
        entry.send(waiting);
      } else {
        queue.add(entry);
        queues.set(id, queue);
        queued++;
      }
    });
  }

  async function request(connection, resource, options) {
    const signal = options.signal || new AbortController().signal;
    const payload = {
      base: connection.base,
      resource,
      method: options.method || 'GET',
      headers: pick(new Headers(options.headers), ['range', 'if-range', 'content-type', 'accept']),
      body: options.body,
      apiToken: connection.apiToken,
      deviceId: connection.deviceId,
    };
    if (onMedia) return dispatch(payload, signal);
    const response = await fetch(`${config.mediaOrigin}${ROOT}/request`, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${internalToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status === 503) { await response.body?.cancel(); throw unavailable(); }
    return response;
  }

  return { authorize, request, close() {
    io?.off('connector-revoked', abortConnector);
    for (const available of polls.values()) for (const response of available) response.sendStatus(503);
    for (const queue of queues.values()) for (const entry of queue) entry.cancel();
    for (const job of jobs.values()) job.cancel();
    for (const stream of active.keys()) stream.destroy();
  } };
}

module.exports = { installJellyfinRelay, connectorId, ROOT, responseFields, pick };
