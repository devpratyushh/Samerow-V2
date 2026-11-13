async function viewerHealth(accounts, state) {
  try {
    const response = await accounts.request(state, '/Users/Me', { signal: AbortSignal.timeout(5000), timeoutMs: 5000 });
    await response.body?.cancel();
    return { status: response.ok ? 'ready' : [401, 403].includes(response.status) ? 'sign_in_required' : 'reconnecting' };
  } catch { return { status: 'reconnecting' }; }
}
module.exports = { viewerHealth };
