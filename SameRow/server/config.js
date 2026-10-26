function configuration(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const origins = (env.CLIENT_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || (production && parsed.protocol !== 'https:')) throw new Error('CLIENT_ORIGINS must list exact HTTPS origins without trailing slashes.');
  }
  const authMode = env.AUTH_MODE || (production ? 'firebase' : 'development');
  const mediaMode = env.MEDIA_MODE || (production ? 'livekit' : 'mesh');
  const config = { production, origins, authMode, mediaMode, redisUrl: env.REDIS_URL,
    encryptionKey: env.DATA_ENCRYPTION_KEY, prefix: env.REDIS_PREFIX || 'samerow:v1',
    firebaseProjectId: env.FIREBASE_PROJECT_ID, firebaseCredentials: env.FIREBASE_SERVICE_ACCOUNT_JSON,
    livekitUrl: env.LIVEKIT_URL, livekitApiKey: env.LIVEKIT_API_KEY, livekitApiSecret: env.LIVEKIT_API_SECRET,
    mediaOrigin: env.MEDIA_PUBLIC_URL || '', serviceRole: env.SERVICE_ROLE || 'combined',
    controlPolicy: env.CONTROL_POLICY || 'everyone',
    jellyfinQuality: { originMbps: Number(env.JELLYFIN_ORIGIN_BANDWIDTH_MBPS || 0), gatewayMbps: Number(env.JELLYFIN_GATEWAY_BANDWIDTH_MBPS || 0) },
    maxRoomSize: Number(env.MAX_ROOM_SIZE || (mediaMode === 'livekit' ? 25 : 4)),
    roomTtl: Number(env.ROOM_TTL_SECONDS || 86400),
    upstreamOrigins: (env.JELLYFIN_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
    allowPrivateJellyfin: env.JELLYFIN_ALLOW_PRIVATE === 'true',
  };
  if (Object.values(config.jellyfinQuality).some(value => !Number.isFinite(value) || value < 0 || value > 100000)) throw new Error('Jellyfin bandwidth budgets must be Mbps between 0 and 100000.');
  if (!['firebase', 'development'].includes(authMode) || !['mesh', 'livekit'].includes(mediaMode) || !['combined', 'control', 'media'].includes(config.serviceRole) || !['everyone', 'host'].includes(config.controlPolicy)) throw new Error('Invalid authentication, media, service role or control policy.');
  if (!Number.isInteger(config.maxRoomSize) || config.maxRoomSize < 2 || config.maxRoomSize > 100 || !Number.isInteger(config.roomTtl) || config.roomTtl < 300 || config.roomTtl > 604800) throw new Error('Invalid room size or retention.');
  if (production && (!config.redisUrl || !/^[a-f0-9]{64}$/i.test(config.encryptionKey || '') || !origins.length || authMode !== 'firebase' || !config.firebaseProjectId || !config.firebaseCredentials)) throw new Error('Production requires REDIS_URL, DATA_ENCRYPTION_KEY, CLIENT_ORIGINS, FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON; development authentication is forbidden.');
  if (production && env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Firebase Auth emulator is forbidden in production.');
  if (config.redisUrl && !/^[a-f0-9]{64}$/i.test(config.encryptionKey || '')) throw new Error('Redis requires a 64-character hexadecimal DATA_ENCRYPTION_KEY.');
  for (const origin of config.upstreamOrigins) if (new URL(origin).origin !== origin) throw new Error('JELLYFIN_ALLOWED_ORIGINS must list exact origins.');
  if (production && config.allowPrivateJellyfin && !config.upstreamOrigins.length) throw new Error('Private Jellyfin access requires JELLYFIN_ALLOWED_ORIGINS.');
  if (mediaMode === 'livekit' && (!config.livekitUrl || !config.livekitApiKey || !config.livekitApiSecret || !(production ? /^wss:\/\// : /^wss?:\/\//).test(config.livekitUrl))) throw new Error('LiveKit requires a secure LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.');
  if (production && mediaMode === 'mesh') throw new Error('Production requires LiveKit media mode.');
  if (config.mediaOrigin && (new URL(config.mediaOrigin).origin !== config.mediaOrigin || production && !config.mediaOrigin.startsWith('https://'))) throw new Error('MEDIA_PUBLIC_URL must be an exact HTTPS origin.');
  if (production && config.serviceRole !== 'combined' && !config.mediaOrigin) throw new Error('Separate production services require MEDIA_PUBLIC_URL.');
  return config;
}
module.exports = { configuration };
