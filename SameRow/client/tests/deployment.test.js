import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDeployment } from '../scripts/check-deployment.mjs';

const env = {
  VERCEL_ENV: 'production',
  VERCEL_PROJECT_PRODUCTION_URL: 'samerow.example',
  VITE_SOCKET_URL: 'https://control.example',
  VITE_FIREBASE_API_KEY: 'public-web-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'project.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'project',
  VITE_FIREBASE_APP_ID: 'public-app-id',
};
const mediaOrigin = 'https://media.example';
const config = {
  roomProtocol: 1, auth: 'firebase', media: 'livekit', firebaseProjectId: 'project',
  mediaOrigin, maxRoomSize: 4, jellyfinRelay: true,
};

function fixture(overrides = {}) {
  const requests = [];
  const request = async (url, options) => {
    requests.push(url);
    const { origin, pathname } = new URL(url);
    const role = origin === mediaOrigin ? 'media' : 'control';
    const data = pathname === '/health/ready'
      ? { status: 'ready' }
      : { ...config, role };
    return overrides[url]?.() ?? Response.json(data, {
      headers: { 'Access-Control-Allow-Origin': options.headers.Origin },
    });
  };
  return { requests, request };
}

test('the Vercel build checks both Render roles, readiness and the production origin', async () => {
  const { requests, request } = fixture();
  await checkDeployment(env, request);
  assert.deepEqual(requests, [
    'https://control.example/api/config', 'https://control.example/health/ready',
    'https://media.example/api/config', 'https://media.example/health/ready',
  ]);
});

test('deployment check rejects the legacy endpoint and a mismatched Firebase project', async () => {
  const legacy = fixture({ 'https://control.example/api/config': () => new Response('', { status: 404 }) });
  await assert.rejects(checkDeployment(env, legacy.request), /returned 404.*Deploy main/);
  const current = fixture();
  await assert.rejects(checkDeployment({ ...env, VITE_FIREBASE_PROJECT_ID: 'another-project' }, current.request), /same Firebase project/);
});

test('deployment check catches blocked browser origins, unready Redis and inconsistent service settings', async () => {
  const blocked = fixture({ 'https://control.example/api/config': () => new Response('', { status: 403 }) });
  await assert.rejects(checkDeployment(env, blocked.request), /CLIENT_ORIGINS/);
  const unready = fixture({
    'https://control.example/health/ready': () => Response.json({ status: 'unavailable' }, {
      status: 503, headers: { 'Access-Control-Allow-Origin': 'https://samerow.example' },
    }),
  });
  await assert.rejects(checkDeployment(env, unready.request), /HTTP 503/);
  const mismatched = fixture({
    'https://media.example/api/config': () => Response.json({ ...config, role: 'media', jellyfinRelay: false }, {
      headers: { 'Access-Control-Allow-Origin': 'https://samerow.example' },
    }),
  });
  await assert.rejects(checkDeployment(env, mismatched.request), /same MEDIA_PUBLIC_URL/);
});

test('the existing Render service can publish basic rooms with the existing Vercel configuration', async () => {
  const origin = 'https://samerow-v2.onrender.com';
  const legacy = fixture({
    [origin + '/api/config']: () => new Response('', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } }),
    [origin + '/api/status']: () => Response.json({ message: 'Server is running' }, { headers: { 'Access-Control-Allow-Origin': '*' } }),
  });
  await checkDeployment({ VERCEL_ENV: 'production' }, legacy.request);
  assert.deepEqual(legacy.requests, [origin + '/api/config', origin + '/api/status']);
});
