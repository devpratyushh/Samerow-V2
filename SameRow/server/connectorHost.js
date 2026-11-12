const { createHash, randomBytes } = require('node:crypto');

const hostOrigins = ['http://localhost:8080', 'http://127.0.0.1:8080'];
const hostSessionSeconds = 600;
const connectorUid = id => `connector:${id}`;
const sessionKey = token => `connector-host:${createHash('sha256').update(token).digest('hex')}`;
const sessionPattern = /^srhost\.[a-f0-9]{64}$/;
const pairingTokenPattern = /^[a-f0-9]{32}\.[a-f0-9]{64}$/;

function localHostOnly(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const origin = req.get('Origin');
  if (!hostOrigins.includes(origin) || new URL(origin).host !== req.get('Host') ||
      req.get('X-SameRow-Local-Host') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site') {
    return res.sendStatus(403);
  }
  next();
}

async function issueHostSession(store, id) {
  const token = `srhost.${randomBytes(32).toString('hex')}`;
  const exp = Math.floor(Date.now() / 1000) + hostSessionSeconds;
  await store.set(sessionKey(token), { id, exp }, hostSessionSeconds);
  return { token, exp };
}

function withConnectorHostIdentity(identity, store) {
  return { ...identity, async verify(token) {
    if (!sessionPattern.test(typeof token === 'string' ? token : '')) {
      const user = await identity.verify(token);
      if (user.uid.startsWith('connector:')) throw new Error('Invalid room identity.');
      return user;
    }
    const session = await store.get(sessionKey(token));
    if (!session || session.exp <= Date.now() / 1000 || !await store.get(`connector:${session.id}`)) {
      throw new Error('Connector session expired or was revoked.');
    }
    return { uid: connectorUid(session.id), connectorId: session.id, exp: session.exp };
  } };
}

function installLocalHostSession(app, settings, request = fetch) {
  if (!settings) return;
  app.post('/api/connector-host/session', localHostOnly, async (req, res) => {
    const pairing = settings.getPairing ? settings.getPairing() : settings;
    if (!pairing) return res.status(428).json({ error: 'Connect this Docker app to SameRow Web.' });
    try {
      const response = await request(`${pairing.gateway}/api/jellyfin-relay/host-session`, {
        method: 'POST', headers: { Authorization: `Bearer ${pairing.token}` },
        redirect: 'error', signal: AbortSignal.timeout(70000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) return res.status(401).json({ error: 'This connection has expired. Connect to SameRow Web again.' });
        return res.status(503).json({ error: 'The online host service is unavailable. Try again shortly.' });
      }
      const { token } = await response.json();
      if (typeof token !== 'string' || !sessionPattern.test(token)) throw new Error('Invalid session response.');
      res.json({
        token,
        controlOrigin: settings.controlOrigin,
        webOrigin: settings.webOrigin,
        jellyfinAddress: `https://${pairing.token.split('.')[0]}.samerow-connector.invalid`,
      });
    } catch {
      res.status(503).json({ error: 'Could not reach SameRow Web. Try again shortly.' });
    }
  });
}

module.exports = { connectorUid, hostOrigins, issueHostSession, withConnectorHostIdentity, installLocalHostSession, localHostOnly, pairingTokenPattern };
