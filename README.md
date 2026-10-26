# SameRow-V2: Architecture & Data Pipeline

**SameRow** is a real-time collaborative platform that combines **peer-to-peer video calling** with **synchronized media playback**. It allows users to watch YouTube videos together with shared playback controls while seeing and talking to each other in a virtual room.

This project is designed to demonstrate advanced concepts in **distributed systems**, **networking**, and **real-time state management**.

### 🏗️ Architecture
SameRow uses a hybrid architecture to ensure low latency for video calls and precise state synchronization for media playback.
* **Video/Audio:** Uses **WebRTC** for a direct, peer-to-peer connection between clients.
* **Signaling & State:** Uses a central **Node.js/Socket.io** server to manage room state (video timestamps, play/pause status) and broker the WebRTC handshake.

### ✨ Key Features
* **Room-Based Video Calling:** Users can join rooms via a simple ID, instantly connecting with others.
* **Synchronized Media:**
    * Embeds YouTube links directly in the room.
    * Play, pause, and seek actions are broadcast in real-time to all users in the room.
    * Periodic drift correction keeps players close to the room's current position. Each participant loads the video directly from YouTube; media is not captured or relayed through WebRTC.
* **Peer-to-Peer (P2P) Video:** Video and audio streams go directly between users, reducing server load and latency.
* **Smart State Management:** The server maintains a deterministic state, allowing new users to join and instantly sync to the current point in the video.

### 🛠️ Tech Stack
| Component | Technology | Purpose | Deployment |
| :--- | :--- | :--- | :--- |
| **Frontend** | React, Vite | UI, Video Rendering, Media Player | Vercel |
| **Backend** | Node.js, Express | Signaling Server, API | Render |
| **Real-Time** | Socket.io | Signaling, State Synchronization | - |
| **Video/Audio** | WebRTC (simple-peer) | P2P Media Streaming | - |
| **Media Player** | react-player | Unified player for YouTube, etc. | - |

---

## Jellyfin integration

SameRow now connects to Jellyfin using normal sign-in or Quick Connect and remembers
the connection. Browse/search movies, shows, seasons, and episodes without API keys
or item IDs. The room embeds the server's real Jellyfin Web player, with native
playback controls and personal audio, subtitle, quality, and volume settings.
SameRow synchronizes play/pause/seeking and restores late viewers/reconnections.
Friends join using a room link; the server grants video-scoped access without
exposing the owner's Jellyfin token or library. Camera/microphone traffic remains
WebRTC; each viewer's movie stream passes through the backend over HTTP.

Deploy both client and backend. The backend must reach the Jellyfin API and `/web/`
assets; for a LAN-only Jellyfin, run the backend on that LAN. Configure
`VITE_SOCKET_URL` for the client and a private persistent `SAMEROW_DATA_DIR` for the
backend's remembered connections. The default data directory is `server/.data`.
Jellyfin Web 12.3.0 is verified against the included real local sandbox.

See [client setup, architecture and acceptance tests](SameRow/client/README.md#native-jellyfin-integration).
Run `npm test`, `npm run lint`, and `npm run build` in `SameRow/client`.
With Vite and the Jellyfin sandbox running, `npm run test:jellyfin` checks real
Quick Connect, native video decoding, shared controls, personal tracks, late join,
reconnect, fullscreen, scoped access, and revocation in independent browsers.

Camera capture and RTP sender budgets adapt to participant count. Calls still use
a peer mesh; larger rooms and restrictive networks need appropriate TURN/SFU
infrastructure. Provision backend bandwidth and Jellyfin transcoding for the
expected number of movie viewers.

## Production deployment

The multi-instance Render/Vercel deployment, required secrets, LiveKit setup,
Jellyfin connectivity, Firestore migration, recovery behavior and operational
checks are documented in [docs/production.md](docs/production.md). Deployment
configuration is in `render.yaml` and `SameRow/client/vercel.json`.
