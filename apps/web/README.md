# Driftless web client

The production Driftless web client: React, TypeScript, and Vite, delivered as a Progressive Web App.

It contains the Phase 1 foundation (the application shell, PWA installability metadata, service worker registration, a local video player, a browser capability report, and the automated test baseline) and, from Phase 2B, a room area that creates or joins a private two-person room through the [signaling service](../../services/signaling/) and opens a WebRTC data channel to the other participant. No synchronization or media-transfer behavior exists here, and the data channel carries nothing but a connection handshake.

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

Every script exits non-zero on failure. CI can run `npm ci && npm run check && npm run test:e2e` from the repository root.

`npm run test:e2e` runs in Playwright's Chromium. It starts the signaling service on `127.0.0.1:8790` (override with `DRIFTLESS_E2E_SIGNALING_PORT`) and points the preview server's `/v1/signaling` forwarding at it; Playwright stops both when the run ends. With `DRIFTLESS_E2E_CHROME=1` it also runs every test in the Google Chrome installed on the machine, as additional development-browser evidence. Neither run is a browser support claim.

## Layout

```text
src/
  main.tsx                 entry point; renders the shell and registers the service worker
  app/                     application shell and global styles
  features/local-media/    local video player: file choice, object URL lifecycle, metadata, errors
  features/capabilities/   browser capability report: observed API surfaces, no support claims
  features/room/           room UI, room controller, signaling client, WebRTC peer session
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
roomController.ts      one room session and its state; no React
  ↓                         ↓
signalingClient.ts     peerSession.ts
  ↓                         ↓
WebSocket              RTCPeerConnection + one RTCDataChannel
```

`browserRoomController.ts` wires the real browser APIs; the tests inject deterministic fakes instead.

- **Same-origin signaling.** The WebSocket URL is derived from the page: `wss://<host>/v1/signaling` on `https`, `ws://` only on `localhost`, `127.0.0.1`, or `[::1]`, and otherwise no connection is made. The URL has no query and carries no room ID or secret. `vite.config.ts` forwards `/v1/signaling` to a loopback signaling service in both the development and preview servers (`DRIFTLESS_SIGNALING_TARGET`, default `http://127.0.0.1:8787`, which must be a loopback `http` origin). The Content Security Policy is unchanged: its `default-src 'self'` already admits a WebSocket to the page's own host and port.
- **Nothing until asked.** Mounting the panel opens no socket and creates no peer connection; the first happens on **Create room** or **Join room**, the second only once a guest is present.
- **Validated messages.** The signaling client parses every incoming message with `@driftless/protocol` and closes the connection on any invalid or out-of-order one. Outgoing messages use strictly increasing sequences for the life of the socket, across rooms, and are refused locally if they would exceed the shared byte bound. Malformed join details are refused before any request.
- **Negotiation.** The host creates one ordered, reliable data channel, `driftless-control`, and the offer with a fresh negotiation ID from `crypto.getRandomValues`; the guest applies the offer and answers. Both trickle ICE: each local candidate is sent as a validated plain object of its four browser fields, and the end of gathering as `ICE_COMPLETE`. Remote candidates that arrive before the remote description are held in order, at most 32 and 16 KiB, and applied once it is set. Signaling for any other negotiation is ignored.
- **Connected means usable.** The guest accepts only the expected channel; any other is closed and fails the session. Each peer sends `PEER_HELLO` when the channel opens and answers with `PEER_READY`; the UI says "Peer data channel is connected." only after both have crossed the channel in both directions. It claims nothing about synchronized playback, and shows no SDP, candidate, address, or path information.
- **ICE servers.** None by default. `VITE_RTC_STUN_URLS` may list up to four `stun:` or `stuns:` URLs at build time; anything else, including TURN, disables rooms with a clear message.
- **Invite handling.** The host sees the room ID and the invite secret, masked until **Show invite secret** is pressed (`aria-pressed`), with separate copy buttons. The secret exists only in memory while the room exists; nothing is written to storage, the URL, or the console. The join fields use `autocomplete="off"`, the secret field is a plain text field marked sensitive rather than a password field so no password manager offers to save it, and the form is rebuilt empty after each attempt.
- **Failure and leaving.** A failed peer connection is torn down and shown with its cause and the next step; the participant stays in the room until choosing **Leave room**, and nothing is retried. Leaving closes the data channel and peer connection and drops the room's state; the socket is kept for the next room. If the signaling connection closes, the peer connection is closed too and the user starts again. There is no reconnect, ICE restart, or renegotiation; Phase 2C owns recovery.
- **Accessibility.** Inputs have labels, the status line is a polite live region that changes only on meaningful transitions (never per candidate), errors use an alert, state is always stated in text, and focus returns to the panel heading when the focused control disappears with its view.

## PWA behavior

- `public/manifest.webmanifest` supplies the name, standalone display mode, colors, and 192 px and 512 px icons. The 512 px icon keeps its artwork inside the maskable safe zone, so it is also declared as the maskable icon.
- Production builds register `sw.js` at the base path after the page `load` event, with `updateViaCache: 'none'`. The development server does not register it.
- The worker has no fetch handler and caches nothing. Browsers never dispatch `blob:` media requests to a service worker, so local video never passes through it. Every request goes to the network as if no worker were installed, so the application does not work offline yet. Application-shell caching, update prompts, and any offline behavior are deferred until they are designed.
- Production builds include a `Content-Security-Policy` meta tag that limits every resource type, including connections, to the application's own origin, except that media may also load from `blob:` object URLs. HTTP response headers, including `frame-ancestors`, belong to a deployment decision that has not been made yet.

Chromium reporting no installability errors is development evidence only. It is not a browser support claim; see [COMPATIBILITY.md](../../docs/COMPATIBILITY.md).
