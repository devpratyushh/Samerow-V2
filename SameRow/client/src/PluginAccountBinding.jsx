import { useEffect, useState } from 'react';
import { onIdTokenChanged } from 'firebase/auth';
import { auth, accountActions } from './firebase';
import { accountAuthError } from './accountAuth';
import { discoverAccountConnectors } from './connectorDiscovery';
import { jellyfinRequest } from './jellyfinAccount';
import Dialog from './components/Dialog';
import JellyfinDialog from './components/JellyfinDialog';

export default function PluginAccountBinding({ id, base }) {
  const [user, setUser] = useState(undefined);
  const [server, setServer] = useState(null);
  const [bound, setBound] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => onIdTokenChanged(auth, value => { setUser(value); setServer(null); setBound(null); setConfirmed(false); }), []);
  useEffect(() => {
    if (!user || user.isAnonymous) return;
    const controller = new AbortController();
    Promise.all([discoverAccountConnectors(base, { signal: controller.signal }), jellyfinRequest(base, '/connections', { signal: controller.signal })]).then(([servers, links]) => {
      if (controller.signal.aborted) return;
      const selected = servers.find(value => value.id === id);
      if (!selected) { setError('This server is paired with a different SameRow account, or its pairing expired. Sign in with the account used to approve the plugin.'); return; }
      setServer(selected); setError('');
      setBound(links.connections?.find(value => value.account.serverUrl === selected.address)?.account || null);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [user, id, base]);
  const signIn = async () => {
    setBusy(true); setError('');
    try { await accountActions.signIn('google.com'); }
    catch (failure) { setError(accountAuthError(failure)); }
    finally { setBusy(false); }
  };
  const finish = () => window.location.assign('/');
  const signedIn = user && !user.isAnonymous;
  return <main className="lobby"><Dialog open={!confirmed} title="Bind SameRow and Jellyfin" onClose={finish} description="Confirm the account that will own this Jellyfin connection.">
    {signedIn ? <><p>SameRow account: <strong>{user.email || user.displayName}</strong></p><p>{bound ? `Jellyfin account: ${bound.userName} on ${bound.serverName}. These accounts are already bound.` : 'Your Jellyfin user will be linked to this account and remembered when you return to SameRow.'}</p>
      {server && <button className="sr-button sr-button--primary" onClick={bound ? finish : () => setConfirmed(true)}>{bound ? 'Continue to SameRow' : 'Continue and connect Jellyfin'}</button>}
      {!server && !error && <p role="status">Checking this server’s account binding…</p>}
      <button className="sr-button" disabled={busy} onClick={signIn}>Use another Google account</button>
    </> : <><p>Sign in to SameRow with Google first. You’ll then confirm the account before connecting your Jellyfin user.</p><button className="sr-button sr-button--primary" disabled={busy || user === undefined} onClick={signIn}>Sign in with Google</button></>}
    {error && <p role="alert">{error}</p>}
  </Dialog>{confirmed && server && <JellyfinDialog open connectOnly base={base} initialServerUrl={server.address} sameRowAccount={user.email || user.displayName} onClose={finish} />}</main>;
}
