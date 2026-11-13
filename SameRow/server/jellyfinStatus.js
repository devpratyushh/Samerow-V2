const { connectorId } = require('./jellyfinRelay');

// Persistent identity and credentials are deliberately independent of live health.
function installJellyfinStatus(router, { store, readLinks, getConnection, account, request, checkResponse, requireAccount, wrap }) {
  const probes = new Map();
  const probe = connection => {
    const cached = probes.get(connection.token);
    if (cached && cached.until > Date.now()) return cached.promise;
    const promise = (async () => {
      try {
        const response = await request(connection, '/Users/Me', { signal: AbortSignal.timeout(5000), timeoutMs: 5000 });
        await checkResponse(response, connection);
        await response.body?.cancel();
        return { status: 'ready', message: 'Ready to watch from any network.' };
      } catch (error) {
        return error.status === 401 || error.status === 403
          ? { status: 'sign_in_required', message: 'Authorize your Jellyfin user again. Your server pairing is saved.' }
          : error.status === 429 || error.status === 503 || ['TimeoutError', 'AbortError'].includes(error.name)
            ? { status: 'reconnecting', message: 'The relay is reconnecting or busy. Retrying automatically.' }
            : { status: 'jellyfin_unavailable', message: 'The plugin is reachable, but Jellyfin could not answer. Check Jellyfin on your server.' };
      }
    })();
    if (probes.size >= 500) probes.delete(probes.keys().next().value);
    probes.set(connection.token, { until: Date.now() + 10000, promise });
    return promise;
  };
  router.get('/preferences', wrap(async (req, res) => { const uid = requireAccount(req); res.json(store ? await store.get(`jellyfin-preferences:${uid}`) || {} : {}); }));
  router.post('/preferences', require('express').json({ limit: '2kb' }), wrap(async (req, res) => {
    const uid = requireAccount(req), id = req.body?.defaultServerId;
    const entries = store ? await store.get(`user-connectors:${uid}`) : [];
    const links = await readLinks(uid);
    const saved = (await Promise.all((Array.isArray(links) ? links : []).map(getConnection))).some(connection => connection?.ownerUid === uid && (connection.serverId || connection.base) === id);
    const record = typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? await store?.get(`connector:${id}`) : null;
    if (!saved && (!record || record.ownerUid !== uid || !entries?.some(entry => entry.id === id))) return res.status(404).json({ error: 'Choose a server paired with your account.' });
    await store.set(`jellyfin-preferences:${uid}`, { defaultServerId: id }, 0);
    res.sendStatus(204);
  }));
  router.get('/status', wrap(async (req, res) => {
    const uid = requireAccount(req), checkedAt = Date.now();
    const links = await readLinks(uid);
    const connections = (await Promise.all((Array.isArray(links) ? links.slice(0, 20) : []).map(getConnection)))
      .filter(value => value?.ownerUid === uid && value.accountLinked);
    const entries = store ? await store.get(`user-connectors:${uid}`) : [];
    if (store) await store.touch(`user-connectors:${uid}`, 0);
    const rows = [];
    await Promise.all((Array.isArray(entries) ? entries.slice(0, 20) : []).map(async entry => {
      const record = await store.get(`connector:${entry.id}`);
      if (record?.ownerUid !== uid) return;
      await store.touch(`connector:${entry.id}`, 0);
      const connection = connections.find(value => connectorId(value.base) === entry.id);
      rows.push({ id: entry.id, address: entry.address, name: connection?.serverName || entry.name || `Jellyfin ${entry.id.slice(0, 8)}`,
        account: connection ? account(connection) : null, bound: !!connection, sameRowEmail: req.identity.email || record.ownerEmail || '',
        lastSeen: await store.get(`connector-seen:${entry.id}`), checkedAt,
        ...(!await store.get(`connector-online:${entry.id}`)
          ? { status: 'offline', message: 'Start Jellyfin and SameRow Connect on your home server. Your binding is saved.' }
          : !connection || connection.authInvalid
            ? { status: 'sign_in_required', message: 'Connect your Jellyfin user. Your server pairing is saved.' }
            : await probe(connection)) });
    }));
    for (const connection of connections.filter(value => !connectorId(value.base))) {
      rows.push({ id: connection.serverId || connection.base, address: connection.base, name: connection.serverName, account: account(connection), bound: true,
        sameRowEmail: req.identity.email || connection.sameRowEmail || '', checkedAt, lastSeen: null,
        ...(connection.authInvalid ? { status: 'sign_in_required', message: 'Authorize your Jellyfin user again.' } : await probe(connection)) });
    }
    res.json({ servers: rows, checkedAt, defaultServerId: store ? (await store.get(`jellyfin-preferences:${uid}`))?.defaultServerId || null : null });
  }));
}
module.exports = { installJellyfinStatus };
