const { randomUUID } = require('node:crypto');
const { connectorId } = require('./jellyfinRelay');

const ROOT = '/api/jellyfin-relay/direct';
const TTL = 25;
const uuid = /^[a-f0-9-]{36}$/;
const validSdp = sdp => typeof sdp === 'string' && Buffer.byteLength(sdp) < 24000 && sdp.startsWith('v=0') &&
  (sdp.match(/^m=/gm) || []).length === 1 && /^m=application /m.test(sdp) &&
  (sdp.match(/^a=candidate:/gm) || []).length <= 40;

function installJellyfinDirect(app, io, { config, store, relay, accounts, jellyfin }) {
  const peerKey = id => `direct-peer:${id}`;
  const queueKey = id => `direct-queue:${id}`;
  async function authorizePeer(peer) {
    if (!peer || Date.now() >= peer.authExpires) return null;
    const resolved = await jellyfin.resolveViewer(peer.token, false);
    if (!resolved || connectorId(resolved.state.base) !== peer.connector || !resolved.state.connectionToken) return null;
    const connection = await accounts.getConnection(resolved.state.connectionToken);
    if (connection?.base !== resolved.state.base || connection.apiToken !== resolved.state.apiToken ||
        peer.apiToken && peer.apiToken !== connection.apiToken) return null;
    if ((await store.get(`connector:${peer.connector}`))?.digest !== peer.digest) return null;
    return resolved;
  }
  io.on('connection', socket => {
    let current;
    const close = async () => {
      if (!current) return;
      const old = current;
      current = null;
      await store.set(peerKey(old), null);
    };
    socket.on('disconnect', () => close().catch(() => {}));
    socket.handle('jellyfin-direct-close', async payload => { if (payload?.id === current) await close(); });
    socket.handle('jellyfin-direct-offer', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (!payload || !validSdp(payload.sdp) || !await store.limit(`direct-offers:${socket.data.uid}`, 24, 60)) return ack({ error: 'Direct offer unavailable' });
      const resolved = await jellyfin.resolveViewer(payload.accessToken, false);
      const connector = connectorId(resolved?.state.base);
      if (!connector || resolved.viewer.socketId !== socket.id || resolved.state.id !== payload.sessionId ||
          !await store.get(`direct-online:${connector}`)) return ack({ error: 'Home sender unavailable' });
      const credential = await store.get(`connector:${connector}`);
      if (!credential) return ack({ error: 'Home sender unavailable' });
      const peer = { id: randomUUID(), connector, digest: credential.digest, token: payload.accessToken, authExpires: socket.data.expiresAt };
      if (!await authorizePeer(peer)) return ack({ error: 'Playback access expired' });
      const settings = Object.fromEntries(['audio', 'subtitle', 'original', 'audioCopy', 'bitrate']
        .filter(key => typeof payload.settings?.[key] === 'string' && payload.settings[key].length <= 12)
        .map(key => [key, payload.settings[key]]));
      await close();
      const plan = await jellyfin.planStream(resolved, settings, true);
      if (plan.status) return ack({ status: plan.status, error: plan.error });
      current = peer.id;
      const { state, viewer } = resolved;
      const subtitles = Object.fromEntries(state.subtitleTracks.filter(track => track.text)
        .map(track => [track.index, `/Videos/${state.itemId}/${state.sourceId}/Subtitles/${track.index}/0/Stream.vtt`]));
      await store.set(peerKey(peer.id), { ...peer, sdp: payload.sdp, resource: plan.resource, itemId: state.itemId,
        deviceId: viewer.deviceId, apiToken: state.apiToken, subtitles }, TTL);
      if (!socket.connected) { await close(); return; }
      const now = Date.now();
      await store.update(queueKey(connector), queue => [...(queue || []).filter(entry => entry.until > now).slice(-15),
        { id: peer.id, until: now + 12000 }], TTL);
      ack({ id: peer.id });
    });
    socket.handle('jellyfin-direct-answer', async (payload, ack) => {
      const id = payload?.id;
      if (typeof ack !== 'function' || current !== id || !id) return;
      const answer = await store.get(`direct-answer:${id}`);
      ack(answer || {});
    });
    socket.handle('jellyfin-direct-renew', async (payload, ack) => {
      const id = payload?.id;
      if (typeof ack !== 'function' || current !== id || !id) return;
      const peer = await store.get(peerKey(id));
      const resolved = await authorizePeer(peer && { ...peer, authExpires: socket.data.expiresAt });
      if (!resolved) {
        await close(); return ack({ ok: false });
      }
      await jellyfin.renewDirect(resolved.viewer, resolved.state);
      await store.update(peerKey(id), value => value && { ...value, authExpires: socket.data.expiresAt }, TTL);
      ack({ ok: true });
    });
  });
  if (config.serviceRole === 'control') return;
  app.use(ROOT, async (req, res, next) => {
    const connector = await relay.authenticate(req);
    if (!connector) return res.sendStatus(401);
    if (!await store.limit(`direct-connector:${connector.id}`, 450, 60)) return res.sendStatus(429);
    req.connector = connector.id;
    req.connectorDigest = connector.record.digest;
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get(`${ROOT}/poll`, async (req, res) => {
    const connector = req.connector;
    await store.set(`direct-online:${connector}`, true, 8);
    const now = Date.now();
    if (!(await store.get(queueKey(connector)))?.some(entry => !entry.claim && entry.until > now)) return res.sendStatus(204);
    const claim = randomUUID();
    const entries = await store.update(queueKey(connector), queue => (queue || []).map(entry =>
      entry.until > now && !entry.claim ? { ...entry, claim } : entry)
      .filter(entry => entry.until > now), TTL);
    const offers = [];
    for (const entry of entries.filter(value => value.claim === claim)) {
      const peer = await store.get(peerKey(entry.id));
      if (peer?.connector === connector && peer.digest === req.connectorDigest && await authorizePeer(peer)) {
        const { id, sdp, resource, itemId, deviceId, apiToken, subtitles } = peer;
        offers.push({ id, sdp, resource, itemId, deviceId, apiToken, subtitles });
      }
    }
    res.json(offers);
  });
  app.post(`${ROOT}/answer/:id`, async (req, res) => {
    if (!uuid.test(req.params.id)) return res.sendStatus(404);
    const peer = await store.get(peerKey(req.params.id));
    if (peer?.connector !== req.connector || peer.digest !== req.connectorDigest || !await authorizePeer(peer)) return res.sendStatus(403);
    if (!validSdp(req.body?.sdp)) return res.sendStatus(400);
    await store.set(`direct-answer:${peer.id}`, { sdp: req.body.sdp }, TTL);
    res.sendStatus(204);
  });
  app.post(`${ROOT}/leases`, async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 16 || ids.some(id => typeof id !== 'string' || !uuid.test(id))) return res.sendStatus(400);
    const allowed = await Promise.all(ids.map(async id => {
      const peer = await store.get(peerKey(id));
      return peer?.connector === req.connector && peer.digest === req.connectorDigest && await authorizePeer(peer) ? id : null;
    }));
    res.json(allowed.filter(Boolean));
  });
}

module.exports = { installJellyfinDirect };
