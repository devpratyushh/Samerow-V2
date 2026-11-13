# SameRow Connect verification after fixes — 2026-11-13

This report supersedes the earlier baseline failures. It includes the original local regression runs and the public beta publication checks on 2026-11-13.

## Fixes

- Library refresh no longer disables movie cards between pointer-down and click, and a library response cannot overwrite an active share operation.
- The embedded Jellyfin player handles expected access-revoked responses from its final asynchronous session updates after disposal.
- C# uploads use application/octet-stream. Original content types remain in relay metadata. The gateway also excludes authenticated relay uploads from JSON parsing, preserving upstream JSON and media bodies.
- Credentials are encrypted with AES-GCM and a persistent owner-readable key. Legacy plaintext configuration migrates on load. The status API excludes credentials.
- Pairing claims are atomic and single-use. Rotation saves a proposed encrypted token before the request and supports retry after an interrupted response.
- The plugin restricts endpoints and HTTP methods, bounds control-message bodies, disables redirects/decompression/cookies, and preserves streaming bodies.
- Header deadlines are cancelled once headers arrive, preventing cancellation of a long media body after the startup timeout.
- Connector revocation aborts local queued/active work and notifies media peers through the server adapter. Accounts and ongoing media revalidate grants.
- Explicit protocol version 1 is carried in jobs, with missing-version compatibility for existing Docker workers.
- Personal bitrate caps of 4/8/20 Mbps are available. Original video can copy browser-supported audio without a forced stereo limit.
- Packaging is deterministic and checksums are emitted. A plugin build/test/artifact workflow is added. Catalog generation verifies a genuinely published archive before producing a release entry.

## Executed checks

| Check | Result |
| --- | --- |
| Combined server and client Node suites with real disposable Redis | 88 passed, zero failures, zero skipped |
| C# plugin suite | 10 passed, zero failures |
| Full frontend ESLint | Passed |
| Frontend production build | Passed; existing large-chunk warning |
| Plugin Release build with warnings treated as errors | Passed, zero warnings/errors |
| Real Jellyfin UI/browser regression | Passed sign-in, original decode, embedded fallback, tracks, sync, late join, reconnect, fullscreen, scoped APIs and shared stop |
| Real C# worker + real Jellyfin + gateway + four browsers | Passed 3840x2160 original decode, exact 206 byte ranges, personal audio/subtitles, shared seek, reconnect |
| Four-viewer clocks in final C# integration run | 24.223659, 24.191738, 24.211032, 24.238613 seconds; approximately 47 ms spread |
| FFmpeg evidence | Video stream-copy mapping confirmed for the generated 4K source |
| Redis failover probe | 20/20 users recovered; 10 reconnects; approximately 398 ms recovery; 100 post-recovery requests |
| Release ZIP | Archive integrity, DLL equality, ABI 12.3.0.0 and SHA-256 verified |
| Installed plugin | Version 1.0.1.0 loads in Jellyfin 12.3; admin status API returns 200 and excludes credentials |

## Coverage against the nine objectives

1. Plugin lifecycle and actual relay behavior pass locally. Installed-plugin cloud pairing/restart acceptance is still pending.
2. Pairing, expiration, replay rejection, encrypted storage and rotation recovery pass local tests. Hosted Google-account approval remains outside this run.
3. Existing relay integration and control-replica failover pass. Supported deployment retains one media replica. Multiple media replicas need explicit connector ownership/routing.
4. Real Jellyfin playback and independent preferences pass locally, including 4K through a real C# worker.
5. New negative tests cover privileged endpoint rejection, encrypted credential tampering, claim replay, cross-owner access and old-token rejection after rotation. This is not an independent security audit.
6. Existing room UI regressions and real Jellyfin library UI passed. Full hosted plugin-dashboard onboarding is pending.
7. Public beta 1.0.1.0 is published with corresponding source and GPL-3.0-or-later licensing for the plugin/build/test files. GitHub Actions application and plugin workflows passed on the release source and catalog commits. The public catalog ZIP/checksum were verified and Jellyfin 12.3 installed it successfully. Third-party directory inclusion is submitted and awaiting maintainer review.
8. Local regression/integration checks pass. The mandatory clean-install, hosted approval and separate-network guest acceptance scenario remains pending.
9. Real 4K decode, stream-copy evidence and binary range integrity pass through the local C# worker harness. HDR and every audio codec/device combination remain unverified.

The C# network harness executes the production connector service with real HTTP clients. It uses a test host adapter, loopback HTTP, development identities, and the workspace Jellyfin server. It does not substitute for an installed plugin using production HTTPS/Firebase on another network.

## Commands

From the workspace, the plugin was built with .dotnet/dotnet build and the test executable run with JELLYFIN_SERVER_PATH pointing at jellyfin-sandbox/jellyfin. See README.md one directory above for portable build commands.

From Samerow-V2, Node 24 executed:
- node --test SameRow/server/tests/*.test.js SameRow/client/tests/*.test.js with TEST_REDIS_URL pointing to the disposable Redis container
- node SameRow/server/scripts/reconnect-load.js with LOAD_USERS=20 and LOAD_ROOM_SIZE=4
- client ESLint and Vite build
- client tests/jellyfin-native.browser.mjs
- client tests/jellyfin-plugin.browser.mjs

The test Redis container was stopped after validation. Docker was started to run these checks. The local Jellyfin sandbox was stopped after the catalog installation/restart check. The original plugin DLL was backed up under jellyfin-sandbox/tmp before upgrading.

## Public catalog publication checks

- [Release source commit b6e46bb](https://github.com/devpratyushh/Samerow-V2/commit/b6e46bb) and tag `samerow-connect-v1.0.1.0` include the plugin license, build/test files and packaging changes. The main application license is unchanged.
- Local Release build passed with warnings as errors; all 10 C# tests passed. [Linux plugin CI](https://github.com/devpratyushh/Samerow-V2/actions/runs/43404822765) and the application checks passed for the release source.
- [Public beta release](https://github.com/devpratyushh/Samerow-V2/releases/tag/samerow-connect-v1.0.1.0) includes the ZIP, corresponding source archive, and SHA-256 sidecars. The downloaded ZIP matched the local archive byte for byte.
- [Catalog commit 3bb5204](https://github.com/devpratyushh/Samerow-V2/commit/3bb5204) points to the published ZIP. Its public JSON and MD5 checksum were independently verified. [Plugin CI](https://github.com/devpratyushh/Samerow-V2/actions/runs/43405072625), [application CI](https://github.com/devpratyushh/Samerow-V2/actions/runs/43405072767), and Vercel deployment passed for this commit.
- A disposable Jellyfin 12.3 server discovered version 1.0.1.0 through the public repository, downloaded and installed it, and produced a DLL matching the released build. After restart, `/SameRow/Status` returned 200 and the settings page returned 200 with the new license notice. Repository settings were restored, the earlier manual installation preserved outside the plugins directory, and the sandbox stopped.
- [Third-party directory submission](https://github.com/jellyfin/jellyfin.org/pull/2089) adds the plugin and repository to Jellyfin's community listing. Its TypeScript repository data loads with unique repository IDs and the correct SameRow entry. This submission is awaiting maintainer review; inclusion in Jellyfin's official repository is not claimed.

These publication and installation checks do not complete the hosted Google approval / separate-network playback acceptance scenario described above.
