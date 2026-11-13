import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountActions, accountAuthError } from '../src/accountAuth.js';

test('linking another provider preserves the existing account and refreshes its token', async () => {
  const calls = [];
  const user = { uid: 'existing-google-owner', isAnonymous: false, getIdToken: async force => calls.push(['token', force]) };
  const auth = { currentUser: user }, github = { providerId: 'github.com' };
  const actions = createAccountActions({ auth, providers: { 'github.com': github },
    signInWithPopup: () => assert.fail('Link must not replace the signed-in account'),
    linkWithPopup: async (...args) => { calls.push(args); return { user }; },
  });
  assert.equal((await actions.signIn('github.com', { link: true })).user.uid, 'existing-google-owner');
  assert.deepEqual(calls, [[user, github], ['token', true]]);
});

test('normal GitHub sign-in uses its provider, while guests cannot link an account', async () => {
  const auth = { currentUser: { isAnonymous: true } }, github = {};
  let used;
  const actions = createAccountActions({ auth, providers: { 'github.com': github }, signInWithPopup: async (...args) => { used = args; return { user: { uid: 'github-owner' } }; } });
  await assert.rejects(actions.signIn('github.com', { link: true }), /existing SameRow account/);
  assert.equal((await actions.signIn('github.com')).user.uid, 'github-owner');
  assert.deepEqual(used, [auth, github]);
  await assert.rejects(actions.signIn('unsupported'), /Choose Google or GitHub/);
});

test('provider collision and disabled-provider errors give actionable guidance without merging accounts', () => {
  assert.match(accountAuthError({ code: 'auth/account-exists-with-different-credential' }), /existing method.*link.*Manage account/);
  assert.match(accountAuthError({ code: 'auth/credential-already-in-use' }), /another SameRow account/);
  assert.match(accountAuthError({ code: 'auth/operation-not-allowed' }), /not been enabled/);
  assert.doesNotMatch(accountAuthError({ message: 'secret access token' }), /secret/);
});
