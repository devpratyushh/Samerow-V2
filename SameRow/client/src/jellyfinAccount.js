import { accountFetch } from './session.js';
const connectionKey = scope => scope ? `samerow.jellyfin.connection:${scope}` : 'samerow.jellyfin.connection';
export function savedConnection(scope) {
  const storageKey = connectionKey(scope);
  try { return sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey) || ''; } catch { return ''; }
}
export function rememberConnection(token, remember, scope) {
  const storageKey = connectionKey(scope);
  try {
    localStorage.removeItem(storageKey); sessionStorage.removeItem(storageKey);
    if (token) (remember ? localStorage : sessionStorage).setItem(storageKey, token);
  } catch { /* The connection still works in memory when storage is disabled. */ }
}
const accountOrigins = new Map();
export async function resolveAccountOrigin(base, { signal, request = fetch } = {}) {
  const cached = accountOrigins.get(base);
  if (cached?.until > Date.now()) return cached.origin;
  const response = await request(`${base}/api/config`, { signal, cache: 'no-store' });
  if (!response.ok) return base;
  const config = await response.json();
  if (!config.mediaOrigin) return base;
  const media = new URL(config.mediaOrigin);
  const control = new URL(base || globalThis.location?.origin);
  const local = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (media.origin !== config.mediaOrigin || !(media.protocol === 'https:' || media.protocol === 'http:' && local(media) && local(control))) throw new Error('SameRow returned an invalid media service address.');
  accountOrigins.set(base, { origin: media.origin, until: Date.now() + 60000 });
  return media.origin;
}
export async function jellyfinRequest(base, path, { token, signal, body, method = body ? 'POST' : 'GET' } = {}) {
  const origin = await resolveAccountOrigin(base, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)]) });
  const response = await accountFetch(`${origin}/api/jellyfin${path}`, {
    method, signal, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `SameRow account request failed (HTTP ${response.status}). Try again.`); error.status = response.status; throw error; }
  return data;
}
