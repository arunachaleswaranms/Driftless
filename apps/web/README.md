# Driftless web client

The production Driftless web client: React, TypeScript, and Vite, delivered as a Progressive Web App.

This is the Phase 1 foundation. It contains the application shell, PWA installability metadata, service worker registration, a local video player, a browser capability report, and the automated test baseline. No synchronization, signaling, WebRTC, or media-transfer behavior exists here.

## Requirements

- Node.js 22.12 or later (developed with Node.js 26.3.0 and npm 11.16.0)
- npm, using the committed `package-lock.json`

## Setup

```sh
cd apps/web
npm ci
npx playwright install chromium   # once per machine, for test:e2e
```

## Scripts

| Script                   | Purpose                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `npm run dev`            | Development server at `http://localhost:5173` (no service worker, no CSP).               |
| `npm run build`          | Type-check, then produce the production build in `dist/`.                                |
| `npm run preview`        | Serve `dist/` at `http://localhost:4173`.                                                |
| `npm run typecheck`      | TypeScript project check (application and tooling configurations).                       |
| `npm run lint`           | ESLint with type-aware rules; any warning fails.                                         |
| `npm run format:check`   | Prettier check. `npm run format` rewrites files.                                         |
| `npm test`               | Vitest unit and component tests (jsdom).                                                 |
| `npm run test:e2e`       | Builds, starts the preview server, and runs the Playwright browser tests.                |
| `npm run check`          | `typecheck`, `lint`, `format:check`, `test`, and `build` in sequence.                    |
| `npm run icons`          | Re-renders the PNG icons from `public/icons/icon.svg` (the output is committed).         |
| `npm run test-media`     | Regenerates the synthetic WebM browser-test videos; see `e2e/media/README.md`.           |
| `npm run test-media:mp4` | Regenerates the synthetic MP4 (H.264/AAC) browser-test video; see `e2e/media/README.md`. |

Every script exits non-zero on failure. CI can run `npm ci && npm run check && npm run test:e2e`.

`npm run test:e2e` runs in Playwright's Chromium. With `DRIFTLESS_E2E_CHROME=1` it also runs every test in the Google Chrome installed on the machine, as additional development-browser evidence. Neither run is a browser support claim.

## Layout

```text
src/
  main.tsx                 entry point; renders the shell and registers the service worker
  app/                     application shell and global styles
  features/local-media/    local video player: file choice, object URL lifecycle, metadata, errors
  features/capabilities/   browser capability report: observed API surfaces, no support claims
  pwa/                     service worker registration
public/
  manifest.webmanifest     web app manifest
  sw.js                    service worker (no fetch handler, no caching)
  icons/                   placeholder icon artwork
e2e/                       Playwright tests against the production build
e2e/media/                 synthetic test videos and their provenance
```

## Tooling decisions

- **Standalone package, no workspace.** `apps/web` has its own `package.json` and lockfile. A repository-level workspace is deferred until a second package, such as `packages/protocol`, actually exists.
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

## PWA behavior

- `public/manifest.webmanifest` supplies the name, standalone display mode, colors, and 192 px and 512 px icons. The 512 px icon keeps its artwork inside the maskable safe zone, so it is also declared as the maskable icon.
- Production builds register `sw.js` at the base path after the page `load` event, with `updateViaCache: 'none'`. The development server does not register it.
- The worker has no fetch handler and caches nothing. Browsers never dispatch `blob:` media requests to a service worker, so local video never passes through it. Every request goes to the network as if no worker were installed, so the application does not work offline yet. Application-shell caching, update prompts, and any offline behavior are deferred until they are designed.
- Production builds include a `Content-Security-Policy` meta tag that limits every resource type to the application's own origin, except that media may also load from `blob:` object URLs. HTTP response headers, including `frame-ancestors`, belong to a deployment decision that has not been made yet.

Chromium reporting no installability errors is development evidence only. It is not a browser support claim; see [COMPATIBILITY.md](../../docs/COMPATIBILITY.md).
