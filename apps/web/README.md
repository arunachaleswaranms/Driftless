# Driftless web client

The production Driftless web client: React, TypeScript, and Vite, delivered as a Progressive Web App.

It contains the Phase 1 foundation (the application shell, PWA installability metadata, service worker registration, a local video player, a browser capability report, and the automated test baseline) and, from Phase 2B, a room area that creates or joins a private two-person room through the [signaling service](../../services/signaling/) and opens a WebRTC data channel to the other participant. From Phase 2C the room recovers, within bounds, from a lost signaling connection and from a failed data channel. From Phase 2D it receives its ICE servers, including short-lived TURN credentials, from the signaling service after admission, and shows browser-local connection diagnostics, including whether the selected path is direct or a TURN relay. No synchronization or media-transfer behavior exists here, and the data channel carries nothing but a connection handshake.

Phase 1 is closed: its exit gate passed at revision `4bf6e31` in Playwright Chromium 153 and Google Chrome 154. That is development-browser evidence, not a support claim; see [PHASE1_QUALIFICATION.md](../../docs/PHASE1_QUALIFICATION.md).

## Requirements

- Node.js 22.12 or later (developed with Node.js 26.3.0 and npm 11.16.0)
- npm, using the repository's single root `package-lock.json` (this package is an npm workspace)

## Setup

From the repository root:

```sh
npm ci                                      # installs every workspace from the root lockfile
npx playwright install chromium             # once per machine, for test:e2e
```

Run the scripts below from `apps/web/`, or from the root with `--workspace @driftless/web` (for example `npm run test:e2e --workspace @driftless/web`). The root `npm run check` includes this package's `check`, and the root `npm run test:e2e` runs its browser tests.

## Scripts

| Script                   | Purpose                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `npm run dev`            | Builds the protocol package, then serves at `http://localhost:5173` (no service worker, no CSP).           |
| `npm run build`          | Type-check, then produce the production build in `dist/`.                                                  |
| `npm run preview`        | Serve `dist/` at `http://localhost:4173`.                                                                  |
| `npm run typecheck`      | TypeScript project check (application and tooling configurations).                                         |
| `npm run lint`           | ESLint with type-aware rules; any warning fails.                                                           |
| `npm run format:check`   | Prettier check. `npm run format` rewrites files.                                                           |
| `npm test`               | Vitest unit and component tests (jsdom).                                                                   |
| `npm run test:e2e`       | Builds, starts a loopback signaling service and the preview server, and runs the Playwright browser tests. |
| `npm run check`          | `typecheck`, `lint`, `format:check`, `test`, and `build` in sequence.                                      |
| `npm run icons`          | Re-renders the PNG icons from `public/icons/icon.svg` (the output is committed).                           |
| `npm run test-media`     | Regenerates the synthetic WebM browser-test videos; see `e2e/media/README.md`.                             |
| `npm run test-media:mp4` | Regenerates the synthetic MP4 (H.264/AAC) browser-test video; see `e2e/media/README.md`.                   |

Every script exits non-zero on failure. Deployment builds and their settings are described in [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md). CI can run `npm ci && npm run check && npm run test:e2e` from the repository root.

`npm run test:e2e` runs in Playwright's Chromium. It starts the signaling service on `127.0.0.1:8790` (override with `DRIFTLESS_E2E_SIGNALING_PORT`) and points the preview server's `/v1/signaling` forwarding at it; Playwright stops both when the run ends. With `DRIFTLESS_E2E_CHROME=1` it also runs every test in the Google Chrome installed on the machine, as additional development-browser evidence. Neither run is a browser support claim.

## Layout

```text
src/
  main.tsx                 entry point; renders the shell and registers the service worker
  app/                     application shell and global styles
  features/local-media/    local video player: file choice, object URL lifecycle, metadata, errors
  features/capabilities/   browser capability report: observed API surfaces, no support claims
  features/room/           room UI, room controller, signaling client, WebRTC peer session, ICE configuration, connection diagnostics
  pwa/                     service worker registration
public/
  manifest.webmanifest     web app manifest
  sw.js                    service worker (no fetch handler, no caching)
  icons/                   placeholder icon artwork
e2e/                       Playwright tests against the production build
e2e/media/                 synthetic test videos and their provenance
```

## Tooling decisions

- **npm workspace package.** Phase 1 kept `apps/web` standalone with its own lockfile. Phase 2A added `packages/protocol` and `services/signaling` and introduced a root npm workspace; the root now owns the only `package-lock.json`, and the Prettier configuration moved to the root `.prettierrc.json` unchanged. The migration kept every locked package at its Phase 1 version and produced a byte-identical production build. The Phase 1 qualification remains the record for its standalone revision, `4bf6e31`.
- **TypeScript 6.0.** TypeScript 7 is the current release, but typescript-eslint's type-aware rules support only TypeScript versions below 6.1.
- **No `eslint-plugin-jsx-a11y`.** Its latest release does not support ESLint 10. Accessibility is exercised through role-based queries in the component and browser tests instead.
- **No PWA plugin.** The manifest and service worker are small hand-written static files, so no Workbox build dependency or generated precache is involved.
- **Playwright runs full Chromium** (Chrome's new headless mode) rather than the headless shell, because the headless shell does not evaluate installability.

## Local video player

`src/features/local-media/` plays one video file chosen on this device in a native `<video>` element with the browser's own controls.

- **No application reads of the file.** The chosen `File` is bound to the element through `URL.createObjectURL()`. The browser's media stack reads and decodes it on demand; the application never calls `arrayBuffer()`, `FileReader`, or any other read, and never uploads, caches, or stores it.
- **One object URL per selection.** `LocalMediaPanel` gives each chosen file a new selection id and mounts one `LocalMediaPlayer` keyed by it. The player creates the URL when it mounts and, when it unmounts on replacement, clear, or panel teardown, pauses the element, removes its source, reloads it, and only then revokes the URL. Media events carry their selection id, and the reducer in `localMediaState.ts` ignores events for any selection but the current one.
- **Browser-reported details only.** The panel shows the file name, the browser-reported type, and the size, then the duration and dimensions once the element reports metadata. The reported type comes from the browser, usually from the file name, and is not treated as evidence that the file will play. The file's location on the device is not available to the page.
- **Conservative errors.** A `MediaError` is mapped to a category by its standard code, and the page says that this browser could not play the selected media. It does not show the browser's internal error message or name a codec.
- **No autoplay.** The element uses `controls`, `playsInline`, and `preload="metadata"`; playback starts only from the user.
- **Content Security Policy.** Production builds allow `media-src 'self' blob:` so the element can load object URLs. Nothing else in the policy changed.

The file chooser suggests video files, but whether a file plays is decided only by the browser. Browser test results with the synthetic fixtures are development evidence, not a compatibility claim.

## Capability report

`src/features/capabilities/` reports which browser API surfaces this page can observe. It is a local diagnostic, not a compatibility check.

- **Observations, not support.** Each entry is `Available`, `Not available`, or `Not evaluated` (the secure-context flag is `Yes` or `No`), with every API check it made listed in text. API presence is not browser or product support, and the report never uses the words supported or compatible. Compatibility statuses live only in [COMPATIBILITY.md](../../docs/COMPATIBILITY.md) and require tested evidence.
- **Two groups.** _Current foundation_ covers the secure-context flag, `File`/`Blob`, object URLs, HTML video, and the Service Worker API. _Later-phase prerequisites_ covers `RTCPeerConnection`, data channel creation, Media Source Extensions, the OPFS entry point, and Web Crypto digest. This build does not use the later-phase APIs, and their presence establishes no mode, including Progressive Watch.
- **Declarations only for media types.** `canPlayType()` is asked about `video/mp4` and `video/webm` without codec parameters, and its answer is shown as the browser's own declaration. No codec or profile is probed.
- **Structure.** `capabilityModel.ts` defines the observation types. `capabilityScope.ts` reads property paths from a global-scope object without throwing. `detectCapabilities.ts` turns a scope into a report, `capabilityText.ts` holds the wording, and `CapabilityPanel.tsx` and `CapabilityList.tsx` render it. The panel detects once, when it mounts, and accepts a synthetic scope in tests, so nothing reads browser globals at import time.
- **No side effects.** Detection only reads properties and asks `canPlayType()` of a detached element with no source. It does not construct a peer connection or MediaSource, open OPFS, request persistence or permissions, hash anything, make requests, or store anything. Results stay on the page. The browser tests instrument these APIs and inspect storage and requests to confirm it.
- **No user-agent sniffing.** Nothing depends on the browser's name or version.

## Room and peer connection

`src/features/room/` lets two people connect their browsers. It is layered so that React only renders:

```text
RoomPanel.tsx          create/join form, invite, status, leave
  ↓
roomController.ts      one room session, its state, resume schedule, and recovery; no React
  ↓                         ↓                        ↓
signalingClient.ts     peerSession.ts           resumeProof.ts, reconnectSchedule.ts
  ↓                         ↓                        ↓
WebSocket              RTCPeerConnection +      Web Crypto, one-shot timers
(one per attempt)      one RTCDataChannel
```

`browserRoomController.ts` wires the real browser APIs; the tests inject deterministic fakes (sockets, peer connections, timers, and a resume prover) instead.

- **Same-origin signaling.** The WebSocket URL is derived from the page: `wss://<host>/v1/signaling` on `https`, `ws://` only on `localhost`, `127.0.0.1`, or `[::1]`, and otherwise no connection is made. The URL has no query and carries no room ID or secret. `vite.config.ts` forwards `/v1/signaling` to a loopback signaling service in both the development and preview servers (`DRIFTLESS_SIGNALING_TARGET`, default `http://127.0.0.1:8787`, which must be a loopback `http` origin). The Content Security Policy is unchanged: its `default-src 'self'` already admits a WebSocket to the page's own host and port.
- **Nothing until asked.** Mounting the panel opens no socket and creates no peer connection; the first happens on **Create room** or **Join room**, the second only once a guest is present.
- **Validated messages.** The signaling client parses every incoming message with `@driftless/protocol` and closes the connection on any invalid or out-of-order one. Outgoing messages use strictly increasing sequences for the life of the socket, across rooms, and are refused locally if they would exceed the shared byte bound. Malformed join details are refused before any request.
- **Negotiation.** The host creates one ordered, reliable data channel, `driftless-control`, and the offer with a fresh negotiation ID from `crypto.getRandomValues`; the guest applies the offer and answers. Both trickle ICE: each local candidate is sent as a validated plain object of its four browser fields, and the end of gathering as `ICE_COMPLETE`. Remote candidates that arrive before the remote description are held in order, at most 32 and 16 KiB, and applied once it is set. Signaling for any other negotiation is ignored.
- **Connected means usable.** The guest accepts only the expected channel; any other is closed and fails the session. The host sends `PEER_HELLO` when its channel opens; the guest replies with its own `PEER_HELLO` and a `PEER_READY` (never earlier, so the host's channel is open before the guest sends), and the host answers with `PEER_READY`; the UI says "Peer data channel is connected." only after both have crossed the channel in both directions. It claims nothing about synchronized playback, and shows no SDP, candidate, address, or path information.
- **ICE servers.** The build may list up to four `stun:` or `stuns:` URLs in `VITE_RTC_STUN_URLS` (none by default); anything else, including TURN, disables rooms with a clear message. Nothing secret is ever built in. At run time, after `ROOM_CREATED` or `ROOM_JOINED`, the controller sends `RTC_CONFIG_REQUEST` once and keeps the service's `RTC_CONFIG` in private memory (`rtcConfig.ts`): it must have a positive lifetime of at most one day, measured as `expiresAt − sentAt` on the service's clock. Each new peer connection uses the build-time STUN servers plus the service's STUN and TURN servers. The host's offer and the guest's answer wait for the configuration if it has not arrived — the guest's session already exists, so early candidates are held in its bounded queue — for at most 3 s (`RTC_CONFIG_WAIT_MS`), then go ahead without TURN. A configuration within 60 s of expiry (`RTC_CONFIG_REFRESH_MARGIN_MS`) is fetched again before a new peer connection, for example before a recovery. Nothing is asked before admission or on a resuming connection. The configuration is forgotten with the room, and its TURN credential is never rendered, placed in the room state or diagnostics, exported, logged, or stored. These values are provisional.
- **ICE transport policy.** `all`, so the browser chooses the path. A qualification build may set `VITE_RTC_ICE_TRANSPORT_POLICY=relay`, which restricts every peer connection to TURN relay candidates; there is no user-facing switch. Without a TURN server such a session fails at once ("This build allows only relayed connections, and no relay server was available.") and recovery stops at the negotiation bound. Any other value disables rooms.
- **Connection diagnostics.** A collapsed **Connection diagnostics** section in the room describes the current peer connection as this browser sees it (`connectionStats.ts`, `diagnostics.ts`, `ConnectionDiagnosticsView.tsx`): signaling, the peer connection, ICE, and data-channel states; the selected path; the local and remote candidate types; the transport (and, for a local relay candidate, the relay protocol); the negotiation count of four; whether TURN was available; the ICE policy; and the build revision. The path comes from `RTCPeerConnection.getStats()`: the transport's `selectedCandidatePairId` names the selected candidate pair, whose local and remote candidates give their types. `TURN relay` means a relay candidate on either side; `Direct (not relayed)` means a known selected pair with neither candidate relayed (host, srflx, or prflx), not necessarily the same network; anything less certain — no selected pair, conflicting pairs, a pair that has not succeeded, a missing or unfamiliar candidate, or failed statistics — is `Unknown`, with a short reason. A single candidate pair marked `selected: true` is accepted only when no transport names a pair. The configuration is never used to infer the path. Statistics are read once when a peer connection becomes connected (including each recovered one) and when **Refresh diagnostics** is pressed; there is no polling. A replaced or closed connection's snapshot is discarded at once, and a late read of it is dropped. Reading them never affects the room: a failure leaves the path `Unknown` and nothing else changes. **Copy diagnostics** copies a plain-text summary of the same safe fields. No address, port, candidate string, session description, ICE username fragment, fingerprint, TURN credential, or room, session, or participant identifier is shown, copied, logged, or sent anywhere.
- **Build revision.** `DRIFTLESS_BUILD_REVISION` (a commit hash) at build time is shown as **Build** in the diagnostics and in the copied summary; unset builds show `unversioned`.
- **Invite handling.** The host sees the room ID and the invite secret, masked until **Show invite secret** is pressed (`aria-pressed`), with separate copy buttons. The secret exists only in memory while the room exists; nothing is written to storage, the URL, or the console. The join fields use `autocomplete="off"`, the secret field is a plain text field marked sensitive rather than a password field so no password manager offers to save it, and the form is rebuilt empty after each attempt.
- **State.** The controller keeps room membership, this browser's signaling connection (`connected` or `reconnecting`), and the peer — the other participant's signaling presence and the peer transport (`negotiating`, `connecting`, `connected`, `recovering`, `failed`) — independent, so a room can be in room with signaling reconnecting and the data channel still connected.
- **Signaling reconnect.** When the signaling connection is lost, a connected peer session is kept, and a negotiation that had not finished is abandoned. A new socket is opened on a fixed schedule — immediately, then after 250 ms, 500 ms, 1 s, 2 s, 4 s, 4 s, and 4 s (8 attempts, 15.75 s of delays), each attempt abandoned after 5 s without an answer and closed with code 4000, which the service treats as a lost connection rather than an intentional ending — and authenticates with `SESSION_RESUME_BEGIN`, the service's challenge, and `SESSION_RESUME_PROVE`. The proof is HMAC-SHA-256 computed with Web Crypto from a non-extractable key; the resume secret itself is never sent. These values are provisional and not tuned for mobile networks. After `SESSION_RESUMED` the controller checks that the snapshot names this exact membership and reconciles with it before sending anything else: it keeps its peer session only if that is connected and belongs to the service's active negotiation, and closes it otherwise. Exactly one schedule exists at a time; it is cancelled on leave, room end, success, and shutdown. If every attempt fails — for example after a service restart, or because the service has not yet noticed that a silently dead connection is gone (it takes up to two 15-second ping intervals) — the room ends with "The room session could not be recovered." and the peer session is closed. There is no browser-side liveness check; both limits need real-network evidence (Phase 2D).
- **Peer recovery.** A failed peer session is discarded, never repaired; there is no `restartIce()`. The guest asks with `RTC_RECOVERY_REQUEST`; the host answers, or recovers unprompted one second after its own session fails (a guest's request or departure cuts the wait short), with `RTC_RECOVER`, which names the failed negotiation and carries a fresh offer. Each recovery uses a fresh `RTCPeerConnection`, negotiation ID, `driftless-control` channel, and handshake; the guest accepts only a recovery of the negotiation it knows to be active. Recovery waits while either side's signaling is reconnecting and nothing is queued meanwhile. A guest membership uses at most four negotiations; then the interface shows that recovery stopped and the user can leave.
- **Leaving.** **Leave room** stays available in every in-room state, including while either participant's signaling is reconnecting, during peer recovery, and after recovery has stopped. With signaling connected, leaving sends `ROOM_LEAVE`, then closes the data channel and peer connection, and drops the room's state; the socket is kept for the next room.
- **Leaving while reconnecting.** The user's leave is never treated as an ordinary reconnect. The peer connection and data channel close at once, recovery stops, and the panel shows "Leaving the room…" with no room controls. The controller keeps the room's credentials, in private memory only, just long enough to resume the membership for one purpose: on `SESSION_RESUMED` it sends `ROOM_LEAVE` immediately, with no reconciliation or negotiation, and on `ROOM_LEFT` it closes the socket, discards the credentials, and shows "You left the room." The service then frees the guest's slot (the host sees "The guest left."), or closes the host's room and invalidates its invite (the guest sees "The host closed the room."), at once. An attempt already in flight when the user leaves continues for the leave, so a resume the service had just accepted is used to leave, never to restore the room. The attempts follow their own finite schedule — immediately, then after 250 ms, 500 ms, 1 s, and 2 s (5 attempts, each bounded by the 5-second attempt timeout, which also bounds the wait for `ROOM_LEFT`; provisional). `SESSION_UNAVAILABLE` completes the leave at once: the membership is already gone. A connection lost after `ROOM_LEAVE` but before `ROOM_LEFT` is retried within the schedule. If the service cannot be reached throughout, the room is left locally, the credentials are discarded, and nothing more is tried; the service then ends the membership only when its reconnect grace period (or the room's lifetime) ends, so until then a guest's slot stays held and a host's room and invite stay valid. A second Leave is ignored, and shutdown cancels the schedule.
- **No reload recovery.** The resume secret lives only in the controller's private memory — never in the rendered state, the page, the URL, storage, or the clipboard — and is dropped when the room ends, so reloading or closing the page cannot resume a room.
- **Accessibility.** Inputs have labels, the status line is a polite live region that changes only on meaningful transitions (never per candidate or per reconnect attempt), errors and stopped recovery use an alert, state is always stated in text ("Peer data channel connected. Signaling is reconnecting…", "The other participant is reconnecting…", "Peer connection lost. Recovering…", "Connection restored."), and focus returns to the panel heading when the focused control disappears with its view. No retry count, timer, challenge, proof, or raw error is shown.

## PWA behavior

- `public/manifest.webmanifest` supplies the name, standalone display mode, colors, and 192 px and 512 px icons. The 512 px icon keeps its artwork inside the maskable safe zone, so it is also declared as the maskable icon.
- Production builds register `sw.js` at the base path after the page `load` event, with `updateViaCache: 'none'`. The development server does not register it.
- The worker has no fetch handler and caches nothing. Browsers never dispatch `blob:` media requests to a service worker, so local video never passes through it. Every request goes to the network as if no worker were installed, so the application does not work offline yet. Application-shell caching, update prompts, and any offline behavior are deferred until they are designed.
- Production builds include a `Content-Security-Policy` meta tag that limits every resource type, including connections, to the application's own origin, except that media may also load from `blob:` object URLs. HTTP response headers, including `frame-ancestors`, belong to a deployment decision that has not been made yet.

Chromium reporting no installability errors is development evidence only. It is not a browser support claim; see [COMPATIBILITY.md](../../docs/COMPATIBILITY.md).
