import { accountFetch } from './session.js';

// Some split deployments expose connector management only on their media role.
// Resolve that role from SameRow's own config; never guess a server from an email.
export async function discoverAccountConnectors(base, { signal, request = fetch } = {}) {
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000)]);
  const options = { signal: requestSignal, cache: 'no-store' };
  let response = await accountFetch(`${base}/api/jellyfin-relay/connectors`, options, request);
  if (response.status === 404) {
    const configResponse = await request(`${base}/api/config`, { signal: requestSignal, cache: 'no-store' });
    if (configResponse.ok) {
      const config = await configResponse.json();
      let media;
      try {
        const url = new URL(config.mediaOrigin);
        const local = value => ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname);
        const control = new URL(base || globalThis.location?.origin);
        if (url.origin === config.mediaOrigin && (url.protocol === 'https:' || url.protocol === 'http:' && local(url) && local(control))) media = url.origin;
      } catch { /* A missing or malformed media origin cannot receive credentials. */ }
      if (media && media !== base) response = await accountFetch(`${media}/api/jellyfin-relay/connectors`, options, request);
    }
  }
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? 'Sign in to SameRow with the Google or GitHub account that approved your Jellyfin plugin.'
      : `Could not load servers linked to your SameRow account (HTTP ${response.status}). Retrying…`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return Array.isArray(data.connectors) ? data.connectors : [];
}
