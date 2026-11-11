const required = [
  'VITE_SOCKET_URL',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
];

function httpsOrigin(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { /* Report the variable name below. */ }
  if (parsed?.protocol !== 'https:' || parsed.origin !== value) {
    throw new Error(`${name} must be an HTTPS origin without a path or trailing slash.`);
  }
  return parsed.origin;
}

export async function checkDeployment(env = process.env, request = fetch) {
  const missing = required.filter(name => !env[name]?.trim() || env[name].startsWith('<'));
  if (missing.length) throw new Error(`Set these Vercel environment variables: ${missing.join(', ')}.`);
  const control = httpsOrigin(env.VITE_SOCKET_URL, 'VITE_SOCKET_URL');
  if (env.VERCEL_ENV === 'preview' || env.VERCEL_ENV === 'development') return;

  const defaultOrigin = env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const webOrigin = httpsOrigin(env.SAMEROW_WEB_ORIGIN || defaultOrigin, 'SAMEROW_WEB_ORIGIN');

  async function read(origin, role, path) {
    let response;
    try {
      response = await request(origin + path, {
        headers: { Origin: webOrigin }, redirect: 'error', signal: AbortSignal.timeout(8000),
      });
    } catch { throw new Error(`Could not reach the Render ${role} service at ${origin + path}.`); }
    if (response.status === 404) {
      throw new Error(`The Render ${role} service returned 404 for ${path}. Deploy main to that service before rebuilding Vercel.`);
    }
    if (response.status === 403 || response.headers.get('access-control-allow-origin') !== webOrigin) {
      throw new Error(`Add ${webOrigin} to CLIENT_ORIGINS on the Render ${role} service and redeploy it.`);
    }
    if (!response.ok) throw new Error(`The Render ${role} service returned HTTP ${response.status} for ${path}. Check its deploy logs.`);
    try { return await response.json(); }
    catch { throw new Error(`The Render ${role} service did not return JSON for ${path}.`); }
  }

  async function checkService(origin, role) {
    const config = await read(origin, role, '/api/config');
    if (config.role !== role || config.roomProtocol !== 1 || config.auth !== 'firebase' || config.media !== 'livekit') {
      throw new Error(`Deploy the current main backend on Render with SERVICE_ROLE=${role}, Firebase auth, and LiveKit.`);
    }
    if (config.firebaseProjectId !== env.VITE_FIREBASE_PROJECT_ID) {
      throw new Error(`The Render ${role} service and Vercel must use the same Firebase project.`);
    }
    if ((await read(origin, role, '/health/ready')).status !== 'ready') {
      throw new Error(`The Render ${role} service is not ready. Check its Redis connection and deploy logs.`);
    }
    return config;
  }

  const controlConfig = await checkService(control, 'control');
  const media = httpsOrigin(controlConfig.mediaOrigin, 'MEDIA_PUBLIC_URL on Render');
  if (media === control) throw new Error('MEDIA_PUBLIC_URL must point to the separate Render media service.');
  const mediaConfig = await checkService(media, 'media');
  if (mediaConfig.mediaOrigin !== media || mediaConfig.maxRoomSize !== controlConfig.maxRoomSize ||
      mediaConfig.jellyfinRelay !== controlConfig.jellyfinRelay) {
    throw new Error('Use the same MEDIA_PUBLIC_URL, MAX_ROOM_SIZE and JELLYFIN_RELAY_ENABLED on both Render services.');
  }
}

if (import.meta.main) {
  try {
    await checkDeployment();
    console.log('SameRow deployment configuration passed.');
  } catch (error) {
    console.error(`SameRow deployment check: ${error.message}`);
    process.exitCode = 1;
  }
}
