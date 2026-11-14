# SameRow V3 direct media

The hosted control service authenticates viewers and negotiates one WebRTC connection
per viewer. The Jellyfin plugin starts and supervises a small Pion executable
alongside its existing HTTPS connector workers. The plugin passes its existing
credentials and Jellyfin loopback origin over a private process pipe.

The June pump at `415ce170d84b` (including `6c5cd6b`, `2dcdc6f` and
`12561c7`) read a continuous MPEG-TS response in the host browser, split it
into small binary messages and appended it to Media Source. The pump coupled
viewer backpressure, host LAN availability and the room timeline. V3 retains
small frames and backpressure while transferring independently requested HLS
resources. Room synchronization and calls keep their existing transports.

The plugin could host a .NET WebRTC stack in-process, but the previously
permissively licensed SIPSorcery release considered for this has a known
vulnerability and current releases have an additional use restriction.
The MIT-licensed Pion executable isolates the WebRTC stack from Jellyfin's
assembly load context. It requires a platform build and is supervised by the
plugin. There is no separately configured daemon or additional hosted service.

- `SameRow/server/jellyfinDirect.js` exchanges SDP over the existing viewer
  Socket.IO connection and authenticated connector HTTPS. Shared storage
  bridges control and media replicas. ICE candidates travel in gathered SDP.
- `SameRow/server/jellyfin.js` shares stream planning and track/quality
  validation between relay and direct. Only the authenticated connector sees
  the upstream token. Each peer must renew a short authorization lease.
- `jellyfin-plugin-samerow/sender` fetches HLS over loopback, rewrites
  playlists to peer-scoped asset IDs, and sends bounded binary frames over
  an ordered DataChannel. The plugin worker lifecycle owns the sender process.
- `SameRow/client/src/directMedia.js` implements the HLS.js loader and
  transfer metrics. `JellyfinPlayer.jsx` validates the first manifest through
  the loader, retries failed ICE with a fresh peer, then sticks to HTTPS for
  that viewer's movie session if direct delivery fails. Native HLS uses HTTPS.

This design has no TURN dependency. Restrictive NATs can require HTTPS relay.
Browser support for HLS.js and its Media Source path determines eligibility.

## Enable and roll back

1. Build the plugin against Jellyfin 12.3. The plugin workflow builds and
   packages the sender for Linux, macOS and Windows on amd64 and arm64.
   Install the resulting ZIP and confirm the executable for the Jellyfin
   process architecture is next to `SameRow.Plugin.dll`. The package includes
   the sender dependency notices. Keep the `sender/` directory and Go module
   lock files in the corresponding source release.
2. Set `SAMEROW_DIRECT_ENABLED=true` on the Jellyfin service and restart
   Jellyfin. Existing pairing is sufficient. Set `JELLYFIN_DIRECT_ENABLED=true`
   on the control and media services together. Keep `JELLYFIN_RELAY_ENABLED`
   and the existing shared Redis and media origin configured.
3. Leave outbound UDP enabled for ICE and media. Optional comma-separated
   STUN origins can be configured with `SAMEROW_DIRECT_STUN` on Jellyfin and
   `VITE_JELLYFIN_DIRECT_STUN` at web build time. A restrictive network can
   still require HTTPS.
4. Optionally set `JELLYFIN_RELAY_DAILY_BYTES` on the gateway. It shares the
   UTC-day movie response budget across replicas and stops HTTPS movie
   delivery when it is exhausted. Zero disables the threshold. It counts
   gateway movie response payloads, so allow separately for connector ingress,
   manifests, other requests and platform billing overhead.
5. To roll back, turn off the flags on control, media and Jellyfin and restart
   those services. Keep the account binding intact.

The channel is the playback generation. The selected movie, authenticated
browser socket and connector credential bind it during signaling. Request
IDs and per-request sequence numbers are unsigned 32-bit big-endian values
in an eight-byte frame header. JSON messages carry request/cancel and
headers/end/error metadata. The connector verifies short renewable leases
and fails closed on missed renewals. Media requests carry opaque asset IDs
and a single optional byte range.

## Validation

Run the Go tests from `jellyfin-plugin-samerow/sender` with `go test -race ./...`.
Build the sender with `go build -o /tmp/samerow-sender .`. Start Vite from
`SameRow/client` on port 5175, then run
`SAMEROW_SENDER_PATH=/tmp/samerow-sender node tests/jellyfin-direct.browser.mjs`
from that directory. This test uses Chromium, FFmpeg, a two-audio HLS fixture,
the real Go sender and the current HTTP gateway. Set `BROWSER_EXECUTABLE` and
`FFMPEG_PATH` when they are not available in the usual test locations.
Set `TEST_REDIS_URL` to exercise separate control and media services on a
disposable Redis instance. CI runs that configuration.

For a staging installation with the packaged plugin and Firebase accounts:

| Procedure | Expected result |
| --- | --- |
| Pair Jellyfin at home, close all browsers there, then sign into the same Google account on mobile data. Open the discovered library and start an original-quality title. | The account discovers the linked server. A supported browser plays over WebRTC when ICE succeeds. No HLS manifests, subtitles, init segments or movie segments appear in gateway request instrumentation while direct is active. |
| Approve a guest using another ISP, then repeat with an overseas viewer. Use a title with different audio tracks, text subtitles and image subtitles. Choose different tracks on each device. Pause, seek while paused, resume, replace the movie and stop. | Each device retains its own tracks and quality. The room clock follows only playback commands. An approved guest enters the room while their video prepares. The old peer closes after replacement or stop. |
| Repeat on home LAN, home broadband across ISPs, mobile data and a restrictive CGNAT network. In a controlled test, block the viewer's outbound UDP while leaving TCP and HTTPS enabled. | Direct playback works when a candidate pair delivers media. Otherwise the player starts HTTPS once negotiation reaches its timeout. Stats for nerds show the active transport and fallback reason. |
| Introduce a short network interruption, then repeat with a longer outage on one viewer only. Restore network access. | A short disruption can recover on the same peer. A sustained direct failure switches that viewer to HTTPS and resumes near the room time. Other viewers keep their transport and playback state. |
| Leave the room as the guest, try a copied capability from another socket, rotate the connector credential, and disconnect the paired server. | Unauthorized signaling is denied. Old peers stop serving resources as their authorization is invalidated. |
| Repeat in desktop Chrome, Firefox and Safari, Android Chrome, and physical iPhone Safari. Put the device in the background, return, switch between Wi-Fi and cellular, and dismiss and retry the autoplay prompt. | HLS.js-capable devices can negotiate direct media. Devices limited to native HLS use HTTPS. Playback resumes or provides a retry action. Record the OS, browser build, chosen HLS path and transport. |
| Set the staging daily gateway budget low, then force one viewer onto HTTPS and keep another on WebRTC. | The relay stops when its budget is exhausted. The direct viewer continues. |

The loopback fixture does not cover deployed Firebase sessions, actual NAT
traversal across ISPs or an installed plugin on physical iOS. These are rollout
checks.

Local test results on macOS arm64 used Chrome/Chromium and Playwright WebKit
with decoded playback, byte-range integrity and simulated fallback. In
Playwright Firefox, the same fixture delivered and buffered HLS resources
over both WebRTC and HTTPS but produced no decoded frames. Firefox playback
requires further verification on a regular desktop Firefox installation.

The V3 pilot plugin is released separately from catalog updates. Install
version 1.0.3.0 manually for the opt-in test.
