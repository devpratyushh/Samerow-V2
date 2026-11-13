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
export async function jellyfinRequest(base, path, { token, signal, body, method = body ? 'POST' : 'GET' } = {}) {
  const response = await accountFetch(`${base}/api/jellyfin${path}`, {
    method, signal, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'Jellyfin could not complete this request. Try again.'); error.status = response.status; throw error; }
  return data;
}
