export async function loadPluginBinding(id, discover, restore) {
  const [servers, links] = await Promise.allSettled([discover(), restore()]);
  if (servers.status === 'rejected') throw servers.reason;
  const server = servers.value.find(value => value.id === id);
  if (!server) throw new Error('This server is paired with a different SameRow account, or its pairing expired. Sign in with the account used to approve the plugin.');
  return { server,
    bound: links.status === 'fulfilled' ? links.value.connections?.find(value => value.account.serverUrl === server.address)?.account || null : null,
    notice: links.status === 'rejected' ? 'Your paired server was found. The saved-library check is unavailable; you can still connect your Jellyfin user.' : '',
  };
}
