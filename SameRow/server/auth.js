const { randomUUID, createHash } = require('node:crypto');

function createIdentity(config) {
  if (config.authMode === 'development') return { verify: async token => ({ uid: typeof token === 'string' && token.startsWith('dev:') ? token.slice(4, 132) : token ? createHash('sha256').update(String(token)).digest('hex').slice(0, 32) : 'development-guest', exp: Math.floor(Date.now() / 1000) + 3600 }) };
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const { getFirestore } = require('firebase-admin/firestore');
  const credentials = JSON.parse(config.firebaseCredentials);
  if (credentials.project_id !== config.firebaseProjectId) throw new Error('Firebase service account must belong to FIREBASE_PROJECT_ID.');
  const firebase = initializeApp({ credential: cert(credentials), projectId: config.firebaseProjectId }, `samerow-${randomUUID()}`);
  const cache = new Map();
  return { verify: async token => {
    if (typeof token !== 'string' || token.length > 8192) throw new Error('Invalid identity.');
    const key = createHash('sha256').update(token).digest('hex'), now = Date.now();
    const cached = cache.get(key);
    if (cached?.until > now) return cached.user;
    const user = await getAuth(firebase).verifyIdToken(token, true);
    if (cache.size >= 10000) cache.delete(cache.keys().next().value);
    cache.set(key, { user, until: Math.min(user.exp * 1000, now + 30000) });
    return user;
  }, firestore: getFirestore(firebase), close: () => require('firebase-admin/app').deleteApp(firebase) };
}

function installIdentity(io, app, identity) {
  io.use(async (socket, next) => {
    try {
      const user = await identity.verify(socket.handshake.auth?.token);
      socket.identityToken = socket.handshake.auth?.token;
      socket.data.uid = user.uid; socket.data.expiresAt = user.exp * 1000;
      next();
    } catch { const error = new Error('Sign in again to connect.'); error.data = { code: 'UNAUTHENTICATED' }; next(error); }
  });
  // Jellyfin account capabilities use Authorization; Firebase identity is separate.
  app.use('/api/jellyfin', async (req, res, next) => {
    try { req.identity = await identity.verify(req.get('X-SameRow-Token')); next(); }
    catch { res.status(401).json({ error: 'Sign in again to connect your library.' }); }
  });
}
module.exports = { createIdentity, installIdentity };
