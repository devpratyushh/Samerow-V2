# SameRow

Watch movies and YouTube together while you talk, chat, and share your screen.
Play, pause, and seek follow the room. Everyone chooses their own volume,
and Jellyfin viewers can choose their own audio language, subtitles, and quality.

[Open SameRow](https://samerow-v2.vercel.app/) ·
[Plugin setup](jellyfin-plugin-samerow/README.md) ·
[Docker setup](docs/jellyfin-pilot.md) ·
[Self-hosting](docs/production.md)

![SameRow watch room with shared video, participant tiles, and chat](docs/images/watch-room.jpg)

## Host from your home Jellyfin server

**Install the plugin → Pair your server → Open SameRow → Watch together.**

SameRow Connect is a native Jellyfin server plugin. It lets your home server
deliver movies to a hosted SameRow room through an outbound HTTPS connection.
Your friends join from their browsers.

### Set it up once

1. Install **SameRow Connect** on your Jellyfin server and restart Jellyfin.
2. Open **Dashboard → Plugins → SameRow Connect** and select **Connect SameRow**.
3. Sign in to SameRow Web with Google and approve the connection.
4. Return to Jellyfin's plugin settings and wait for **Connected**.

The public beta targets **Jellyfin 12.3 and .NET 10**. Add this third-party repository in **Dashboard → Plugins → Repositories**, install **SameRow Connect** from **Catalog**, and restart Jellyfin:

```text
https://raw.githubusercontent.com/devpratyushh/Samerow-V2/main/jellyfin-plugin-samerow/manifest.json
```

[Download the plugin and source](https://github.com/devpratyushh/Samerow-V2/releases/tag/samerow-connect-v1.0.1.0) or follow the [installation and compatibility guide](jellyfin-plugin-samerow/README.md). This is SameRow's repository; acceptance into Jellyfin's default catalog or community directory is separate.

### Start a watch party

1. Open [SameRow Web](https://samerow-v2.vercel.app/).
2. Expand **Connect Jellyfin** and select **Generate private room code**.
3. Enter your name and join the private room.
4. Open **Share something → Your Jellyfin library** and select your connected server.
5. Sign in to Jellyfin or use **Quick Connect**. You can remember the connection.
6. Browse your library and select a movie.
7. Use **Invite friends** and send the full invitation link.

Friends open the invitation, enter their names, and join. The hosted Jellyfin
pilot supports **one host and up to three guests**. Guests can join with their
camera and microphone off and receive access to the selected movie through
the room.

Your home server, Jellyfin, and internet connection must stay running during
the party. Once pairing is complete, you can close Jellyfin's dashboard.

### Audio, subtitles, and quality

| Setting | What happens |
| --- | --- |
| Play, pause, and seek | Everyone follows the shared timeline. |
| Audio language | Each viewer selects a track from the movie. |
| Subtitles | Each viewer selects their own subtitles or turns them off. |
| Volume and mute | Each viewer controls their own sound. |
| Original | Copies the source video when the device, selected tracks, and available bandwidth permit it. |
| Auto | Uses compatible playback and adjusts to connection conditions. |
| Manual quality | Caps bitrate on that device at 4, 8, or 20 Mbps. Jellyfin may convert the video. |

One viewer can use Japanese audio with English subtitles while another uses
the English dub. Text subtitles are displayed over the picture. Subtitles
that need to be burned into the picture require video conversion for the
viewer who selects them. Unsupported audio can be converted independently
while the video stays original.

Original playback sends binary media through the gateway and feeds compatible
segments into the browser's Media Source Extensions player. When a container
needs repackaging, Jellyfin can remux the video without re-encoding it.
SameRow reports when it switches to compatible playback. The track menu also
offers the embedded **Jellyfin Web player**.

HDR and particular audio formats depend on the source, browser, and device.
HDR acceptance testing is still pending.

## How the plugin connects

The plugin maintains authenticated outbound HTTPS requests to SameRow's media
gateway. The gateway returns library or playback work through that connection.
The plugin calls Jellyfin's local API and streams each response back to the gateway,
which delivers it to the viewer.

```mermaid
flowchart LR
    Jellyfin[Home Jellyfin server]
    Plugin[SameRow Connect plugin]
    Gateway[SameRow media gateway]
    Browser[Viewer browser]
    Control[Room control service]

    Plugin <-->|Local Jellyfin API| Jellyfin
    Plugin <-->|Outbound HTTPS relay| Gateway
    Browser <-->|Library requests and binary video| Gateway
    Browser <-->|Play, pause, seek and chat| Control
```

Pairing links the server to the owner's SameRow account. The plugin stores an
encrypted connector credential and reconnects after interruptions. Media
access is scoped to the room, selected item, and current viewer membership.
Guests receive playback access without receiving the owner's upstream credential.

This setup works with Jellyfin on a local server through the plugin's outbound
connection. It requires **no separate Docker connector, inbound Jellyfin port,
or guest Jellyfin account**.

### Upload and room capacity

Media is relayed separately to each viewer. Four viewers streaming at 8 Mbps
can use roughly **32 Mbps of home upload**, plus headroom for bitrate peaks and
calls. Original-quality sources can require substantially more bandwidth.

The hosted pilot currently uses four participants per room and **one media
replica**. Control services share state through Redis. Multiple media replicas
need explicit connector routing before they can be enabled.

## Stats for nerds and local video quality

In a room, open **More options → Stats for nerds**. While open, it refreshes
call upload/download, each peer’s bitrate, resolution, FPS, codec, packet loss,
jitter and available encoder/RTT information every five seconds. Unsupported
browser metrics appear as unavailable. Call stats describe this device’s links;
in hosted rooms, upload goes to LiveKit and received tracks come from LiveKit.

For Jellyfin, the panel shows media delivered to each current room member and
their reported decoded resolution, buffered seconds, and dropped/total frames.
Delivery is measured at the gateway, includes prefetch/retries, and is separate
from the encoded movie bitrate. The first sample measures a baseline; a fully
buffered viewer can receive zero bytes while playback continues. Viewer reports
expire after 20 seconds without updates. Only current room members can request
these stats. Credentials, upstream addresses and access tokens are excluded.

These measurements use the same media gateway for direct Jellyfin, the Docker
connector, and the native SameRow Connect plugin. Deploy matching web/server
revisions; rebuild the local Docker image to include the panel. No plugin binary
or connector protocol update is required. Redis shares counters when the control
service and media gateway run separately.

Camera capture requests 1920×1080 at 30 FPS, subject to device support, and stays
independent of outgoing limits. SameRow Local uses a peer mesh. Its optional
**Balanced upload** policy divides a 1.2 Mbps
camera budget among receivers and lowers outgoing camera video to 320×180 from four
participants, regardless of LAN speed. Screen sharing similarly divides a
2.4 Mbps budget. This can cause blur even when all devices are on the same Wi-Fi.
High quality is the default. Choose **Call quality on this device → High quality** in the stats panel
to allow 1920×1080 cameras at up to 4 Mbps per receiver and 1920×1080 screen
sharing at up to 6 Mbps per receiver, up to 30 FPS. Each sender chooses its own
policy. The browser can still adapt under CPU or network pressure. With several
peers, these per-receiver uploads add up.

Jellyfin movies use their own **Quality on this device** menu. Auto, manual bitrate
caps, shared gateway/origin limits, codec support and subtitle burn-in can cause
conversion independently of call quality. **Original** requests source video when
supported and within configured capacity. Connecting locally does not bypass a
hosted gateway: use the local Docker edition for LAN delivery. Camera quality
settings do not alter Jellyfin or YouTube movies.

## Other ways to use SameRow

| What you want | Setup |
| --- | --- |
| YouTube, calls, chat, and screen sharing | Open SameRow Web or deploy the [hosted edition](docs/production.md). |
| A home Jellyfin server with friends online | Use [SameRow Connect](jellyfin-plugin-samerow/README.md). |
| The existing Docker connector workflow | Follow the [hosted Jellyfin pilot guide](docs/jellyfin-pilot.md). |
| Everyone watching on the same home network | Run [SameRow Local](docs/local-edition.md) with Docker Compose. |
| Work on the code | Follow [local development](#local-development). |

The Docker connector remains supported. In SameRow Local, select
**Host for friends online**, approve the connection in your browser, then
share the full room invitation. The [Docker guide](docs/jellyfin-pilot.md)
covers installation and pairing.

## Join a room

Open the invitation link, enter your name, and select **Enter room**.
Public rooms also accept a room code. Private rooms require the full invitation.
The lobby generates a four-letter code when you start a room.

![SameRow lobby with name and room code fields](docs/images/lobby.jpg)

## Architecture

Read the [movie delivery and quality guide](docs/media-architecture.md) for public
Jellyfin and plugin paths, the media gateway, four-viewer bandwidth, quality
selection, synchronization, and local blur troubleshooting.

| Component | Role |
| --- | --- |
| React and Vite | Lobby, room layout, library browsing, player controls, and chat |
| Node.js, Express, and Socket.IO | Room admission, signaling, shared playback state, and chat |
| Redis | Shared state, membership leases, rate limits, and encrypted Jellyfin connection records |
| Firebase | Hosted Google and guest authentication, plus Firestore chat history |
| LiveKit | Hosted camera, microphone, and screen tracks |
| Jellyfin media gateway | Scoped access to library APIs and media |
| SameRow Connect | Native C# plugin using Jellyfin's APIs and existing media engine |
| Docker connector | Alternate outbound relay for existing installations |

Hosted deployments use a LiveKit SFU. SameRow Local uses a small WebRTC peer
mesh. YouTube viewers load video from YouTube and receive the shared timeline
from SameRow.

Clients correct playback drift locally. Rejoining tabs refresh their room
access and can reclaim a seat in a full room. Movie delivery uses the media
gateway, and call tracks use LiveKit.

## Local development

Use **Node.js 24** and npm. From the repository root, start the backend:

```sh
npm --prefix SameRow/server ci
npm --prefix SameRow/server start
```

In another terminal, start the frontend:

```sh
npm --prefix SameRow/client ci
npm --prefix SameRow/client run dev
```

Open the URL printed by Vite. Its development proxy targets the backend on
port 3000. If your backend uses another address, set `VITE_SOCKET_URL`.
For a UI preview with sample data, open `/ui-preview?scene=lobby`.

Configuration examples are in
[client/.env.example](SameRow/client/.env.example) and
[server/.env.example](SameRow/server/.env.example).
Store server credentials and connector secrets outside Git and client-side
`VITE_*` variables.

### Build the Jellyfin plugin

Use the **.NET 10 SDK** and a Jellyfin 12.3 server installation containing the
reference assemblies:

```sh
dotnet build jellyfin-plugin-samerow/SameRow.Plugin.csproj \
  -c Release -p:JellyfinServerPath=/absolute/path/to/jellyfin

python3 jellyfin-plugin-samerow/package.py
```

The ZIP and SHA-256 checksum are written to `jellyfin-plugin-samerow/dist/`.
The [plugin guide](jellyfin-plugin-samerow/README.md) covers installation,
credential backup, rotation, updates, troubleshooting, and uninstallation.

## Deployment

Deploy matching frontend and backend revisions before using the plugin with
the hosted service.

- **Hosted services.** [render.yaml](render.yaml) defines the control service,
  media gateway, and Redis. Vercel builds from `SameRow/client` using
  [vercel.json](SameRow/client/vercel.json).
- **Jellyfin relay.** Enable `JELLYFIN_RELAY_ENABLED=true` on both hosted services
  and keep one media replica. The plugin and Docker connector use the same relay.
- **SameRow Local.** [Dockerfile.local](Dockerfile.local) builds the UI and
  server into one image. [compose.local.yaml](compose.local.yaml) stores
  remembered connections in a Docker volume.

Follow the [production runbook](docs/production.md) for Firebase, LiveKit,
Redis, origins, readiness, and deployment recovery.

## Verification

The latest local run passed:

- **88 JavaScript tests** with real Redis and no skips.
- **10 C# plugin tests**, frontend lint, and production builds.
- Four browsers decoding a **generated 3840×2160 clip** through the real C#
  connector service, real Jellyfin server, and SameRow gateway.
- Exact HTTP 206 byte-range comparisons, personal audio/subtitles, shared
  seeking, reconnects, and Jellyfin video stream-copy confirmation.
- A failover probe that recovered **20 of 20 users** across two control instances.

The C# integration test uses a local host adapter, development identities, and
loopback HTTP. Full acceptance with an installed plugin, hosted HTTPS/Google
approval, and guests on separate networks remains pending. High-bitrate HDR
and every browser/codec combination are also outside the completed test run.

Read the [verification report](jellyfin-plugin-samerow/test-results/README.md)
for results, fixes, commands, and remaining limits.

### Run checks

```sh
npm --prefix SameRow/server test
npm --prefix SameRow/client test
npm --prefix SameRow/client run lint
npm --prefix SameRow/client run build
```

Set `TEST_REDIS_URL` to disposable local Redis to include the shared-state checks:

```sh
TEST_REDIS_URL=redis://127.0.0.1:6379 npm --prefix SameRow/server test
TEST_REDIS_URL=redis://127.0.0.1:6379 npm --prefix SameRow/server run test:reconnect
```

For plugin tests:

```sh
JELLYFIN_SERVER_PATH=/absolute/path/to/jellyfin \
  dotnet run --project jellyfin-plugin-samerow.tests \
  -c Release -p:JellyfinServerPath=/absolute/path/to/jellyfin
```

See the [client browser checks](SameRow/client/README.md#checks) and
[plugin integration guide](jellyfin-plugin-samerow/README.md#verification-and-distribution)
for the browser/runtime prerequisites and disposable Jellyfin fixture.

[Application CI](.github/workflows/ci.yml) runs Node checks and Redis recovery.
[Plugin CI](.github/workflows/jellyfin-plugin.yml) builds, tests, validates,
and uploads the plugin artifact.

## Repository layout

| Path | Contents |
| --- | --- |
| [SameRow/client](SameRow/client) | React frontend and browser tests |
| [SameRow/server](SameRow/server) | Room service, gateway, authentication, and Docker connector |
| [jellyfin-plugin-samerow](jellyfin-plugin-samerow) | Plugin source, dashboard settings, packaging, and installation guide |
| [jellyfin-plugin-samerow.tests](jellyfin-plugin-samerow.tests) | Plugin tests and local relay integration harness |
| [docs](docs) | Local setup, hosted pilot guide, and production runbook |
| [firestore.rules](firestore.rules) | Firebase chat access rules |

## License and release status

The SameRow web application and backend use an [All Rights Reserved license](LICENSE). **SameRow Connect and its build/test files are GPL-3.0-or-later**; see the [plugin license](jellyfin-plugin-samerow/LICENSE) and [scope](jellyfin-plugin-samerow/LICENSING.md).

The plugin is a public beta for Jellyfin 12.3. Local and CI verification passed; full hosted approval and playback across separate networks with three guests still require acceptance testing. The published catalog points to a verified GitHub Release ZIP and its matching source.
