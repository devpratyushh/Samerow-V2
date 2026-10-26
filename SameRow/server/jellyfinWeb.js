const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const { readText, readJson } = require('./upstreamBody');

const ROOT = '/api/jellyfin-native';
const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
const cleanPath = value => {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (!decoded.startsWith('/') || /[\\\0]/.test(decoded) || decoded.split('/').some(part => part === '..' || part === '.') || /%2e|%2f|%5c/i.test(decoded)) return null;
  return decoded;
};
const authorization = (connection, viewer) => `MediaBrowser Client="SameRow Jellyfin Web", Device="Watch party", DeviceId="${viewer.deviceId}", Version="1.0.0", Token="${connection.apiToken}"`;

// Every request is restricted to the selected room item. A viewer never receives
// the library owner's Jellyfin credential or a general-purpose server proxy.
function installJellyfinWeb(app, { resolveViewer, accounts, saveViewer = async (viewer, patch) => Object.assign(viewer, patch), allowedOrigins, publicOrigin }) {
  app.use(`${ROOT}/storage`, require('express').static(path.resolve(path.dirname(require.resolve('fake-indexeddb')), '../esm'), { fallthrough: false, immutable: true, maxAge: '1d' }));
  app.get(`${ROOT}/bridge.js`, (req, res) => {
    res.set('Cache-Control', 'no-cache').type('application/javascript').sendFile(path.join(__dirname, 'public/jellyfin-bridge.js'));
  });
  app.use(`${ROOT}/:viewerToken`, async (req, res) => {
    const resolved = await resolveViewer(req.params.viewerToken);
    if (!resolved) { res.status(403).json({ error: 'This room playback session has ended. Rejoin the room to continue.' }); return; }
    const { viewer, state } = resolved;
    const connection = await accounts.getConnection(state.connectionToken);
    if (!connection) { res.status(401).json({ error: 'The Jellyfin connection was disconnected. Connect again from the library.' }); return; }
    const resource = cleanPath(req.path);
    if (!resource) { res.status(400).json({ error: 'Invalid Jellyfin resource.' }); return; }
    const prefix = `${ROOT}/${viewer.token}`;
    const localBase = `${publicOrigin || `${req.protocol}://${req.get('host')}`}${prefix}`;
    if (viewer.requests.size >= 24) { res.status(429).json({ error: 'Too many concurrent playback requests.' }); return; }
    const upstreamBase = new URL(`${connection.base}/`);
    const parameters = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
    const originalParameters = new URLSearchParams(parameters);
    for (const key of [...parameters.keys()]) {
      if (['api_key', 'apikey', 'token', 'access_token', 'authorization', 'x-emby-token', 'channel', 'parentOrigin'].includes(key.toLowerCase())) parameters.delete(key);
      if (key.toLowerCase() === 'userid') parameters.set(key, connection.userId);
      if (key.toLowerCase() === 'deviceid') parameters.set(key, viewer.deviceId);
    }
    const failure = (code, message) => { if (!res.headersSent && !res.destroyed) res.status(code).json({ error: message }); };
    const deny = () => failure(403, 'Room access is limited to the shared video.');
    const empty = () => res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    const selectedId = state.itemId.toLowerCase();
    const isSelected = value => typeof value === 'string' && value.replaceAll('-', '').toLowerCase() === selectedId.replaceAll('-', '');
    const requestBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
    for (const [key, value] of Object.entries(requestBody)) {
      if (key.toLowerCase() === 'itemid' && !isSelected(value)) { deny(); return; }
      if (key.toLowerCase() === 'userid') requestBody[key] = connection.userId;
      if (key.toLowerCase() === 'deviceid') requestBody[key] = viewer.deviceId;
      if (['accesstoken', 'token', 'apikey'].includes(key.toLowerCase())) delete requestBody[key];
    }
    const mediaSource = parameters.get('MediaSourceId') || parameters.get('mediaSourceId') || requestBody.MediaSourceId;
    if (mediaSource && !state.sourceIds?.includes(mediaSource)) { deny(); return; }
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' });

    const rebase = (value, relative = false) => {
      if (!value || typeof value !== 'string') return value;
      const url = new URL(value, upstreamBase);
      const basePath = upstreamBase.pathname.replace(/\/$/, '');
      if (url.origin !== upstreamBase.origin || (basePath && !url.pathname.startsWith(`${basePath}/`))) return '';
      const route = url.pathname.slice(basePath.length);
      if (!cleanPath(route)) return '';
      for (const key of [...url.searchParams.keys()]) {
        if (['api_key', 'apikey', 'token', 'access_token'].includes(key.toLowerCase())) url.searchParams.set(key, viewer.token);
        if (key.toLowerCase() === 'deviceid') url.searchParams.set(key, viewer.deviceId);
      }
      return `${relative ? '' : localBase}${route}${url.search}`;
    };
    const sanitize = (value, key = '') => {
      if (Array.isArray(value)) return value.map(item => sanitize(item));
      if (value && typeof value === 'object') {
        const result = {};
        for (const [name, child] of Object.entries(value)) {
          if (['RemoteEndPoint', 'Password', 'PasswordHash', 'ProviderUrls', 'ExternalUrls'].includes(name)) continue;
          if (name === 'Path') { result[name] = `media.${value.Container || 'mp4'}`; continue; }
          result[name] = sanitize(child, name);
        }
        return result;
      }
      if (typeof value === 'string') {
        if (/^(AccessToken|ApiKey)$/i.test(key)) return viewer.token;
        if (/^(LocalAddress|RemoteAddress|ManualAddress|ServerAddress)$/i.test(key)) return localBase;
        if (/Url$/i.test(key) && /^(https?:\/\/|\/)/i.test(value)) return rebase(value, /^(TranscodingUrl|DirectStreamUrl|DeliveryUrl)$/i.test(key));
        return value.split(connection.apiToken).join(viewer.token);
      }
      return value;
    };
    const upstream = async (route = resource, { method = req.method, body, web = false } = {}) => {
      const url = new URL(`${connection.base}${route}`);
      url.search = parameters.toString();
      const controller = new AbortController(); viewer.requests.add(controller);
      const abort = () => controller.abort(); res.on('close', abort);
      const timeout = setTimeout(abort, 20000);
      const leaseCheck = setInterval(() => { Promise.all([resolveViewer(viewer.token), accounts.getConnection(state.connectionToken)]).then(([valid, connection]) => { if (!valid || !connection) abort(); }).catch(abort); }, 15000); leaseCheck.unref();
      const headers = { Authorization: authorization(connection, viewer), Accept: req.get('Accept') || '*/*' };
      if (req.get('Range')) headers.Range = req.get('Range');
      if (req.get('If-Range')) headers['If-Range'] = req.get('If-Range');
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      try {
        const options = { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal, timeoutUntilHeaders: true };
        const response = await accounts.request({ ...connection, deviceId: viewer.deviceId }, `${route}${url.search}`, options);
        clearTimeout(timeout);
        if (!response.ok && response.status !== 304) {
          await response.body?.cancel(); failure(response.status, [401, 403].includes(response.status) ? 'Jellyfin denied playback. Reconnect your library.' : response.status === 404 ? 'This Jellyfin resource is unavailable.' : 'Jellyfin could not deliver this resource.'); return;
        }
        if (response.status === 204 || method === 'HEAD') { res.status(response.status).end(); return; }
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        if (route === '/web/index.html' || route === '/web/') {
          let html = await readText(response);
          const channel = originalParameters.get('channel');
          const parentOrigin = originalParameters.get('parentOrigin');
          if (!channel || !/^[a-zA-Z0-9_-]{1,80}$/.test(channel)) { failure(400, 'Invalid player channel.'); return; }
          let parent;
          try { parent = new URL(parentOrigin).origin; if (!/^https?:/.test(parent)) throw Error(); } catch { failure(400, 'Invalid room origin.'); return; }
          if (allowedOrigins?.length && !allowedOrigins.includes(parent)) { failure(403, 'This room origin is not allowed.'); return; }
          res.set('Content-Security-Policy', `frame-ancestors ${parent}`);
          const config = { parentOrigin: parent, channel, serverAddress: localBase, serverId: connection.serverId, serverName: connection.serverName, userId: connection.userId, userName: connection.userName, accessToken: viewer.token, deviceId: viewer.deviceId, itemId: state.itemId, duration: state.duration };
          html = html.replace(/<script[^>]*src=["'][^"']*serviceworker[^"']*["'][^>]*>\s*<\/script>/gi, '').replace(/<link[^>]*rel=["']manifest["'][^>]*>/gi, '');
          html = html.replace(/<script([^>]*?)src=["']([^"']+)["']([^>]*)><\/script>/gi, (_, before, src) => `<script type="application/samerow-script" data-jellyfin-src="${src}"></script>`);
          const loader = `<script type="module">import * as storage from '${ROOT}/storage/index.js';for(const [key,value] of Object.entries(storage)){if(key!=='default')Object.defineProperty(window,key,{configurable:true,value});}for(const element of document.querySelectorAll('script[data-jellyfin-src]')){const script=document.createElement('script');script.src=element.dataset.jellyfinSrc;script.async=false;document.head.appendChild(script);}</script>`;
          html = html.replace('</body>', `${loader}</body>`);
          html = html.replace('<head>', `<head><script>window.__SAMEROW_JELLYFIN__=${safeJson(config)};</script><script src="${ROOT}/bridge.js"></script><style>.headerSyncButton,.headerCastButton,.btnCast,.btnPlaybackRate,.btnNextChapter,.btnPreviousChapter{display:none!important}.mainDrawer,.headerHomeButton,.headerUserButton{display:none!important}body{background:#000!important}</style>`);
          res.type('html').send(html); return;
        }
        if (route === '/web/config.json') {
          const config = await readJson(response);
          config.plugins = [...(config.plugins || []).filter(name => !/chromecast|syncPlay/i.test(name)), 'SameRowBridge'];
          config.servers = [localBase]; config.multiserver = false; config.publishedServerUrl = localBase;
          res.json(config); return;
        }
        if (!web && /json/i.test(contentType)) {
          const json = await readJson(response);
          if (json.PlaySessionId) await saveViewer(viewer, { playSessionId: json.PlaySessionId });
          if (/^\/Users\/(Me|[^/]+)$/i.test(route)) {
            json.Policy = { ...json.Policy, IsAdministrator: false, EnableRemoteControlOfOtherUsers: false, EnableSharedDeviceControl: false, EnableLiveTvAccess: false, EnableContentDeletion: false, SyncPlayAccess: 'None' };
            json.Configuration = { ...json.Configuration, EnableNextEpisodeAutoPlay: false, EnableCinemaMode: false };
          }
          res.json(sanitize(json)); return;
        }
        if (!web && /mpegurl/i.test(contentType)) {
          const manifest = await readText(response);
          const rewrite = raw => {
            const absolute = new URL(raw, url);
            const rewritten = rebase(absolute.href);
            const mediaRoute = rewritten && new URL(rewritten).pathname.slice(prefix.length).match(/^\/Videos\/([^/]+)\//i);
            if (!mediaRoute || !isSelected(mediaRoute[1])) throw new Error('Out-of-scope manifest');
            return rewritten;
          };
          res.type(contentType).send(manifest.split('\n').map(line => line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`) : line.trim() ? rewrite(line.trim()) : line).join('\n')); return;
        }
        res.status(response.status).type(contentType);
        for (const header of ['accept-ranges', 'content-range', 'last-modified', 'etag']) if (response.headers.has(header)) res.set(header, response.headers.get(header));
        if (!response.headers.has('content-encoding') && response.headers.has('content-length')) res.set('Content-Length', response.headers.get('content-length'));
        if (web) res.set('Cache-Control', 'private, max-age=3600');
        await pipeline(Readable.fromWeb(response.body), res);
      } finally { clearInterval(leaseCheck); clearTimeout(timeout); res.off('close', abort); viewer.requests.delete(controller); }
    };
    try {
      if (resource.startsWith('/web/')) {
        if (!['GET', 'HEAD'].includes(req.method) || !/\.(?:html|js|css|json|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|wasm|map|txt)$/i.test(resource) && resource !== '/web/') { deny(); return; }
        if (/serviceworker/i.test(resource)) { res.type('application/javascript').send(''); return; }
        await upstream(resource === '/web/' ? '/web/index.html' : resource, { web: true }); return;
      }
      if (/^\/Branding\/(Configuration|Css)$/i.test(resource)) { /Css$/i.test(resource) ? res.type('text/css').send('') : res.json({}); return; }
      if (resource === '/UserViews') { empty(); return; }
      if (resource === '/SyncPlay/List' && req.method === 'GET') { res.json([]); return; }
      if (/^\/QuickConnect\/Enabled$/i.test(resource)) { res.json(false); return; }
      if (/^\/DisplayPreferences\//i.test(resource)) {
        if (req.method === 'POST') { await saveViewer(viewer, { displayPreferences: requestBody }); res.sendStatus(204); } else res.json(viewer.displayPreferences || { Id: 'usersettings', Client: 'emby', CustomPrefs: {}, ScrollDirection: 'Horizontal', SortBy: 'SortName', IndexBy: 'None', ShowBackdrop: true }); return;
      }
      if (/^\/Users\/[^/]+\/Configuration$/i.test(resource) && req.method === 'POST') { res.sendStatus(204); return; }
      if (/^\/Users\/(Me|[^/]+)$/i.test(resource) && req.method === 'GET') { await upstream(`/Users/${connection.userId}`); return; }
      if (resource === '/System/Endpoint' && req.method === 'GET') { res.json({ IsLocal: false, IsInNetwork: false }); return; }
      if (/^\/System\/Info(?:\/Public)?$/i.test(resource) && req.method === 'GET') { await upstream('/System/Info/Public'); return; }
      if (/^\/Localization\/(Cultures|Countries|Options|ParentalRatings)$/i.test(resource) && req.method === 'GET') { await upstream(); return; }
      if (/^\/Playback\/BitrateTest$/i.test(resource) && req.method === 'GET') { parameters.set('Size', String(Math.min(1000000, Number(parameters.get('Size')) || 100000))); await upstream(); return; }
      if (/^\/Sessions\/Capabilities(?:\/Full)?$/i.test(resource) && req.method === 'POST') {
        await upstream(resource, { body: { ...requestBody, SupportsMediaControl: false, SupportsSync: false, SupportsPersistentIdentifier: true } }); return;
      }
      if (/^\/Sessions\/Playing(?:\/(Progress|Stopped|Ping))?$/i.test(resource) && req.method === 'POST') {
        if (requestBody.ItemId && !isSelected(requestBody.ItemId)) { deny(); return; }
        await upstream(resource, { body: { ...requestBody, ItemId: state.itemId } }); return;
      }
      if (/^\/Sessions$/i.test(resource) && req.method === 'GET') { res.json([]); return; }
      if (/^\/Users\/[^/]+\/(Items\/Resume|Views|GroupingOptions)$/i.test(resource) || /^\/Items\/Latest$/i.test(resource)) { empty(); return; }
      if (/^\/Shows\/[^/]+\/Episodes$/i.test(resource)) { res.json({ Items: [sanitize(state.item)], TotalRecordCount: 1 }); return; }
      if (/^\/Shows\/NextUp$/i.test(resource)) { empty(); return; }
      if (/^\/Items$/i.test(resource) || /^\/Users\/[^/]+\/Items$/i.test(resource)) {
        const ids = parameters.get('Ids') || parameters.get('ids');
        if (!ids) { empty(); return; }
        if (!ids.split(',').every(isSelected)) { deny(); return; }
        res.json({ Items: [sanitize(state.item)], TotalRecordCount: 1, StartIndex: 0 }); return;
      }
      const itemRoute = resource.match(/^\/(?:Users\/[^/]+\/)?Items\/([^/]+)(.*)$/i);
      if (itemRoute) {
        if (!isSelected(itemRoute[1])) { deny(); return; }
        const suffix = itemRoute[2];
        if (!suffix && req.method === 'GET') { res.json(sanitize(state.item)); return; }
        if (/^\/(Intros|Similar|LocalTrailers|SpecialFeatures|AdditionalParts|PlaybackInfo|Images(?:\/.*)?|Ancestors)$/i.test(suffix)) {
          if (/^\/PlaybackInfo$/i.test(suffix) && ['GET', 'POST'].includes(req.method)) {
            parameters.set('UserId', connection.userId); parameters.set('DeviceId', viewer.deviceId);
            await upstream(`/Items/${state.itemId}/PlaybackInfo`, { ...(req.method === 'POST' ? { body: { ...requestBody, UserId: connection.userId, AutoOpenLiveStream: false } } : {}) }); return;
          }
          if (/^\/Images\//i.test(suffix) && ['GET', 'HEAD'].includes(req.method)) { await upstream(`/Items/${state.itemId}${suffix}`); return; }
          if (req.method !== 'GET') { deny(); return; }
          if (/^\/(LocalTrailers|SpecialFeatures|Ancestors)$/i.test(suffix)) res.json([]); else empty(); return;
        }
        deny(); return;
      }
      if (resource === '/Videos/ActiveEncodings' && req.method === 'DELETE') {
        parameters.set('DeviceId', viewer.deviceId);
        if (viewer.playSessionId) parameters.set('PlaySessionId', viewer.playSessionId); else { res.sendStatus(204); return; }
        await upstream(); return;
      }
      const videoRoute = resource.match(/^\/Videos\/([^/]+)\/(.+)$/i);
      if (videoRoute && isSelected(videoRoute[1]) && ['GET', 'HEAD'].includes(req.method)) {
        if (/\bLiveStreamId\b/i.test(parameters.toString())) { deny(); return; }
        parameters.set('DeviceId', viewer.deviceId);
        await upstream(); return;
      }
      deny();
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); }
      else failure(502, error.name === 'AbortError' ? 'Jellyfin took too long to respond. Try reconnecting playback.' : 'Could not load Jellyfin playback. Check the server connection.');
    }
  });
}
module.exports = { installJellyfinWeb, cleanPath };
