const { setTimeout: delay } = require('node:timers/promises');
const { upstreamRequest, validateServerUrl } = require('./jellyfinAccounts');
const { ROOT, responseFields, pick } = require('./jellyfinRelay');

function startJellyfinConnector(env = process.env) {
  const token = env.SAMEROW_CONNECTOR_TOKEN;
  if (!token) return () => {};
  const gateway = new URL(env.SAMEROW_CONNECTOR_GATEWAY);
  if (gateway.protocol !== 'https:' || gateway.href !== `${gateway.origin}/` || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) {
    throw new Error('Set the connector token and HTTPS gateway from the web app.');
  }
  const policy = { origins: (env.JELLYFIN_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()) };
  const base = validateServerUrl(env.SAMEROW_CONNECTOR_JELLYFIN_URL, policy);
  const controller = new AbortController();
  const { signal } = controller;
  const headers = { Authorization: `Bearer ${token}` };
  const call = (route, options = {}) => fetch(`${gateway.origin}${ROOT}${route}`, {
    ...options, redirect: 'error', headers: { ...headers, ...options.headers },
  });

  async function upload(job) {
    if (!/^[a-f0-9]{32}$/.test(job.job) || !['GET', 'HEAD', 'POST', 'DELETE'].includes(job.method)) return;
    let response;
    try {
      response = await upstreamRequest({ base, apiToken: job.apiToken, deviceId: job.deviceId }, job.resource, {
        method: job.method, headers: job.headers, body: job.body, signal, networkPolicy: policy, timeoutUntilHeaders: true,
      });
    } catch {
      response = new Response(null, { status: 502 });
    }
    try {
      const result = await call(`/response/${job.job}`, {
        method: 'POST', signal, duplex: 'half', body: response.body,
        headers: {
          'X-Relay-Status': String(response.status),
          'X-Relay-Headers': JSON.stringify(pick(response.headers, responseFields)),
        },
      });
      await result.body?.cancel();
    } finally {
      if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  async function worker() {
    while (!signal.aborted) {
      try {
        const response = await call('/poll', { signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
        if (response.status === 204) continue;
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Connector unavailable');
        }
        await upload(await response.json());
      } catch {
        await delay(1500 + Math.random() * 1500, undefined, { signal }).catch(() => {});
      }
    }
  }

  for (let index = 0; index < 8; index++) void worker();
  return () => controller.abort();
}

module.exports = { startJellyfinConnector };
