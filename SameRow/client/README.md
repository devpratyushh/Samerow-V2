# SameRow client

A responsive room for video calls, screen sharing, YouTube, Jellyfin, and chat.

## Development

Use Node 20.19+ or 22.12+ and install dependencies with `npm ci`.
Run `npm run dev`. To use the local signaling server, copy `.env.example` to
`.env.local` and start `../server` on port 3000. The existing hosted backend remains
the default when `VITE_SOCKET_URL` is omitted.

## UI preview

Open `/ui-preview` on the development server to inspect layouts with sample data.
It does not request camera access, connect to a room, or write chat messages.
The preview is excluded from the production application.

Examples:

- `/ui-preview?scene=lobby`
- `/ui-preview?scene=call&count=8`
- `/ui-preview?scene=screen&count=4`
- `/ui-preview?scene=youtube&count=3&chat=1`
- `/ui-preview?scene=multiple&count=4`
- `/ui-preview?scene=buffering` or `?scene=error`

The preview settings button lets you change the scene and participant count.

## Layout and media ownership

`Room.jsx` owns the room connections and streaming lifecycle. `components/RoomView`
owns presentation, source focus, participant pinning, fullscreen, and panels.
`MediaTile` keeps the same video element across view changes. Layout changes use
CSS reflow and visibility, retaining media buffers and stream instances.

Source focus is local: choosing a different source keeps the other players mounted
and mutes unfocused shared media. Explicit stop/close actions end the selected
stream or video. Camera tiles fill their frame; screens and media use contain-fit.
YouTube uses custom playback controls, including keyboard seeking, local volume/mute, and room fullscreen. Fullscreen puts circular participant previews along the left edge and keeps the self-preview near the bottom; players stay mounted. Outside fullscreen, the room header, Everyone / YouTube source row, and call controls stay visible. Video controls fade independently during playback and reappear on video movement, touch, or keyboard focus; they stay visible while paused or loading. In fullscreen, the window edges reveal room controls separately. The YouTube share form preloads the provider and API, and blocked autoplay offers a local join action without pausing the room.

YouTube synchronization uses acknowledged server timestamps and round-trip calibration,
independent of the viewer's system clock. Playing commands account for upstream travel;
received snapshots account for downstream travel. Commands are sent on user intent,
without waiting for local buffering. Room revisions reject outdated snapshots.
Active rooms refresh every two seconds; each player checks drift every 250 ms.
Small offsets are tolerated, supported gentle speed changes correct gradual drift,
and coarse-rate YouTube players use bounded seeks for sustained or large offsets.
Buffering, pending seeks, autoplay denial, and disconnect suspend correction; recovery
and returning to the tab catch up locally without broadcasting a new room command.

Deploy/restart both the client and `SameRow/server` for calibrated network compensation.
Older servers remain compatible but cannot provide calibrated travel-time estimates.
Use `npm run test:sync` for deterministic playback stalls, clock drift, and two real
signaling clients with simulated 200/500 ms round trips; media decoding itself is mocked.


Chat stays mounted to preserve drafts, subscriptions, unread counts, and reading
position. It docks on wide screens and uses a keyboard-aware dialog on compact ones.

## Checks

```sh
npm run lint
npm test
npm run build
```

The unit/integration tests use Node's test runner. The signaling integration test
opens an ephemeral loopback server, so allow local networking.

For browser checks, keep Vite running and set its actual address:

```sh
UI_BASE_URL=http://127.0.0.1:5173 npm run test:ui
```

Browser checks require Playwright and a Chromium-compatible browser. They use an
installed Playwright runtime when available. Set `BROWSER_PACKAGE_DIR` to a folder
containing its package, and `BROWSER_EXECUTABLE` to a browser executable if needed.
For a standalone installation, install Playwright and its Chromium browser before
running these scripts. Screenshots/results go to `/tmp/samerow-ui` by default;
`UI_ARTIFACT_DIR` can change this location.

Coverage includes the viewport/state matrix, lobby validation, persistent video
DOM, actual two-peer WebRTC signaling/media, screen-share start/stop, late camera
permission, Jellyfin library opening/cancellation, chat draft/scroll/focus, mobile keyboard sizing,
fullscreen dialogs, custom YouTube playback/seek/volume controls, circular participant layouts, fullscreen enter/exit and auto-hide, and mocked MSE/pump lifecycle and cancellation. The development
fixtures under `tests/` are not imported by the production app.

Google sign-in and Firestore permissions require their respective services. The native Jellyfin acceptance suite below uses a real Jellyfin server and decodes its media. The legacy pump harness remains separate from the production room.

## Jellyfin shared playback

The room uses HTTP HLS playback through `SameRow/server/jellyfin.js`, with shared
play/pause/seek/stop and per-viewer audio/subtitle selection. Deploy the updated
backend with this client. The room backend must be able to reach the Jellyfin
address. Set `VITE_SOCKET_URL` for a local/LAN backend; the default hosted backend
cannot reach a Jellyfin server on your local machine. Credentials remain in backend
memory, and per-viewer media access expires on disconnect or stop.

`npm run test:jellyfin` generates HLS media with FFmpeg and tests five real browser
peers, shared controls, independent audio/subtitles, responsive/fullscreen controls,
and drift recovery against a local fixture API. Set `FFMPEG_PATH` and
`BROWSER_EXECUTABLE` when needed. The test does not use a real Jellyfin login.


## Native Jellyfin integration

Use **Share something → Your Jellyfin library**, enter the server address, and
sign in with a Jellyfin username/password or **Use Quick Connect**. Quick Connect
shows a code to approve from Jellyfin's Settings → Quick Connect. Passwords are
never saved. Remembered connections reopen the library after reloads; uncheck
**Remember this connection** to limit it to the browser session. **Disconnect**
forgets the connection and revokes its upstream login.

Search or browse movies, series, seasons, and episodes, then choose **Watch together**.
The room displays the server's actual Jellyfin Web player and its native playback,
audio, subtitle, chapter, volume, and quality menus. Play/pause and seeking are
shared; audio, subtitles, quality, volume, and source focus stay local. Friends
join through the room link and do not need the library owner's Jellyfin login.
SameRow coordinates the room timeline; Jellyfin SyncPlay is disabled in this player
so two synchronization systems do not compete. Episode autoplay is limited to the
selected item; choose the next episode in the library.

The Node backend must reach both the Jellyfin API and `/web/` client assets.
A LAN-only server requires a backend running on that LAN. Set `VITE_SOCKET_URL`
to that backend, rebuild the frontend, and deploy/restart both components together.
Use HTTPS for public deployments. Movies travel through the backend using HTTP;
provision its bandwidth and Jellyfin transcoding capacity for concurrent viewers.
Jellyfin Web 12.3.0 is covered by the real-server acceptance test.

Set `SAMEROW_DATA_DIR` on the backend to a private persistent directory. The default
is `server/.data`; remembered Jellyfin access tokens are stored there with mode
0600, never sent to room guests, and expire after 30 days without use. Protect and
persist that directory across restarts. An ephemeral hosting filesystem cannot
preserve remembered connections across redeploys. Each viewer receives temporary
access restricted to the chosen video, invalidated on disconnect or stop. The native
web client runs in an opaque iframe with private in-memory preferences/cache and
cannot access SameRow's browser storage. Room IDs serve as invitations; use private,
unpredictable IDs for private watch parties.

### Real-server acceptance check

Start Vite and the disposable Jellyfin sandbox, then run:

```sh
UI_BASE_URL=http://127.0.0.1:5175 npm run test:jellyfin
```

The test reads an existing sandbox API key in memory to approve Quick Connect;
it does not print credentials or change accounts. Outside this workspace set
`JELLYFIN_URL`, `JELLYFIN_TEST_API_KEY`, and `JELLYFIN_TEST_USER_ID` for a test server
containing **Multitrack Test** (the sandbox's five-minute, two-audio/two-subtitle
sample). Alternatively set `JELLYFIN_SANDBOX_DB` to its SQLite database. Browser
runtime/executable discovery is the same as the other UI tests. The suite verifies
real login errors, Quick Connect, remembered sessions, library search, decoded video
in three independent browser sessions, native shared controls, personal tracks,
late join, focus mute, reconnect, fullscreen, responsive layout, guest API scope,
message validation, and shared stop/access revocation. `JELLYFIN_TEST_AUTOPLAY=blocked`
runs with the browser's normal autoplay policy rather than the test override.
`test:jellyfin:legacy` retains the previous generated HLS fixture coverage.
## Google, GitHub, and connected Jellyfin servers

To use both Google and GitHub with the same libraries, sign in with the existing
method, open **Manage account**, then select **Link GitHub** or **Link Google**.
Linking preserves the Firebase UID. Separate existing accounts are not merged
by matching email addresses; a provider already used by another account must be
used to sign in to that account instead.

Deployment setup for GitHub sign-in:

1. Create a GitHub OAuth App for this SameRow deployment.
2. In Firebase Console → Authentication → Sign-in method, enable GitHub and set
   the OAuth App's client ID and secret. Keep the secret in the provider settings.
3. Copy the callback URL shown by Firebase into the GitHub OAuth App. For the
   default project it is `https://mellettem-4f7ee.firebaseapp.com/__/auth/handler`;
   use your configured Firebase auth domain if overridden.
4. Verify the deployed SameRow hostname is in Firebase's authorized domains, then
   test Google sign-in → Link GitHub → sign out → GitHub sign-in. The same paired
   servers should appear.

The client implements provider sign-in, linking and connector approval with either
provider. Enabling a provider requires the console setup above. See the official
[Firebase GitHub setup](https://firebase.google.com/docs/auth/web/github-auth) and
[account linking guide](https://firebase.google.com/docs/auth/web/account-linking).

### Link a Jellyfin user from the dashboard

The dashboard distinguishes **Server paired** from **Library connected**. After
signing into SameRow with a paired server, a popup asks for the Jellyfin username
and password or Quick Connect approval. **Connect accounts** explicitly saves the
Jellyfin user connection under the verified SameRow UID. Passwords are not stored.
The encrypted remembered connection can be discovered on another browser signed
into the same SameRow account and restored by the room's library picker.

Anonymous guests and plugin connector host sessions cannot create or discover
these user links. Disconnecting the Jellyfin login removes the link; revoking the
plugin connection invalidates links through that connector. Deploy the matching
server and client for this flow. The client requires a server acknowledgement of
the link before showing success.

### Opening SameRow from the Jellyfin plugin

The plugin Open SameRow action opens a server-scoped binding confirmation.
Signed-out users first sign in with Google; signed-in users see the account that
will own the binding before continuing to Jellyfin authentication. Existing links
show both accounts and can continue directly to the lobby. The plugin settings
page reads account binding through its authenticated connector and displays the
SameRow email and Jellyfin user. This flow requires the updated plugin binary
as well as the matching web and backend changes.
