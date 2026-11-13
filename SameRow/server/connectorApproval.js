const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

const approvalSeconds = 600;
const pairingSeconds = 30 * 86400;
const idPattern = /^[a-f0-9]{32}$/;
const secretPattern = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');

function installConnectorApproval(app, { root, config, store, identity }) {
  const tokenFor = (id, claim) =>
    `${id}.${createHmac('sha256', config.encryptionKey).update(`connector-approval:${id}:${claim}`).digest('hex')}`;
  const router = require('express').Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.post('/start', async (req, res) => {
    const { claim } = req.body || {};
    if (typeof claim !== 'string' || !secretPattern.test(claim)) return res.sendStatus(400);
    if (!await store.limit(`connector-approval:start:${req.ip}`, 10, 600)) return res.sendStatus(429);
    const id = randomBytes(16).toString('hex');
    await store.set(`connector:${id}`, { claim, until: Date.now() + approvalSeconds * 1000 }, approvalSeconds);
    res.json({ id });
  });
  router.post('/approve', async (req, res) => {
    const { id } = req.body || {};
    if (typeof id !== 'string' || !idPattern.test(id)) return res.sendStatus(400);
    let user;
    try { user = await identity.verify(req.get('X-SameRow-Token')); }
    catch { return res.sendStatus(401); }
    if (user.connectorId || user.firebase?.sign_in_provider === 'anonymous') return res.sendStatus(403);
    if (!await store.limit(`connector-approval:approve:${user.uid}`, 12, 600)) return res.sendStatus(429);
    try {
      const now = Date.now();
      await store.update(`connector:${id}`, current => {
        if (!current?.claim || current.claimed || current.until <= now) throw Object.assign(new Error(), { status: 410 });
        if (current.ownerUid && current.ownerUid !== user.uid) throw Object.assign(new Error(), { status: 409 });
        return { ...current, ownerUid: user.uid, digest: hash(tokenFor(id, current.claim)) };
      }, pairingSeconds);
      await store.update(`user-connectors:${user.uid}`, current => {
        const list = Array.isArray(current) ? current.filter(x => x.id !== id) : [];
        list.unshift({ id, address: `https://${id}.samerow-connector.invalid`, createdAt: now });
        return list.slice(0, 20);
      }, pairingSeconds);
    } catch (error) {
      if (error.status === 409 || error.status === 410) return res.sendStatus(error.status);
      throw error;
    }
    res.sendStatus(204);
  });
  router.post('/claim', async (req, res) => {
    const { id, secret } = req.body || {};
    if (typeof id !== 'string' || !idPattern.test(id) || typeof secret !== 'string' || !secretPattern.test(secret)) return res.sendStatus(400);
    const claim = hash(secret);
    let record;
    try {
      record = await store.update(`connector:${id}`, current => {
        if (!current?.claim || current.claimed || current.until <= Date.now() ||
            !timingSafeEqual(Buffer.from(current.claim, 'hex'), Buffer.from(claim, 'hex')))
          throw Object.assign(new Error(), { status: 410 });
        return current.digest ? { ...current, claimed: true } : current;
      }, pairingSeconds);
    } catch (error) {
      if (error.status === 410) return res.sendStatus(410);
      throw error;
    }
    if (!record.digest) return res.sendStatus(202);
    res.json({ token: tokenFor(id, claim), gateway: config.mediaOrigin });
  });
  app.use(`${root}/approval`, router);
}

module.exports = { installConnectorApproval };
