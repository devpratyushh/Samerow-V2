const { createHash, createHmac, randomBytes } = require('node:crypto');
const { PassThrough, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { connectorUid, issueHostSession } = require('./connectorHost');

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

function installJellyfinRelay(app, { config, store, identity }) {
  if (!config.jellyfinRelay) return null;
  const polls = new Map(), queues = new Map(), jobs = new Map(), active = new Map();
  let queued = 0;
  const onMedia = config.serviceRole !== 'control';
  const internalToken = createHmac('sha256', config.encryptionKey).update('samerow jellyfin relay v1').digest('hex');

  async function authenticate(req) {
    const token = /^Bearer ([a-f0-9]{32}\.[a-f0-9]{64})$/.exec(req.get('authorization') || '')?.[1];
    if (!token) return null;
    const id = token.split('.')[0], record = await store.get(`connector:${id}`);
    return record?.digest === hash(token) ? id : null;
  }

  app.post(`${ROOT}/pair`, async (req, res) => {
    let user;
    try { user = await identity.verify(req.get('X-SameRow-Token')); }
    catch { return res.sendStatus(401); }
    if (user.connectorId || user.firebase?.sign_in_provider === 'anonymous') return res.sendStatus(403);
    if (!await store.limit(`connector-pair:${user.uid}`, 5, 3600)) return res.sendStatus(429);
    const id = random(16), token = `${id}.${random(32)}`;
    await store.set(`connector:${id}`, { ownerUid: user.uid, digest: hash(token) }, 30 * 86400);
    res.set('Cache-Control', 'no-store').json({ token, address: `https://${id}${suffix}`, gateway: config.mediaOrigin });
  });

  app.delete(`${ROOT}/pair/:id`, async (req, res) => {
    let user;
    try { user = await identity.verify(req.get('X-SameRow-Token')); }
    catch { return res.sendStatus(401); }
    const id = req.params.id;
    if (!/^[a-f0-9]{32}$/.test(id)) return res.sendStatus(404);
    const record = await store.get(`connector:${id}`);
    if (record?.ownerUid !== user.uid) return res.sendStatus(404);
    await store.set(`connector:${id}`, null);
    res.sendStatus(204);
  });

  async function authorize(base, uid) {
    const id = connectorId(base);
    if (uid?.startsWith('connector:') && (!id || uid !== connectorUid(id))) {
      throw Object.assign(new Error('Use the Jellyfin library paired to this connector.'), { status: 403 });
    }
    if (!id) return false;
    const record = await store.get(`connector:${id}`);
    if (!record || (record.ownerUid !== uid && connectorUid(id) !== uid)) throw Object.assign(new Error('This connector is not paired to your SameRow account.'), { status: 403 });
    return true;
  }

  if (onMedia) {
    app.post(`${ROOT}/host-session`, async (req, res) => {
      const id = await authenticate(req);
      if (!id) return res.sendStatus(401);
      if (!await store.limit(`connector-host-session:${id}`, 12, 60)) return res.sendStatus(429);
      res.set('Cache-Control', 'no-store').json(await issueHostSession(store, id));
    });
    app.get(`${ROOT}/poll`, async (req, res) => {
      const id = await authenticate(req);
      if (!id) return res.sendStatus(401);
      if (res.destroyed) return;
      const next = queues.get(id)?.values().next().value;
      if (next) return next.send(res);
      const available = polls.get(id) || new Set();
      if (available.size >= 8 || (!polls.has(id) && polls.size >= 500)) return res.sendStatus(429);
      polls.set(id, available);
      available.add(res);
      const timeout = setTimeout(() => res.sendStatus(204), 18000);
      res.on('close', () => {
        clearTimeout(timeout);
        available.delete(res);
        if (!available.size && polls.get(id) === available) polls.delete(id);
      });
    });

    app.post(`${ROOT}/response/:job`, async (req, res) => {
      const job = jobs.get(req.params.job);
      if (!job || job.id !== await authenticate(req) || job.received || !jobs.has(req.params.job)) return res.sendStatus(404);
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
          response.json({ ...payload, job: key });
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
    for (const available of polls.values()) for (const response of available) response.sendStatus(503);
    for (const queue of queues.values()) for (const entry of queue) entry.cancel();
    for (const job of jobs.values()) job.cancel();
    for (const stream of active.keys()) stream.destroy();
  } };
}

module.exports = { installJellyfinRelay, connectorId, ROOT, responseFields, pick };
