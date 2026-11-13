export function createAccountActions({ auth, providers, signInWithPopup, linkWithPopup, signOut }) {
  return {
    async signIn(providerId = 'google.com', { link = false } = {}) {
      const provider = providers[providerId];
      if (!provider) throw new Error('Choose Google or GitHub to continue.');
      if (link) {
        if (!auth.currentUser || auth.currentUser.isAnonymous) throw new Error('Sign in to your existing SameRow account before linking another sign-in method.');
        const result = await linkWithPopup(auth.currentUser, provider);
        // Refresh the ID token so authenticated APIs see the linked provider.
        await result.user.getIdToken(true);
        return result;
      }
      return signInWithPopup(auth, provider);
    },
    signOut: () => signOut(auth),
  };
}

export function accountAuthError(error) {
  return ({
    'auth/popup-closed-by-user': 'Sign-in closed. You can try again.',
    'auth/cancelled-popup-request': 'Another sign-in window is already open.',
    'auth/popup-blocked': 'Allow the sign-in popup, then try again.',
    'auth/account-exists-with-different-credential': 'Sign in with your existing method, then link this provider in Manage account to keep your Jellyfin connections.',
    'auth/credential-already-in-use': 'This sign-in belongs to another SameRow account. Sign in to that account to use its connections.',
    'auth/provider-already-linked': 'This sign-in method is already linked to your account.',
    'auth/operation-not-allowed': 'This sign-in provider has not been enabled for SameRow yet.',
    'auth/network-request-failed': 'Could not reach the sign-in service. Check your connection and try again.',
  })[error?.code] || 'Could not complete sign-in. Please try again.';
}
