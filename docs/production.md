# Production deployment: Render + Vercel

The application code is prepared for multiple control instances, a separately
scaled Jellyfin gateway, managed Redis and LiveKit. Applying this configuration
creates paid resources. Review the current Render service name and region before
applying the Blueprint; this repository does not deploy or purchase resources.

## Architecture

- Vercel serves the Vite frontend and immutable assets.
- Render `samerow-v2` handles authenticated Socket.IO connections, playback state,
  room membership, LiveKit token issuance and chat. Production uses WebSocket
  transport only, avoiding polling session affinity requirements.
- Render `samerow-media` delivers scoped Jellyfin Web and movie streams. The
  frontend learns its public origin from the room acknowledgment. Movie traffic
  does not consume the control service's HTTP connections or outbound bandwidth.
- A private paid Render Key Value instance stores encrypted playback state,
  presence leases, viewer capabilities, remembered Jellyfin credentials, Quick
  Connect progress and distributed rate limits. Atomic compare-and-set updates
  serialize concurrent state mutations. The Socket.IO Redis adapter carries
  events between instances; application state is stored separately from it.
- Firebase Authentication verifies Google and anonymous guest identities.
  Firebase Admin writes and reads the existing Firestore message collections;
  clients receive paginated history and live messages over authenticated sockets.
- LiveKit supplies the SFU, congestion control, simulcast and TURN. Do not try to
  host its UDP media service inside a Render Node web service.

## Configure services

1. In the existing Firebase project, enable Google and Anonymous authentication.
   Add the production Vercel/custom domain to Firebase's authorized domains.
   Create a dedicated service account with Firebase Authentication read access
   (verification checks revocation) and Firestore document read/write access.
   Store its one-line JSON only in Render's secret environment configuration.
2. Create or use a LiveKit Cloud project. Copy its `wss://` URL, API key and API
   secret into Render secrets. Keep the API key and secret out of Vercel and Git.
3. Review `render.yaml`. Attach it to the existing repository using a Render
   Blueprint, or apply its environment variables/build settings to the existing
   service and add the media/Key Value services manually. All three Render
   services must share a region/private network. The Blueprint uses two paid
   control instances, one media instance and persistent paid Key Value.
4. Add the required values manually to the `samerow-production` environment
   group (Render does not support secret prompts inside environment groups).
   Services remain unready until these are present; deploy/redeploy both after
   saving the group:

   | Variable | Value |
   | --- | --- |
   | `CLIENT_ORIGINS` | Exact Vercel/custom HTTPS origins, comma-separated, no trailing slash |
   | `FIREBASE_PROJECT_ID` | The frontend's Firebase project ID |
   | `FIREBASE_SERVICE_ACCOUNT_JSON` | Dedicated server service account JSON |
   | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit project credentials |
   | `MEDIA_PUBLIC_URL` | Actual public HTTPS origin of the media service |
   | `DATA_ENCRYPTION_KEY` | One persistent 32-byte key encoded as 64 hex characters |

   Generate the encryption key once with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Both services and every replica must use the same key and `REDIS_PREFIX`.
   Preserve the key separately from Redis backups. Changing it without migrating
   data makes existing credentials and room state unreadable. Use a different
   prefix, encryption key and credentials in staging.
5. On the existing Vercel project, use root directory `SameRow/client`, Node 24,
   `npm ci`, `npm run build`, and output directory `dist`. Set `VITE_SOCKET_URL`
   to the control service's actual HTTPS URL. Set the four public Firebase web
   variables in `SameRow/client/.env.example` to the same Firebase project.
   `SameRow/client/vercel.json` supplies SPA routing and response headers.
6. Deploy the backend and frontend together. Production startup refuses missing
   Redis, encryption, origins, Firebase or LiveKit configuration and refuses
   development authentication or mesh media. Verify `/health/ready` on both
   Render services. The media service deliberately rejects Socket.IO clients;
   the control service deliberately rejects native movie proxy requests.
7. After the new backend/frontend are running, deploy `firestore.rules` with
   `firebase deploy --only firestore:rules --project YOUR_PROJECT`. These rules
   deny direct browser access to room collections; the Admin SDK still works.
   Review/merge rules first if this Firebase project hosts other applications.
   Old browser tabs should reload because their direct Firestore access ends.

No secrets are included in the repository. Do not paste production secrets into
chat or put them into `VITE_*` variables.

## Jellyfin connectivity and migration

Render must reach the Jellyfin server over HTTPS. A server listening only on
`127.0.0.1` or a home LAN is not reachable from Render. Expose a properly secured
HTTPS endpoint or deploy an explicitly configured private connector/network.
Use `JELLYFIN_ALLOWED_ORIGINS` to restrict access to known library origins.
Private addresses require both `JELLYFIN_ALLOW_PRIVATE=true` and an exact origin
allowlist. Cloud metadata, link-local and multicast targets remain blocked.
DNS is checked at connection time and redirects are rejected.

Jellyfin account connections now belong to the verified Firebase user. Existing
local JSON connections are not copied into production Redis; reconnect those
libraries once after migration. Passwords are used for sign-in and not retained.
Upstream access tokens are encrypted in Redis and never included in viewer
snapshots. Guests receive item/session-scoped bearer capabilities, which must be
redacted from logs. Application logs intentionally omit raw URLs and headers;
check any external proxy/access log policy as well.

Existing Firestore chat history remains in place. The backend reads the existing
`rooms/{room}/messages` collection in pages of 50. New messages record a verified
sender ID and deduplicate retries. Local development without Firebase Admin uses
bounded Redis/memory history (1,000 messages, seven-day retention).

## Room behavior and limits

A room code is its invitation capability: anyone with the code and a verified
identity can join. Use long random codes in shared invitations. Users have one
active room per socket. `MAX_ROOM_SIZE` defaults to 25 with LiveKit and four in
local mesh mode; this is an admission limit, not a proven capacity guarantee.
`CONTROL_POLICY=everyone` preserves collaborative controls; `host` restricts
playback changes to the first creator's Firebase identity. Host ownership lasts
with the room state; an absent host does not transfer control automatically.

Membership leases renew every 20 seconds and expire after 90 seconds. Normal
leave/disconnect removes membership immediately. Process failures can therefore
leave an admission slot occupied for up to 90 seconds. Viewer HTTP requests check
shared membership and selected media on each request. Long native streams check
revocation every 15 seconds. Temporary playback state is retained for 24 hours
of inactivity (configurable up to seven days), allowing reconnects and rolling
deploys to restore playback. Room expiry resets temporary state, not Firestore
chat history. LiveKit tokens are room-scoped, expire after two minutes for initial
admission, and use socket-specific identities; leaving also requests participant
removal. LiveKit maintains ongoing connected-session tokens itself.

Public HTTPS Jellyfin video delivery remains one outbound stream per viewer.
For example, 1,000 viewers at 4 Mbps need roughly 4 Gbps before overhead. Gateway
separation does not multiply the origin's upload or transcoding capacity. Prefer
compatible direct playback, provision hardware transcoding where needed and
measure the actual library/client mix. Personalized transcoding is not a shared
cache by default. Each gateway process limits concurrent requests per viewer;
capacity planning must still account for sessions across gateway replicas.

## Verification and operations

```sh
cd SameRow/server
npm ci
TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
npm audit --audit-level=high
cd ../client
npm ci
npm test
npm run lint
npm run build
npm audit --audit-level=high
```

CI runs the same checks with a real Redis service on Node 24. Redis integration
tests cover two-server fan-out, concurrent updates, encrypted credential storage,
restart recovery and a separate Jellyfin gateway. Browser suites additionally
need Playwright/Chrome, Vite on port 5175, and (for real native playback) the
included Jellyfin sandbox. `npm run test:jellyfin` exercises real Quick Connect
and video decoding; `npm run test:ui` includes layout and provider fixtures.

`/health/live` checks process liveness. `/health/ready` checks Redis connectivity/write availability and the
cross-server adapter connections and returns 503 while draining/unavailable.
`/metrics` requires `Authorization: Bearer METRICS_TOKEN` and reports local socket
count, event/rejection/error counters, event-loop p99 delay and process RSS.
Configure external uptime alerts on readiness, and alerts for Redis memory,
rejected writes, high loop delay, gateway egress, stream startup failures and
LiveKit connection/packet-loss metrics. Counters are per process and reset on a
restart. SIGTERM drains new work, closes connections and preserves Redis state.

Keep Redis persistence enabled with `noeviction`, monitor memory, and maintain
provider backups plus the encryption key. Rehearse restoration in staging.
Firestore backup/retention and LiveKit/Render billing limits are account-level
settings that need to be configured on those services.

The optional `npm run test:load` script measures signaling snapshot latency. Set
`LOAD_URL` to staging and provide a JSON array of one valid Firebase token per
simulated user via `LOAD_TOKENS_FILE`; it does not measure
browser decoding, media bandwidth or TURN load. Before opening access broadly,
run a sustained test matching the intended number of rooms, participants per
room and movie bitrates, including backend restarts and restricted networks.
Measure sync drift, p95 join/stream startup time, call loss, egress and cost.

### Local verification results

The implementation was checked locally with two Redis-connected control
instances and a separate gateway. A signaling probe using 100 distinct local
identities in 25 rooms completed 300 snapshot requests with zero errors and
approximately 6.9 ms p95 round-trip latency. This is a localhost result, not a
production capacity or latency promise. Two real Chromium clients were also
verified against a real LiveKit SFU for decoded video, camera toggles, screen
sharing and reconnection. The included `npm run test:call` browser suite can
repeat this with `LIVEKIT_TEST_URL`, `LIVEKIT_TEST_API_KEY` and
`LIVEKIT_TEST_API_SECRET` (defaults: local `livekit --dev`).

Official deployment references: [Render Blueprints](https://render.com/docs/blueprint-spec),
[Render Key Value](https://render.com/docs/key-value),
[Socket.IO across servers](https://socket.io/docs/v4/using-multiple-nodes/),
[Firebase ID verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
and [LiveKit SFU](https://docs.livekit.io/reference/internals/livekit-sfu/).

Final local checks on 26 October 2026 used Node 24: 51 existing automated tests
and nine backend production tests passed, including real Redis integration.
The full UI suite, native Jellyfin acceptance suite, fullscreen suite and real
LiveKit call suite passed. Build and lint passed; both npm audits reported zero
vulnerabilities. `render.yaml` passed Render's published JSON Schema validation.
Hosted Firebase credentials, provider-level configuration and production
network capacity still require staging verification after account setup.

Previously checked-in `SameRow/server/node_modules` files were removed from the
Git index; local installed dependencies remain available. Deployments and CI use
`npm ci` with the committed lockfiles instead of vendored packages. `.nvmrc`
selects Node 24 for local development.
