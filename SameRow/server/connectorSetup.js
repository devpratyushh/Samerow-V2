const { createHash, randomBytes } = require('node:crypto');
const { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } = require('node:fs');
const path = require('node:path');
const { installLocalHostSession, localHostOnly, pairingTokenPattern } = require('./connectorHost');
const { startJellyfinConnector } = require('./jellyfinConnector');
const { validateServerUrl } = require('./jellyfinAccounts');

function installConnectorSetup(app, settings, env = process.env, { request = fetch, startWorker = startJellyfinConnector } = {}) {
  const directory = path.resolve(env.SAMEROW_DATA_DIR || path.join(__dirname, '.data'));
  const file = path.join(directory, 'connector-pairing.json');
  const policy = { origins: settings.upstreamOrigins };
  const root = '/api/connector-host';
  let pairing, pending, stopWorker = () => {};

  function activate(value) {
    if (!pairingTokenPattern.test(value.token) || new URL(value.gateway).origin !== value.gateway ||
        !value.gateway.startsWith('https://')) throw new Error('Invalid connector settings.');
    const stop = startWorker({
      SAMEROW_CONNECTOR_TOKEN: value.token,
      SAMEROW_CONNECTOR_GATEWAY: value.gateway,
      SAMEROW_CONNECTOR_JELLYFIN_URL: value.jellyfinUrl,
      JELLYFIN_ALLOWED_ORIGINS: settings.upstreamOrigins.join(','),
    });
    stopWorker();
    stopWorker = stop;
    pairing = value;
  }

  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.controlOrigin === settings.controlOrigin && saved.webOrigin === settings.webOrigin) activate(saved);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not restore the SameRow connector. Reconnect it from the lobby.');
  }
  if (!pairing && env.SAMEROW_CONNECTOR_TOKEN) {
    activate({ token: env.SAMEROW_CONNECTOR_TOKEN, gateway: env.SAMEROW_CONNECTOR_GATEWAY, jellyfinUrl: settings.jellyfinUrl });
  }

  const call = (step, body) => request(`${settings.controlOrigin}/api/jellyfin-relay/approval/${step}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  const unavailable = res => res.status(503).json({ error: 'SameRow Web could not finish connecting. Try again.' });
  installLocalHostSession(app, { ...settings, getPairing: () => pairing }, request);
  app.post(`${root}/start`, localHostOnly, async (req, res) => {
    let jellyfinUrl;
    try { jellyfinUrl = validateServerUrl(req.body?.jellyfinUrl || settings.jellyfinUrl, policy); }
    catch { return res.status(400).json({ error: 'Enter the Jellyfin address allowed by your Docker settings.' }); }
    try {
      const secret = randomBytes(32).toString('hex');
      const claim = createHash('sha256').update(secret).digest('hex');
      const response = await call('start', { claim });
      if (!response.ok) { await response.body?.cancel(); return unavailable(res); }
      const { id } = await response.json();
      if (!/^[a-f0-9]{32}$/.test(id)) return unavailable(res);
      pending = { id, secret, jellyfinUrl };
      const url = new URL(settings.webOrigin);
      url.hash = new URLSearchParams({ connector: id, return: req.get('Origin') }).toString();
      res.json({ approvalUrl: url.href });
    } catch { return unavailable(res); }
  });
  app.post(`${root}/complete`, localHostOnly, async (req, res) => {
    const attempt = pending;
    if (!attempt || attempt.id !== req.body?.id) {
      if (pairing?.token.split('.')[0] === req.body?.id) return res.sendStatus(204);
      return res.status(410).json({ error: 'Start a new connection from this Docker app.' });
    }
    try {
      const response = await call('claim', { id: attempt.id, secret: attempt.secret });
      if (response.status === 202 || response.status === 410) {
        await response.body?.cancel();
        return res.status(410).json({ error: 'The approval is missing or has expired. Connect again.' });
      }
      if (!response.ok) { await response.body?.cancel(); return unavailable(res); }
      const { token, gateway } = await response.json();
      if (pending !== attempt) return res.status(409).json({ error: 'A newer connection attempt was started. Try again.' });
      const value = { token, gateway, jellyfinUrl: attempt.jellyfinUrl, controlOrigin: settings.controlOrigin, webOrigin: settings.webOrigin };
      if (!pairingTokenPattern.test(token) || !token.startsWith(`${attempt.id}.`) ||
          new URL(gateway).origin !== gateway || !gateway.startsWith('https://')) return unavailable(res);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        renameSync(temp, file);
      } finally { rmSync(temp, { force: true }); }
      activate(value);
      pending = null;
      res.sendStatus(204);
    } catch { return unavailable(res); }
  });
  return () => stopWorker();
}

module.exports = { installConnectorSetup };
