export const availabilityLabels = {
  ready: 'Ready', offline: 'Offline', reconnecting: 'Reconnecting', sign_in_required: 'Sign-in required',
  jellyfin_unavailable: 'Jellyfin unavailable', unknown: 'Status unavailable', client_offline: 'You’re offline',
};
export function availabilityFor(server, { online = true, unavailable = false } = {}) {
  if (!online) return { status: 'client_offline', message: 'Connect this device to the internet. Your saved binding is unchanged.' };
  if (unavailable) return { status: 'unknown', message: 'SameRow could not check the server. Showing its last saved details.' };
  return { status: server.status || 'unknown', message: server.message || 'Checking the Jellyfin connection…' };
}
export function lastSeenLabel(timestamp, now = Date.now()) {
  if (!timestamp) return 'Not reached yet';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  return minutes < 1 ? 'Last reached just now' : minutes < 60 ? `Last reached ${minutes} minute${minutes === 1 ? '' : 's'} ago` : `Last reached ${new Date(timestamp).toLocaleString()}`;
}
