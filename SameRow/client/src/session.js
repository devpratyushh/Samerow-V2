// Kept separate from Firebase initialization so API helpers and previews can be
// imported without opening a network session.
let tokenProvider = async () => '';
export function configureSession(provider) { tokenProvider = provider; }
export async function sessionHeaders(forceRefresh = false) {
  const token = await tokenProvider(forceRefresh);
  return token ? { 'X-SameRow-Token': token } : {};
}

// Refresh once when a request crosses a sign-in/provider change. Never retry
// with weaker credentials or silently turn a signed-in account into a guest.
export async function accountFetch(url, options = {}, request = fetch) {
  const headers = { ...options.headers, ...await sessionHeaders() };
  let response = await request(url, { ...options, headers });
  if (response.status === 401 || response.status === 403) {
    const refreshed = await sessionHeaders(true);
    if (refreshed['X-SameRow-Token'] && refreshed['X-SameRow-Token'] !== headers['X-SameRow-Token']) {
      await response.body?.cancel();
      response = await request(url, { ...options, headers: { ...headers, ...refreshed } });
    }
  }
  return response;
}
