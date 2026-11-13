const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MemoryStore } = require('./store');
const { createQualityPolicy, qualityModes } = require('./jellyfinQuality');
const { readText, readJson } = require('./upstreamBody');
const { connectorId } = require('./jellyfinRelay');
const { upstreamRequest, validateServerUrl } = require('./jellyfinAccounts');

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const token = () => randomBytes(24).toString('hex');
const position = (state, now = Date.now()) => Math.min(state.duration, Math.max(0, state.timestamp + (state.playing ? (now - state.updatedAt) / 1000 : 0)));
const trackInfo = stream => ({ index: stream.Index, title: stream.DisplayTitle || stream.Title || stream.Language || `${stream.Type} ${stream.Index}`, language: stream.Language || '', codec: stream.Codec, channels: stream.Channels, text: stream.IsTextSubtitle !== false && !['pgssub', 'dvdsub', 'dvbsub'].includes(stream.Codec), default: !!stream.IsDefault });

function installJellyfin(app, io, accounts, options = {}) {
  const store = options.store || new MemoryStore(), roomTtl = options.roomTtl || 86400;
  const pending = new Map(), activeRequests = new Map();
  const quality = createQualityPolicy(store, options.quality);
  const delivery = require('./deliveryStats').createDeliveryStats(store);
  const request = accounts?.request || upstreamRequest;
  const member = (socket, roomId) => typeof roomId === 'string' && socket.rooms.has(roomId);
  const permitted = (socket, roomId) => options.canControl ? options.canControl(socket, roomId) : member(socket, roomId);
  const snapshot = state => ({ sessionId: state.id, native: !!state.connectionToken, itemId: state.itemId, title: state.title, duration: state.duration, audioTracks: state.audioTracks, subtitleTracks: state.subtitleTracks, playing: state.playing, timestamp: position(state), updatedAt: Date.now(), revision: state.revision });
  const requestsFor = viewer => {
    let active = activeRequests.get(viewer.token);
    if (!active) { active = { sessionId: viewer.sessionId, requests: new Set() }; activeRequests.set(viewer.token, active); }
    return active.requests;
  };
  const accessFor = async (socket, roomId, state) => {
    const key = `viewer-index:${roomId}:${socket.id}:${state.id}`;
    const accessToken = await store.update(key, value => value || token(), roomTtl);
    await store.update(`viewer:${accessToken}`, value => value || { token: accessToken, socketId: socket.id, roomId, sessionId: state.id, playSessionId: null, deviceId: randomUUID() }, roomTtl);
    await quality.renew({ token: accessToken }, state);
    return accessToken;
  };
  const saveViewer = async (viewer, patch) => {
    await store.update(`viewer:${viewer.token}`, current => current ? { ...current, ...patch } : null, roomTtl);
    Object.assign(viewer, patch);
  };
  const stopEncoding = (viewer, state) => {
    if (!viewer.playSessionId || !state) return;
    const query = new URLSearchParams({ DeviceId: viewer.deviceId, PlaySessionId: viewer.playSessionId });
    request({ base: state.base, apiToken: state.apiToken, deviceId: viewer.deviceId }, `/Videos/ActiveEncodings?${query}`, { method: 'DELETE', timeoutMs: 5000 }).then(response => response.body?.cancel()).catch(() => {});
  };
  const abortSession = sessionId => {
    for (const [key, value] of activeRequests) if (value.sessionId === sessionId) {
      value.requests.forEach(controller => controller.abort()); activeRequests.delete(key);
    }
  };
  io.on('jellyfin-revoke', abortSession);
  const revoke = state => {
    if (!state) return;
    abortSession(state.id);
    if (options.store?.client) io.serverSideEmit('jellyfin-revoke', state.id);
  };
  const publish = async (roomId, state) => {
    const sockets = await io.in(roomId).fetchSockets();
    await Promise.all(sockets.map(async socket => socket.emit('jellyfin-sync', state && !state.stopped ? { ...snapshot(state), accessToken: await accessFor(socket, roomId, state) } : null, { revision: state?.revision })));
  };
  io.on('connection', socket => {
    const on = socket.handle || socket.on.bind(socket);
    on('jellyfin-playback-stats', async (payload = {}) => {
      if (!member(socket, payload.roomId)) return;
      const state = await store.get(`jellyfin-room:${payload.roomId}`);
      if (state && !state.stopped && state.id === payload.sessionId) await delivery.report(state, socket.id, payload.stats);
    });
    on('jellyfin-stats', async (roomId, ack) => {
      if (!member(socket, roomId) || typeof ack !== 'function') return;
      const state = await store.get(`jellyfin-room:${roomId}`);
      ack(state && !state.stopped ? await delivery.snapshot(state, await io.in(roomId).fetchSockets()) : null);
    });
    on('jellyfin-sync-request', async (roomId, ack) => {
      if (!member(socket, roomId) || typeof ack !== 'function') return;
      const serverReceivedAt = Date.now();
      let state = await store.get(`jellyfin-room:${roomId}`);
      if (state?.connectionToken && !await accounts?.getConnection(state.connectionToken)) {
        const expiredId = state.id;
        await store.update(`jellyfin-room:${roomId}`, current => current?.id === expiredId ? { id: null, stopped: true, revision: current.revision + 1 } : current, roomTtl);
        revoke(state); state = await store.get(`jellyfin-room:${roomId}`);
      }
      ack({ revision: state?.revision, state: state && !state.stopped ? { ...snapshot(state), accessToken: await accessFor(socket, roomId, state) } : null, serverReceivedAt, serverSentAt: Date.now() });
    });
    on('jellyfin-open', async (payload = {}, ack = () => {}) => {
      if (typeof ack !== 'function' || !payload || !member(socket, payload.roomId) || !await permitted(socket, payload.roomId)) return;
      const { roomId, itemId } = payload;
      const connection = payload.connectionToken && await accounts?.getConnection(payload.connectionToken);
      if (payload.connectionToken && (!connection || connection.ownerUid && connection.ownerUid !== socket.data.uid)) { ack({ error: 'Your Jellyfin connection expired. Sign in again from the library.' }); return; }
      if (options.production && !connection) { ack({ error: 'Sign in to your Jellyfin library first.' }); return; }
      if (connectorId(connection?.base)) {
        const room = await store.get(`room:${roomId}`);
        if (!room?.invite || room.ownerUid !== socket.data.uid) {
          ack({ error: 'Create a private web room to share from your Docker connector.' });
          return;
        }
      }
      let base, apiToken;
      try {
        base = connection?.base || validateServerUrl(payload.serverUrl, options.networkPolicy);
        apiToken = connection?.apiToken || payload.apiToken;
        if (typeof itemId !== 'string' || !idPattern.test(itemId) || typeof apiToken !== 'string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(apiToken)) throw new Error();
      } catch { ack({ error: 'Choose a video from a connected Jellyfin library.' }); return; }
      pending.get(roomId)?.abort();
      const controller = new AbortController(), operation = token();
      pending.set(roomId, controller);
      await store.set(`jellyfin-pending:${roomId}`, operation, 60);
      const timeout = setTimeout(() => controller.abort(), 20000);
      // Release the socket's ordered event queue after reserving this operation.
      // Cancel/replace commands must be able to interrupt slow upstream I/O.
      void (async () => {
        try {
          const origin = connection || { base, apiToken, deviceId: 'samerow' };
          const get = async resource => {
            const response = await request(origin, resource, { signal: controller.signal });
            if (!response.ok) { await response.body?.cancel(); throw new Error('Jellyfin could not load this video. Reconnect your library and try again.'); }
            return readJson(response);
          };
          const data = await get(connection ? `/Users/${connection.userId}/Items/${itemId}` : `/Items?${new URLSearchParams({ Ids: itemId, Fields: 'MediaSources,MediaStreams' })}`);
          const item = connection ? data : data.Items?.[0];
          let sources = item?.MediaSources;
          if (item && !sources?.length) sources = (await get(`/Items/${itemId}/PlaybackInfo${connection ? `?UserId=${connection.userId}` : ''}`)).MediaSources;
          if (connection && !Array.isArray((await get('/web/config.json')).plugins)) throw new Error('Enable Jellyfin Web on this server.');
          const source = sources?.find(value => idPattern.test(value.Id));
          if (!item || !source) throw new Error('No playable video was found for this item.');
          if (controller.signal.aborted || !member(socket, roomId) || await store.get(`jellyfin-pending:${roomId}`) !== operation) { ack({ error: 'Playback selection was cancelled or replaced.' }); return; }
          const streams = source.MediaStreams || item.MediaStreams || [], duration = Number(source.RunTimeTicks || item.RunTimeTicks) / 10000000;
          if (!Number.isFinite(duration) || duration <= 0) throw new Error('This item has no playable video duration.');
          const old = await store.get(`jellyfin-room:${roomId}`);
          let state = { id: randomUUID(), base, apiToken, connectionToken: connection?.token, item: { ...item, MediaSources: sources }, itemId, sourceId: source.Id, sourceIds: sources.map(value => value.Id), title: item.Name || 'Jellyfin video', duration, audioTracks: streams.filter(stream => stream.Type === 'Audio').map(trackInfo), subtitleTracks: streams.filter(stream => stream.Type === 'Subtitle').map(trackInfo), playing: true, timestamp: 0, updatedAt: Date.now(), revision: (old?.revision || 0) + 1 };
          const selection = state;
          state = await store.guardedUpdate(`jellyfin-pending:${roomId}`, operation, `jellyfin-room:${roomId}`, current => ({ ...selection, revision: (current?.revision || 0) + 1 }), roomTtl);
          if (!state) { ack({ error: 'Another playback selection replaced this request.' }); return; }
          revoke(old); await publish(roomId, state); ack({ ok: true });
        } catch (error) { ack({ error: error.name === 'AbortError' ? 'Connection cancelled or timed out. Try again.' : error.status === 503 ? error.message : 'Could not open Jellyfin playback. Check the selected server and your connection.' }); }
        finally { clearTimeout(timeout); if (pending.get(roomId) === controller) pending.delete(roomId); }
      })().catch(() => ack({ error: 'Could not complete playback selection. Try again.' }));
    });
    on('jellyfin-cancel-open', async roomId => {
      if (member(socket, roomId) && await permitted(socket, roomId)) { pending.get(roomId)?.abort(); pending.delete(roomId); await store.set(`jellyfin-pending:${roomId}`, token(), 60); }
    });
    on('jellyfin-command', async (payload = {}) => {
      if (!payload || !member(socket, payload.roomId) || !await permitted(socket, payload.roomId)) return;
      const old = await store.get(`jellyfin-room:${payload.roomId}`);
      if (!old || payload.sessionId !== old.id) return;
      if (!['stop', 'play', 'pause', 'seek'].includes(payload.action)) return;
      if (payload.action === 'stop') await store.set(`jellyfin-pending:${payload.roomId}`, token(), 60);
      if (payload.action === 'seek' && (!Number.isFinite(payload.time) || payload.time < 0 || payload.time > old.duration)) return;
      const state = await store.update(`jellyfin-room:${payload.roomId}`, current => {
        if (!current || current.id !== payload.sessionId) return current;
        if (payload.action === 'stop') return { id: null, stopped: true, revision: current.revision + 1 };
        if (payload.commandId && current.commandId === payload.commandId) return current;
        const timestamp = payload.action === 'seek' ? payload.time : position(current);
        return { ...current, timestamp: payload.action === 'play' && timestamp >= current.duration - 0.1 ? 0 : timestamp,
          playing: payload.action === 'play' ? true : payload.action === 'pause' ? false : current.playing,
          commandId: typeof payload.commandId === 'string' ? payload.commandId.slice(0, 128) : null, updatedAt: Date.now(), revision: current.revision + 1 };
      }, roomTtl);
      if (!state || state.stopped) revoke(old);
      await publish(payload.roomId, state);
    });
    socket.on('disconnecting', () => {
      for (const roomId of socket.rooms) releaseSocket(socket, roomId).catch(() => {});
    });
  });
  async function releaseSocket(socket, roomId) {
    const state = await store.get(`jellyfin-room:${roomId}`);
    if (!state?.id) return;
    const index = `viewer-index:${roomId}:${socket.id}:${state.id}`;
    const key = await store.get(index), viewer = key && await store.get(`viewer:${key}`);
    if (!viewer) return;
    activeRequests.get(key)?.requests.forEach(controller => controller.abort()); activeRequests.delete(key);
    stopEncoding(viewer, state); await quality.release(viewer, state); await store.set(`viewer:${key}`, null); await store.set(index, null);
  }

  const resolveViewer = async accessToken => {
    if (typeof accessToken !== 'string' || !/^[a-f0-9]{48}$/.test(accessToken)) return null;
    const viewer = await store.get(`viewer:${accessToken}`);
    const state = viewer && await store.get(`jellyfin-room:${viewer.roomId}`);
    const belongs = viewer && (options.store ? await store.get(`member:${viewer.roomId}:${viewer.socketId}`) : io.sockets.sockets.get(viewer.socketId)?.rooms.has(viewer.roomId));
    if (!state || state.id !== viewer.sessionId || !belongs) return null;
    await quality.renew(viewer, state);
    viewer.requests = requestsFor(viewer);
    viewer.assets = new Map();
    return { viewer, state };
  };
  if (accounts) require('./jellyfinWeb').installJellyfinWeb(app, { resolveViewer, accounts, saveViewer, quality, delivery, allowedOrigins: options.allowedOrigins, publicOrigin: options.publicOrigin });

  const registerAsset = async (viewer, url, state) => {
    const parsed = new URL(url);
    const prefix = `${new URL(state.base).pathname.replace(/\/$/, '')}/Videos/${state.itemId}/`.toLowerCase();
    if (parsed.origin !== new URL(state.base).origin || !parsed.pathname.toLowerCase().startsWith(prefix) || parsed.username || parsed.password) throw new Error('Invalid media resource');
    // Never forward an upstream credential in a manifest or URL sent to a viewer.
    for (const key of [...parsed.searchParams.keys()]) if (['api_key', 'apikey', 'token'].includes(key.toLowerCase())) parsed.searchParams.delete(key);
    const href = parsed.href;
    const key = createHash('sha256').update(href).digest('hex');
    await store.set(`asset:${viewer.token}:${key}`, href, 3600);
    return `/api/jellyfin/${viewer.token}/asset/${key}`;
  };
  const forward = async (req, res, viewer, state, url, manifest = false) => {
    const controller = new AbortController(); viewer.requests.add(controller);
    const abort = () => controller.abort(); res.on('close', abort);
    const timeout = setTimeout(abort, 90000);
    const leaseCheck = setInterval(() => {
      Promise.all([resolveViewer(viewer.token), state.connectionToken ? accounts.getConnection(state.connectionToken) : true])
        .then(([valid, connection]) => { if (!valid || !connection) abort(); }).catch(abort);
    }, 15000);
    leaseCheck.unref();
    try {
      const headers = { 'X-Emby-Token': state.apiToken };
      if (req.headers.range) headers.Range = req.headers.range;
      const parsed = new URL(url);
      const basePath = new URL(state.base).pathname.replace(/\/$/, '');
      const response = await request({ base: state.base, apiToken: state.apiToken, deviceId: viewer.deviceId }, parsed.pathname.slice(basePath.length) + parsed.search, { headers, signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); res.status(response.status).send('Jellyfin could not deliver this media.'); return; }
      res.set('Cache-Control', 'private, no-store');
      if (manifest || /mpegurl/i.test(response.headers.get('content-type') || '') || new URL(url).pathname.endsWith('.m3u8')) {
        const body = await readText(response);
        const rewrite = value => registerAsset(viewer, new URL(value, url).href, state);
        const lines = [];
        for (const line of body.split('\n')) {
          if (!line.startsWith('#')) lines.push(line.trim() ? await rewrite(line.trim()) : line);
          else {
            let next = line;
            for (const match of line.matchAll(/URI="([^"]+)"/g)) next = next.replace(match[0], `URI="${await rewrite(match[1])}"`);
            lines.push(next);
          }
        }
        const output = lines.join('\n');
        res.type('application/vnd.apple.mpegurl').send(output);
      } else {
        res.status(response.status);
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (response.headers.has(key)) res.set(key, response.headers.get(key));
        if (response.body) await pipeline(Readable.fromWeb(response.body), ...(/subtitle/i.test(parsed.pathname) ? [] : [delivery.meter(viewer, state)]), res);
        else res.end();
      }
    } catch { if (!res.headersSent && !res.destroyed) res.status(502).send('Jellyfin stream unavailable. Try reconnecting playback.'); }
    finally { clearTimeout(timeout); clearInterval(leaseCheck); viewer.requests.delete(controller); res.off('close', abort); }
  };
  app.use('/api/jellyfin/:accessToken', async (req, res, next) => {
    const resolved = await resolveViewer(req.params.accessToken);
    if (!resolved || resolved.state.connectionToken && !await accounts?.getConnection(resolved.state.connectionToken)) { res.status(403).send('Join the room to watch this video.'); return; }
    req.jellyfin = resolved; next();
  });
  app.get('/api/jellyfin/:accessToken/quality', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await quality.describe(req.jellyfin.viewer, req.jellyfin.state, 'original'));
  });
  app.post('/api/jellyfin/:accessToken/quality', async (req, res) => {
    if (!Object.hasOwn(qualityModes, req.body?.mode)) { res.status(400).json({ error: 'Choose a supported quality setting.' }); return; }
    await saveViewer(req.jellyfin.viewer, { qualityMode: req.body.mode, qualityRevision: (req.jellyfin.viewer.qualityRevision || 0) + 1 });
    res.set('Cache-Control', 'no-store').json(await quality.describe(req.jellyfin.viewer, req.jellyfin.state, 'original'));
  });
  app.get('/api/jellyfin/:accessToken/stream.m3u8', async (req, res) => {
    const { viewer, state } = req.jellyfin;
    let audio = req.query.audio === undefined ? state.audioTracks.find(track => track.default)?.index ?? state.audioTracks[0]?.index : Number(req.query.audio);
    if (audio === -1 && !state.audioTracks.length) audio = undefined;
    const subtitle = Number(req.query.subtitle ?? -1);
    if ((audio !== undefined && !state.audioTracks.some(track => track.index === audio)) || (subtitle !== -1 && !state.subtitleTracks.some(track => track.index === subtitle && !track.text))) { res.status(400).send('Unknown track'); return; }
    const original = req.query.original === '1';
    const policy = await quality.describe(viewer, state);
    const source = state.item.MediaSources.find(source => source.Id === state.sourceId);
    const streams = source?.MediaStreams || state.item.MediaStreams || [];
    const video = streams.find(stream => stream.Type === 'Video');
    if (original && (subtitle !== -1 || policy.capacityLimited || !['h264', 'hevc', 'h265', 'av1', 'vp9'].includes(video?.Codec?.toLowerCase()))) {
      res.status(409).send('Original video is unavailable for these playback settings.');
      return;
    }
    stopEncoding(viewer, state); viewer.assets.clear(); await saveViewer(viewer, { playSessionId: randomUUID() });
    const requested = Number(req.query.bitrate);
    const bitrate = Math.min(policy.maxBitrate, Number.isFinite(requested) && requested > 0 ? requested : policy.maxBitrate);
    const query = new URLSearchParams({ MediaSourceId: state.sourceId, DeviceId: viewer.deviceId, PlaySessionId: viewer.playSessionId, VideoCodec: 'h264', AudioCodec: 'aac', MaxAudioChannels: '2', VideoBitrate: String(Math.max(1, Math.floor(bitrate - 192000))), AudioBitrate: '192000', SegmentContainer: 'ts', MinSegments: '1', SegmentLength: '4', BreakOnNonKeyFrames: 'true', EnableAutoStreamCopy: 'true', AllowVideoStreamCopy: 'true', AllowAudioStreamCopy: 'true', SubtitleStreamIndex: String(subtitle) });
    if (audio !== undefined) query.set('AudioStreamIndex', String(audio));
    if (original) {
      // Use the media playlist directly so Jellyfin cannot advertise a re-encoded variant.
      query.set('VideoCodec', 'copy');
      query.set('SegmentContainer', 'mp4');
      query.set('BreakOnNonKeyFrames', 'false');
      query.delete('VideoBitrate');
      if (req.query.audioCopy === '1') {
        query.set('AudioCodec', 'copy');
        query.delete('MaxAudioChannels');
        query.delete('AudioBitrate');
      }
    }
    if (subtitle !== -1) { query.set('SubtitleMethod', 'Encode'); query.set('AllowVideoStreamCopy', 'false'); }
    await forward(req, res, viewer, state, `${state.base}/Videos/${state.itemId}/${original ? 'main' : 'master'}.m3u8?${query}`, true);
  });
  app.get('/api/jellyfin/:accessToken/subtitle/:index', async (req, res) => {
    const { viewer, state } = req.jellyfin;
    if (!state.subtitleTracks.some(track => track.index === Number(req.params.index) && track.text)) { res.sendStatus(404); return; }
    forward(req, res, viewer, state, `${state.base}/Videos/${state.itemId}/${state.sourceId}/Subtitles/${req.params.index}/0/Stream.vtt`);
  });
  app.get('/api/jellyfin/:accessToken/asset/:key', async (req, res) => {
    const { viewer, state } = req.jellyfin;
    const url = await store.get(`asset:${viewer.token}:${req.params.key}`);
    if (!url) { res.sendStatus(404); return; }
    forward(req, res, viewer, state, url);
  });
  app.post('/api/jellyfin/:accessToken/release', async (req, res) => {
    const { viewer, state } = req.jellyfin;
    viewer.requests.forEach(controller => controller.abort()); stopEncoding(viewer, state); viewer.assets.clear(); res.sendStatus(204);
  });
  const cleanup = setInterval(() => {
    for (const [key, value] of activeRequests) if (!value.requests.size) activeRequests.delete(key);
  }, 30000); cleanup.unref();
  return { resolveViewer, releaseSocket, close() {
    clearInterval(cleanup); io.off('jellyfin-revoke', abortSession);
    pending.forEach(controller => controller.abort()); activeRequests.forEach(value => value.requests.forEach(controller => controller.abort()));
  } };
}
module.exports = { installJellyfin, position };
