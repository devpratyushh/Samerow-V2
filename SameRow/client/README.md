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
YouTube and Jellyfin use the same custom playback controls, including keyboard seeking, local volume/mute, and room fullscreen. Fullscreen puts circular participant previews along the left edge and keeps the self-preview near the bottom; players stay mounted. While watching, the top and bottom bars slide away independently without resizing the video. Move to the corresponding window edge to reveal a bar; hovering controls, dragging a slider, or keyboard focus keeps them accessible. Touch taps reveal both bars.

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
permission, Jellyfin host controls, chat draft/scroll/focus, mobile keyboard sizing,
fullscreen dialogs, custom YouTube playback/seek/volume controls, circular participant layouts, fullscreen enter/exit and auto-hide, and mocked MSE/pump lifecycle and cancellation. The development
fixtures under `tests/` are not imported by the production app.

Codec decoding, a real Jellyfin server, Google sign-in, and Firestore permissions
require their respective services and are outside the deterministic browser suite.
MPEG-TS playback requires browser support; unsupported formats now show a readable
error instead of a permanent loading indicator.
