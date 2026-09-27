# Driftless web client

The production Driftless web client: React, TypeScript, and Vite, delivered as a Progressive Web App.

This is the Phase 1 foundation. It contains the application shell, PWA installability metadata, service worker registration, and the automated test baseline. Local file selection, playback, media metadata, and capability detection are not implemented yet. No synchronization, signaling, WebRTC, or media-transfer behavior exists here.

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

| Script                 | Purpose                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `npm run dev`          | Development server at `http://localhost:5173` (no service worker, no CSP).       |
| `npm run build`        | Type-check, then produce the production build in `dist/`.                        |
| `npm run preview`      | Serve `dist/` at `http://localhost:4173`.                                        |
| `npm run typecheck`    | TypeScript project check (application and tooling configurations).               |
| `npm run lint`         | ESLint with type-aware rules; any warning fails.                                 |
| `npm run format:check` | Prettier check. `npm run format` rewrites files.                                 |
| `npm test`             | Vitest unit and component tests (jsdom).                                         |
| `npm run test:e2e`     | Builds, starts the preview server, and runs the Playwright smoke tests.          |
| `npm run check`        | `typecheck`, `lint`, `format:check`, `test`, and `build` in sequence.            |
| `npm run icons`        | Re-renders the PNG icons from `public/icons/icon.svg` (the output is committed). |

Every script exits non-zero on failure. CI can run `npm ci && npm run check && npm run test:e2e`.

## Layout

```text
src/
  main.tsx                 entry point; renders the shell and registers the service worker
  app/                     application shell and global styles
  features/local-media/    local video area (placeholder)
  features/capabilities/   browser capability area (placeholder)
  pwa/                     service worker registration
public/
  manifest.webmanifest     web app manifest
  sw.js                    service worker (no fetch handler, no caching)
  icons/                   placeholder icon artwork
e2e/                       Playwright smoke tests against the production build
```

## Tooling decisions

- **Standalone package, no workspace.** `apps/web` has its own `package.json` and lockfile. A repository-level workspace is deferred until a second package, such as `packages/protocol`, actually exists.
- **TypeScript 6.0.** TypeScript 7 is the current release, but typescript-eslint's type-aware rules support only TypeScript versions below 6.1.
- **No `eslint-plugin-jsx-a11y`.** Its latest release does not support ESLint 10. Accessibility is exercised through role-based queries in the component and browser tests instead.
- **No PWA plugin.** The manifest and service worker are small hand-written static files, so no Workbox build dependency or generated precache is involved.
- **Playwright runs full Chromium** (Chrome's new headless mode) rather than the headless shell, because the headless shell does not evaluate installability.

## PWA behavior

- `public/manifest.webmanifest` supplies the name, standalone display mode, colors, and 192 px and 512 px icons. The 512 px icon keeps its artwork inside the maskable safe zone, so it is also declared as the maskable icon.
- Production builds register `sw.js` at the base path after the page `load` event, with `updateViaCache: 'none'`. The development server does not register it.
- The worker has no fetch handler and caches nothing. Every request goes to the network as if no worker were installed, so the application does not work offline yet. Application-shell caching, update prompts, and any offline behavior are deferred until they are designed.
- Production builds include a `Content-Security-Policy` meta tag that limits every resource type to the application's own origin. HTTP response headers, including `frame-ancestors`, belong to a deployment decision that has not been made yet.

Chromium reporting no installability errors is development evidence only. It is not a browser support claim; see [COMPATIBILITY.md](../../docs/COMPATIBILITY.md).
