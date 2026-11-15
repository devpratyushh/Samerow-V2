# Mellettem Connect for Jellyfin

This plugin connects a Jellyfin server to Mellettem using outbound HTTPS. The server administrator approves pairing on Mellettem Web, then selects the connected server in the Mellettem library dialog. The paired plugin automatically starts its direct WebRTC sender on supported platforms. Playback uses the HTTPS relay when direct delivery is unavailable.

## Install from the Jellyfin catalog

**The published beta targets Jellyfin 12.3 and .NET 10.** Mellettem Connect 1.0.6.0 is available from the catalog and includes connection metrics. A [third-party directory submission](https://github.com/jellyfin/jellyfin.org/pull/2089) is awaiting maintainer review. Inclusion in Jellyfin's default repository requires separate acceptance.

1. Open Jellyfin **Dashboard → Plugins → Repositories** and add a repository.
2. Name it **Mellettem Connect** and paste this URL:

   ```text
   https://raw.githubusercontent.com/devpratyushh/Samerow-V2/main/jellyfin-plugin-samerow/manifest.json
   ```

3. Save, open **Catalog**, and select **Mellettem Connect**. Refresh the catalog if needed.
4. Install the latest catalog version and restart Jellyfin. Existing installations keep their pairing.
5. Open **Dashboard → Plugins → Mellettem Connect** and follow the pairing steps below.

[Release downloads and corresponding source](https://github.com/devpratyushh/Samerow-V2/releases/tag/mellettem-connect-v1.0.6.0). If the plugin does not appear, check your Jellyfin version: this package has been built and tested against 12.3. It has not been validated on other versions. Older releases such as 10.x need a separate compatible build.

## Compatibility and build

This package targets Jellyfin 12.3 and .NET 10. Build against your Jellyfin server assemblies:

```sh
dotnet build jellyfin-plugin-mellettem/Mellettem.Plugin.csproj -c Release -p:JellyfinServerPath=/absolute/path/to/jellyfin
python3 jellyfin-plugin-mellettem/package.py
```

The default assembly path is the workspace's sibling jellyfin-sandbox/jellyfin directory. Other Jellyfin versions require a compatible build and validation.

## Manual installation and pairing

1. Stop Jellyfin.
2. Download `Mellettem-Connect-1.0.6.0.zip` from the [release](https://github.com/devpratyushh/Samerow-V2/releases/tag/mellettem-connect-v1.0.6.0) and extract it into Jellyfin's `plugins/Mellettem Connect_1.0.6.0` directory. Keep the DLL, icon, metadata, and sender executables directly inside that directory.
3. Start Jellyfin and open Dashboard → Plugins → Mellettem Connect.
4. Select Connect, sign in to Mellettem Web, and approve the connection.
5. Return to the plugin page and wait for Connected. Open Mellettem Web and select the connected server in the Jellyfin library dialog.
6. Sign in to Jellyfin to choose the movie. Guests receive access scoped to the room's selected movie.

The dashboard shows how long the relay has been connected, how long the last completed connection lasted, and the latest connection and relay activity times. Relay durations begin with the first successful authenticated gateway poll. The dashboard also shows active requests, completed requests, and relayed data. Metrics reset when Jellyfin restarts.

Disconnect stops relay workers and revokes the connector credential. Library access follows the Jellyfin account's permissions. Custom library allowlists are unsupported and rejected.

The hosted Mellettem frontend and backend include connector discovery and self-revocation. Self-hosted deployments must run the matching application/backend version.

## Credential protection and recovery

Credentials are encrypted in plugin XML with AES-GCM. Back up the plugin configuration and its adjacent credential key together. The key is under `Mellettem/credential.key` on a fresh install and can be under `SameRow/credential.key` on upgraded installations. On Unix, the key directory is owner-only and the key file is mode 0600. On Windows, restrict the Jellyfin configuration directory to the service account and administrators. Anyone with access to both the ciphertext and key can recover the credential.

Use Rotate credential in the dashboard to replace the cloud token. A proposed replacement is saved encrypted before sending it, so a failed request can be retried after restart. Retry a pending rotation before disconnecting. Pairing approvals can be claimed once. If the claim response is lost before it reaches the plugin, start a new pairing flow.

## Updating and uninstalling

Update through the catalog and restart Jellyfin. For a manual update, stop Jellyfin, install the entire new package, then restart. Verify Connected in the dashboard. Keep the plugin configuration and encryption key during upgrades.

To uninstall, disconnect in the dashboard first to revoke cloud access, stop Jellyfin, and remove the plugin directory. Remove its configuration and key only when you no longer need the pairing. Removing the DLL alone does not revoke cloud credentials. The Mellettem connected-server page also supports removing the server.

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

The plugin settings page uses Jellyfin's `ApiClient.ajax` for status, pairing, and settings requests so authentication follows the current Jellyfin session. Request errors appear in the connection status panel with guidance for expired sessions and missing administrator access.

The GitHub Actions plugin workflow builds, tests and packages against official Jellyfin 12.3 assemblies. The ZIP includes the plugin DLL, Jellyfin metadata, license, source information, and platform sender executables with their notices. SHA-256 sidecars accompany downloadable archives. The catalog uses Jellyfin's expected MD5 checksum.

See [Mellettem V3 direct media](../docs/direct-media.md) for sender configuration, fallback behavior, and staging checks.

Each viewer’s WebRTC connection can stay open for the entire movie session while authorized. The plugin sender’s authorization expires 8 seconds after the last successful renewal.

The release is marked beta because full hosted HTTPS/Google approval and playback across separate networks with three guests still need acceptance testing. Local integration results are recorded in [test-results/README.md](test-results/README.md).

For a new release, update the assembly and metadata version together, build and test, tag the exact source, publish the ZIP and corresponding source archive, then run `python3 jellyfin-plugin-mellettem/package.py --source-url HTTPS_ZIP_URL`. This downloads the public ZIP and requires exact byte equality before generating `dist/manifest.json`. Add the verified version to `jellyfin-plugin-samerow/manifest.json` at the existing catalog URL, commit and push it, then verify the public URL. Never replace the bytes for an already-published version.

## License

The plugin and its build/test files are [GPL-3.0-or-later](LICENSE). [LICENSING.md](LICENSING.md) describes the scope and corresponding source. Mellettem's web application and backend retain their existing license.
