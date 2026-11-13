# SameRow Connect for Jellyfin

This plugin connects a Jellyfin server to SameRow using outbound HTTPS. The server administrator approves pairing on SameRow Web, then selects the connected server in the SameRow library dialog. Media passes through the relay as binary data. Playback quality and audio/subtitle choices use SameRow's existing player.

## Compatibility and build

This package targets Jellyfin 12.3 and .NET 10. Build against your Jellyfin server assemblies:

```sh
dotnet build jellyfin-plugin-samerow/SameRow.Plugin.csproj -c Release -p:JellyfinServerPath=/absolute/path/to/jellyfin
python3 jellyfin-plugin-samerow/package.py
```

The default assembly path is the workspace's sibling jellyfin-sandbox/jellyfin directory. Other Jellyfin versions require a compatible build and validation.

## Install and connect

1. Stop Jellyfin.
2. Extract the ZIP from dist into Jellyfin's plugins/SameRow_1.0.1.0 directory.
3. Start Jellyfin and open Dashboard → Plugins → SameRow Connect.
4. Select Connect, sign in to SameRow Web, and approve the connection.
5. Return to the plugin page and wait for Connected. Open SameRow Web and select the connected server in the Jellyfin library dialog.
6. Sign in to Jellyfin to choose the movie. Guests receive access scoped to the room's selected movie.

Disconnect stops relay workers and revokes the connector credential. Library access follows the Jellyfin account's permissions. Custom library allowlists are unsupported and rejected.

The hosted SameRow frontend and backend must include the connector discovery and self-revocation endpoints from this change before production use.

## Credential protection and recovery

Credentials are encrypted in plugin XML with AES-GCM. Back up the plugin configuration and its adjacent SameRow/credential.key together. On Unix, the key directory is owner-only and the key file is mode 0600. On Windows, restrict the Jellyfin configuration directory to the service account and administrators. Anyone with access to both the ciphertext and key can recover the credential.

Use Rotate credential in the dashboard to replace the cloud token. A proposed replacement is saved encrypted before sending it, so a failed request can be retried after restart. Retry a pending rotation before disconnecting. Pairing approvals can be claimed once. If the claim response is lost before it reaches the plugin, start a new pairing flow.

## Updating and uninstalling

Stop Jellyfin, replace the plugin DLL and metadata with the new package, then restart. The previous plaintext credential is migrated when the plugin loads. Verify Connected in the dashboard. Keep the encryption key during upgrades.

To uninstall, disconnect in the dashboard first to revoke cloud access, stop Jellyfin, and remove the plugin directory. Remove its configuration and key only when you no longer need the pairing. Removing the DLL alone does not revoke cloud credentials. The SameRow connected-server page also supports removing the server.

## Troubleshooting

- An expired approval requires starting Connect again.
- AuthenticationFailed means the cloud rejected the credential. Retry a pending rotation or reconnect.
- Reconnecting after network loss uses bounded retries. Check outbound HTTPS and the cloud service status.
- If library browsing works but video fails, use Auto or a manual bitrate limit and inspect Jellyfin's playback/transcoding logs.
- Original mode copies the video. Compatible audio can also be copied. Unsupported audio can be converted independently. Image subtitle burn-in requires video conversion.
- Keep the hosted frontend and backend on matching versions.

The supported hosted topology uses one media replica, as configured in render.yaml. Control services can scale using Redis. Connector polls and stream bodies belong to the media process and are not transferred through Redis. Multiple media replicas require explicit connector routing before enabling them.

## Verification and distribution

Run the plugin test executable with JELLYFIN_SERVER_PATH pointing at the server assemblies. Run SameRow/client/tests/jellyfin-plugin.browser.mjs against the disposable workspace Jellyfin sandbox and Vite on port 5175 to exercise a real C# worker, Jellyfin media, the gateway and four browser viewers. It uses loopback HTTP and development identities inside its test harness. It does not establish production HTTPS, Firebase, separate-network or installed-plugin acceptance.

The GitHub Actions plugin workflow builds, tests and packages against official Jellyfin 12.3 assemblies. A workflow run on GitHub is still required. The checked-in manifest.json is an empty catalog. After a genuine compatible release is published, run package.py --source-url HTTPS_ZIP_URL to verify the published bytes and generate dist/manifest.json for hosting. Public publication also requires resolving the licensing decision described in LICENSING.md.
