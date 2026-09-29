# Phase 1 Qualification

This is the closure evidence record for **Phase 1 — Application Foundation**. It evaluates the Phase 1 exit gate against evidence recorded on one exact revision. It is not a browser support or product compatibility result.

## Scope

Phase 1 Application Foundation only: the production web client in `apps/web/`, which contains:

- the React/TypeScript/Vite application shell and PWA foundation (Phase 1A);
- the local browser media player (Phase 1B);
- the local capability report of runtime API observations (Phase 1C);
- the automated test baseline.

Signaling, rooms, WebRTC, synchronization, media transfer, and Progressive Watch are outside Phase 1 and were neither required nor exercised.

## Gate

From [ROADMAP.md](ROADMAP.md):

> The installable web foundation can select and play representative local media on target development browsers, reports capabilities accurately, and has an automated test baseline. No synchronized or progressive behavior is implied.

For evaluation, the gate is divided into five criteria:

| ID  | Criterion                        | Meaning                                                                                                                                                                                                                            |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Installable web foundation       | The production build builds and serves, has valid PWA metadata and served icons, registers its minimal service worker, has no unintended offline or media caching, and is usable at desktop and narrow widths.                     |
| G2  | Local media selection            | A user can choose, replace, clear, and choose again, with no application-level whole-file read and no upload.                                                                                                                       |
| G3  | Local playback                   | Representative media loads metadata, plays after a user action, advances, pauses, seeks forward and backward, continues after seeking, and is replaced and reset cleanly.                                                           |
| G4  | Accurate capability reporting    | The report matches the API surfaces the browser actually exposes, handles missing or blocked APIs safely, causes no side effects, and never turns API presence into product support or Progressive Watch availability.               |
| G5  | Automated baseline               | Reproducible automated coverage exists for the shell and PWA foundation, the local-player lifecycle, playback, capability reporting, the security and privacy boundaries, and regressions.                                         |

### Target development browsers

No repository document defines a fixed list for "target development browsers". Phase 1A selected Playwright on Chromium as the development automation browser, and [TEST_PLAN.md](TEST_PLAN.md) records that other desktop engines are not yet configured. The [compatibility tiers](COMPATIBILITY.md) are product validation priorities, not a development-browser list, and cross-browser execution belongs to Phase 7.

This qualification therefore uses Playwright's Chromium, the repository's configured development browser. It adds the locally installed Google Chrome, the Tier 1 desktop target and the Phase 0 evidence browser, as further development evidence. Both run the Chromium engine. No other engine was exercised, and none is claimed.

## Evaluated revision

**Evaluated revision: `4bf6e311723ff3c59dc47d9b3b108c9006f0d7a3`** (`test: qualify Phase 1 application foundation`), on branch `phase/1-application-foundation`. Its parent is the Phase 1C commit `f2de4eaf49cc7468f32936fe11e935c12114e547`.

The final qualification run below was made against this exact commit with a clean worktree (`git status --short` empty before and after). No source, test, configuration, or fixture file changed afterward. The documentation commit that adds this record changes documentation only.

## Environment

| Item            | Value                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Date            | 2026-09-29                                                                                                |
| OS              | macOS 26.6.2 (25G83), arm64                                                                               |
| Node.js         | v26.3.0                                                                                                   |
| npm             | 11.16.0                                                                                                   |
| Playwright      | `@playwright/test` 1.63.0                                                                                 |
| Browser 1       | Playwright Chromium 153.0.8010.12 (`channel: 'chromium'`, full Chromium build in new headless mode)       |
| Browser 2       | Google Chrome 154.0.8037.58, installed at `/Applications/Google Chrome.app` (`channel: 'chrome'`, headless) |
| Automation mode | `AUTOMATED DESKTOP / DEVELOPMENT BROWSER`, driven by Playwright against the production build served by `vite preview` on `http://localhost:4173` |

| Browser                                   | Result in this environment                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| Playwright Chromium 153.0.8010.12         | Exercised, automated                                                        |
| Google Chrome 154.0.8037.58               | Exercised, automated                                                        |
| Microsoft Edge                            | `NOT EXERCISED IN THIS ENVIRONMENT` — not installed; no failure is inferred |
| Firefox (installed)                       | `NOT EXERCISED IN THIS ENVIRONMENT` — no Phase 1 authority requires it      |
| Safari (installed)                        | `NOT EXERCISED IN THIS ENVIRONMENT` — no Phase 1 authority requires it      |
| Any Android or iOS browser                | `NOT EXERCISED` — no physical device; `DEFERRED-PHYSICAL-001` remains open   |

No browser emulation was used to represent another engine. The 360 px viewport tests are layout evidence only.

## Media fixtures

All fixtures are synthetic, generated, small, and stored under `apps/web/e2e/media/`. None is under `public/` or `src/`. The production `dist/` contained only `index.html`, `manifest.webmanifest`, `sw.js`, three icons, and one JavaScript and one CSS asset. Full provenance is in [`apps/web/e2e/media/README.md`](../apps/web/e2e/media/README.md).

| File                                | Bytes   | SHA-256                                                            | Duration | Frame size | Container | Video                                                     | Audio                                |
| ----------------------------------- | ------- | ------------------------------------------------------------------ | -------- | ---------- | --------- | --------------------------------------------------------- | ------------------------------------ |
| `synthetic-320x180-10s.webm`        | 16,273  | `7a51069c097edc34aa7e1b5a6ba82191d7a4337ffdfc78fcb979626b6765fec2` | 10.000 s | 320 × 180  | WebM      | VP8, 15 fps, 150 frames                                   | None                                 |
| `synthetic-256x144-6s.webm`         | 6,496   | `b544f779cb6cd6d836a67f92ad8380bac2f4daa0324985bc1f187b7163c82318` | 6.000 s  | 256 × 144  | WebM      | VP8, 15 fps, 90 frames                                    | None                                 |
| `synthetic-320x180-8s-h264-aac.mp4` | 185,070 | `617c0d6a6661b1ef5fc5e3536ac48ce183452bb97868a542b4fc7cc0dea7a839` | 8.000 s  | 320 × 180  | MP4       | H.264 High 3.0 (`avc1.64001e`), 30 fps, 240 frames, 2 B-frames, keyframe each second | AAC-LC (`mp4a.40.2`), stereo, 48 kHz |

- **WebM fixtures (Phase 1B, unchanged).** Generated by `scripts/generate-test-media.mjs` from a drawn pattern through libjpeg-turbo 3.2.0 `cjpeg` and Playwright's bundled FFmpeg `n7.0.1-playwright-build-1011`.
- **MP4 fixture (added in Phase 1D).** Generated by `scripts/generate-test-media-mp4.mjs` (`FFMPEG=… npm run test-media:mp4`) from FFmpeg's `testsrc2` and `sine` generators. The binary was FFmpeg 6.0 from the `ffmpeg-static` 5.3.0 npm package for macOS arm64 (binary SHA-256 `a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584`, x264 core 164 r3075). It was installed outside the repository, is not a project dependency, and is the same binary Phase 0 used. `moov` precedes `mdat`, the file is not fragmented, and each track has one edit-list entry.
- **Inspection.** `ffmpeg -hide_banner -i` with the same binary, and an MP4Box.js 2.4.1 parse run outside the repository, both recorded in the media README. The browsers independently reported duration 8, 320 × 180, and decoded audio.
- **Reproducibility.** Two consecutive generations made identical bytes. Regenerating at the evaluated revision reproduced the committed file byte for byte and left the worktree clean. All three committed digests were re-verified at the evaluated revision.

The MP4 fixture adds the MP4/H.264/AAC media shape, with an audio track, to local `<video>` playback qualification. It establishes nothing about Progressive Watch, MSE, fragmentation, or the `MP4 / H.264 (AVC) / AAC` Progressive Watch status, which remains `NOT TESTED`.

## Phase 1D qualification changes

The initial Phase 1D assessment of the Phase 1C revision classified most requirements as `PASS` from existing evidence and found these gaps. No `FAIL` (product defect) was found, and no product source changed.

| Gap                                                                                                                  | Change in `4bf6e31`                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Representative local media" rested on VP8/WebM only, with no audio track and none of the MP4/H.264/AAC media shape. | Added the synthetic MP4/H.264/AAC fixture, its generator (`scripts/generate-test-media-mp4.mjs`, npm script `test-media:mp4`), and its provenance.                                                                                                                                                                                                   |
| No single browser test walked the complete lifecycle, and playback evidence relied on `currentTime` alone.           | Added `runs the full lifecycle from video/mp4 to video/webm` and `… from video/webm to video/mp4`. Each walks empty → select → metadata → play → pause → seek forward → resume → seek backward → replace (while playing) → play replacement → clear → select again → play → clear. Details are below.                                                |
| "No autoplay by the application" was shown only by the element attributes and a paused state.                        | The media probe now wraps `HTMLMediaElement.prototype.play`. Native controls start playback without calling the page's `play()`, so the lifecycle tests assert 0 script calls to `play()`.                                                                                                                                                          |
| Rapid replacement covered one media shape.                                                                           | The rapid replace/clear test now interleaves the MP4 fixture with both WebM fixtures.                                                                                                                                                                                                                                                                |
| Icon dimensions were not checked against their declarations; manifest `id` and `scope` were not checked.            | Icons are decoded to their PNG signature and IHDR width × height, which must equal each declared `sizes`. The SVG favicon must be served as `image/svg+xml`. A new test resolves `id`, `start_url`, and `scope` against the manifest URL and requires all three to be the application root.                                                        |
| "No unintended fetch/cache behavior" was shown only during the local-media flow.                                    | Added `lets the service worker control the page without serving or caching`. On a controlled reload, no response comes from the service worker, the worker is `activated`, and Cache Storage is empty.                                                                                                                                               |
| No installed-Chrome evidence existed for Phase 1.                                                                   | `playwright.config.ts` adds an opt-in `chrome` project (`DRIFTLESS_E2E_CHROME=1`) that runs the whole suite in the installed Google Chrome. The default run is unchanged.                                                                                                                                                                             |

The lifecycle tests assert these points on each run:

- the element has `controls`, `playsInline`, no `autoplay`, and `preload="metadata"`, and the browser reports the fixture's duration (±0.05 s) and dimensions;
- the media stays paused at 0 for 500 ms after selection;
- each play step starts from a trusted click, and both `currentTime` and the decoded video frame count (`getVideoPlaybackQuality().totalVideoFrames`) advance, with the element neither paused nor ended;
- during pause, `currentTime` stays unchanged for 500 ms;
- the forward seek (duration − 2.5 s, while paused) and the backward seek (to 1.5 s, while playing) each resolve within 0.05 s of the target on `seeked`, and playback advances afterward from the new position;
- decoded audio bytes are nonzero exactly when the fixture has an audio track (a Chromium counter, checked only where the browser exposes it);
- replacement revokes exactly the previous URL, leaves only the new URL live while the replacement plays, starts at 0 paused with no leftover error, and shows the new file's details;
- clear removes every `<video>` element and revokes every URL; after re-selection and a second clear, 3 URLs were created and each was revoked once, and 500 ms later the empty state still stands;
- there are 0 file-content reads and 0 script `play()` calls;
- every request in the flow is a same-origin `GET` with no body and no query. Non-`blob:` requests go only to the application root, `/assets/`, `/icons/`, `/manifest.webmanifest`, or `/sw.js`. `blob:` requests go only to URLs the page created. No URL contains either chosen file name, and the service worker answers none of them;
- Cache Storage, OPFS, IndexedDB, `localStorage`, and `sessionStorage` are empty at the end.

**Mutation checks.** These were run on the uncommitted candidate, and every mutation was reverted before the commit. Each deliberately introduced defect made the new tests fail:

| Mutation                                                          | Result                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| The player calls `play()` when metadata loads                     | Both lifecycle tests failed (`playCalls` expected 0, received 3) |
| The player revokes its current URL 1.5 s after binding            | Both lifecycle tests failed                                |
| `sw.js` gains a pass-through `fetch` handler                      | 4 tests failed, including the new service worker test      |
| `sw.js` caches `/` at install                                     | 3 tests failed, including the new service worker test      |

**Dependencies.** No runtime or development dependency changed. `package.json` gained only the `test-media:mp4` script, and `package-lock.json` is unchanged. There is no networking, MP4Box.js, or media-player dependency.

## Automated results

All commands were run from `apps/web/` at the evaluated revision after `rm -rf dist node_modules test-results playwright-report`.

| Command                                           | Result                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                          | Exit 0. `found 0 vulnerabilities`. The only warning was npm's `allow-scripts` notice for the optional macOS dependency `fsevents@2.3.3`, a package-manager policy message that does not affect the application or tests. |
| `npm run check` → `typecheck`                     | `tsc -b`: pass, 0 errors                                                                                                                |
| `npm run check` → `lint`                          | `eslint --max-warnings=0 .`: pass, 0 problems                                                                                           |
| `npm run check` → `format:check`                  | `All matched files use Prettier code style!`                                                                                            |
| `npm run check` → `test`                          | Vitest 5.0.2: 8 files, **121 passed, 0 failed, 0 skipped**                                                                              |
| `npm run check` → `build`                         | `tsc -b && vite build`: pass (Vite 8.3.1, 28 modules)                                                                                   |
| `npm audit`                                       | `found 0 vulnerabilities`                                                                                                               |
| `npm audit --omit=dev`                            | `found 0 vulnerabilities`                                                                                                               |
| `npm run test:e2e -- --retries=0`, run 1          | **29 passed**, 0 failed, 0 flaky, 0 skipped (26.3 s)                                                                                    |
| `npm run test:e2e -- --retries=0`, run 2          | **29 passed**, 0 failed, 0 flaky, 0 skipped (25.8 s)                                                                                    |
| `npm run test:e2e -- --retries=0`, run 3          | **29 passed**, 0 failed, 0 flaky, 0 skipped (24.9 s)                                                                                    |
| `DRIFTLESS_E2E_CHROME=1 npm run test:e2e -- --retries=0`, run 1 | **58 passed** (29 Chromium + 29 Chrome), 0 failed, 0 flaky, 0 skipped (39.4 s)                                            |
| `DRIFTLESS_E2E_CHROME=1 npm run test:e2e -- --retries=0`, run 2 | **58 passed** (29 Chromium + 29 Chrome), 0 failed, 0 flaky, 0 skipped (37.3 s)                                            |

- **Retry policy.** `playwright.config.ts` sets `retries: 0`, and every qualification run also passed `--retries=0`. No run retried or reported a flaky test.
- **Process hygiene.** The web server uses `reuseExistingServer: false` and a strict port, and port 4173 was free after every run, so no server or process leaked.
- **Test inventory.** `app-shell.spec.ts` has 10 tests, `capabilities.spec.ts` has 7, and `local-media.spec.ts` has 12.
- **Failure policy.** Every browser test fails on any console error or warning, any page error, including an unhandled promise rejection (Chromium reports these as page errors), or any cross-origin request.

## Browser evidence

A supplementary Playwright script, run outside the repository against the same production build, recorded every console message of every type, CDP manifest diagnostics, capability observations, and MP4 playback measurements in both browsers. The two browsers matched on everything except version and frame counts.

| Observation                             | Chromium 153.0.8010.12                                  | Chrome 154.0.8037.58 |
| --------------------------------------- | ------------------------------------------------------- | -------------------- |
| Console messages of any type            | 0                                                       | 0                    |
| Page errors                             | 0                                                       | 0                    |
| `Page.getAppManifest` URL / errors      | `http://localhost:4173/manifest.webmanifest` / `[]`     | same                 |
| `Page.getInstallabilityErrors`          | `[{ errorId: 'in-incognito' }]`                         | same                 |
| Service worker                          | scope `http://localhost:4173/`, script `/sw.js`, `activated` | same            |
| MP4 metadata                            | duration 8, 320 × 180                                   | same                 |
| MP4 after about 1.5 s of play           | 50 frames decoded, 0 dropped, 14,836 audio bytes decoded | 51 frames, 0 dropped, 14,836 audio bytes |
| Seek to 5.5 s (playing)                 | landed 5.5 in 3 ms, then 6.13 s after 0.7 s             | landed 5.5 in 2 ms, then 6.15 s |
| Seek to 1.5 s (playing)                 | landed 1.5 in 4 ms, then 2.14 s after 0.7 s, playing    | landed 1.5 in 3 ms, then 2.14 s, playing |
| Storage after the flow                  | caches, IndexedDB, OPFS, `localStorage`, `sessionStorage` all empty | same    |

- **Installability.** `in-incognito` is produced by Playwright's off-the-record browser contexts. It is a property of the test environment, and the test suite ignores only that error. No other manifest or installability diagnostic appeared in either browser. This is Chromium-engine development evidence, not general PWA support.
- **Seek timings.** These are single observations on tiny local files, recorded only to show that the seeks completed. They are not performance thresholds.

**Capability observations**, identical in both browsers and matching the independently observed globals in the `matches the browser globals observed independently` test in each project:

- Secure context: Yes (`localhost`).
- Available: local file objects, object URLs, HTML video, Service Worker API, WebRTC peer connection, WebRTC data channel, Media Source Extensions, origin private file system, and Web Crypto digest.
- Media type declarations: `video/mp4` maybe and `video/webm` maybe.

These are runtime observations of two Chromium-engine automation browsers on `localhost`, not compatibility results.

## Privacy and security observations

- **Network.** The complete representative flow, in both browsers, requested only these, all same-origin `GET` with no body or query: `/`, `/assets/index-*.js`, `/assets/index-*.css`, `/icons/icon.svg`, `/manifest.webmanifest`, `/icons/icon-192.png` (and `/sw.js` by the browser), plus the browser's reads of its own `blob:` object URLs. There was no request to another origin and none carrying media bytes, a file name, a local path, a capability fingerprint, analytics, signaling, or peer data. No Phase 1 feature needs a Driftless backend.
- **Uploads and file reads.** The application made no call to `Blob.arrayBuffer`, `bytes`, `text`, `stream`, or `slice`, and constructed no `FileReader`, in any local-media test.
- **Storage.** Cache Storage, IndexedDB, OPFS, `localStorage`, and `sessionStorage` stayed empty through load, reload, playback, replacement, and clear. The capability tests additionally compare against a same-origin baseline page before the application first runs.
- **Capability side effects.** The instrumented load and reload wraps 28 or more APIs, including `RTCPeerConnection`, `createDataChannel`, `MediaSource`, workers, `WebSocket`, `EventSource`, `XMLHttpRequest`, `fetch`, `sendBeacon`, `getDirectory`, `persist`, `estimate`, `permissions.query`, `getUserMedia`, `getDisplayMedia`, `enumerateDevices`, notifications, geolocation, `digest`, `caches.open`, `indexedDB.open`, `Storage.setItem`, and `createObjectURL`. It recorded 0 calls and 0 dialogs in both browsers, and repeated detection after reload gave an identical report. There is no user-agent inspection and no persisted or transmitted result, so no stable fingerprint is produced.
- **CSP.** The production policy is exactly `default-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'`, unchanged since Phase 1B. Same-origin resources and `blob:` media load, capability reporting needs no relaxation, and no external origin is allowed. A CSP violation would appear as a console error, and none occurred.
- **Console.** There were 0 console errors, warnings, page errors, or unhandled rejections across all qualification runs, and 0 console messages of any type in the supplementary capture. No application message was filtered.

## Gate matrix

| ID  | Criterion                     | Evidence                                                                                                                                                                                                                                                                                                                                  | Result   | Limitations                                                                                                                                                                              |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Installable web foundation    | The build and preview pass. The manifest is reachable and valid, `name`/`short_name`/`display: standalone` are present, and `id`, `start_url`, and `scope` resolve to the root. Icons are served as PNG, and their IHDR dimensions equal the declared 192×192 and 512×512. CDP reports 0 manifest errors and only the automation-context `in-incognito` installability error. The worker registers at the root in production and is `activated`, answers 0 requests, and leaves Cache Storage empty. There is no horizontal overflow and the layout fits at 360 px and 1280 px. Both browsers. | **PASS** | Chromium engine only. No real install prompt was accepted. No deployment, HTTPS, or HTTP headers were tested (a deployment decision). No offline behavior exists, by design.                |
| G2  | Local media selection         | Choose, replace, clear, and choose again for 3 fixtures and 2 container types. Same-file reselection, 5 rapid replace/clear cycles with 20 URLs each revoked once, 0 file-content reads, and 0 uploads or non-`GET` requests. Both browsers.                                                                                                | **PASS** | Automated file input (`setInputFiles`), not the native OS file dialog. No large files. File access was not tested on Android.                                                             |
| G3  | Local playback                | The WebM/VP8 and MP4/H.264/AAC lifecycles, including the checks listed under Phase 1D qualification changes. Both browsers.                                                                                                                                                                                                              | **PASS** | Synthetic, small, short fixtures only. Chromium engine only. The Playwright contexts had sticky user activation, so the browser autoplay restriction itself was not exercised; the tests show only that the application never starts playback. Native controls are the browsers' own. No large-file, memory, or real-world media evidence. |
| G4  | Accurate capability reporting | Every check and `canPlayType()` answer matched the page's independently observed globals in both browsers. Unit tests cover missing, throwing, and wrong-typed APIs. There were 0 side-effect calls, 0 dialogs, 0 storage changes, and 0 non-static requests, with a stable report on reload. The report contains no "supported" or "compatible" wording, states the disclaimer, and derives no Progressive Watch or mode result. | **PASS** | Both browsers exposed every API, so the "not available" and "not evaluated" paths are proven by unit tests with synthetic scopes, not by a browser lacking an API.                     |
| G5  | Automated baseline            | 121 Vitest tests and 29 Playwright tests, reproducible from `npm ci` with the committed lockfile. They cover the shell and PWA, the lifecycle, playback, capabilities, and the privacy and security boundaries. Three consecutive Chromium runs and two Chromium + Chrome runs, all with retries disabled, had 0 failures or flakes. Mutation checks confirm the new tests detect their target defects. The audit is clean. | **PASS** | There is no CI workflow (see below). The Chrome project is opt-in and depends on a locally installed Chrome. The MP4 regeneration needs an external FFmpeg with libx264; the tests themselves do not. |

## CI readiness

The test commands are CI-ready in form: they are non-interactive, exit non-zero on failure, build from the lockfile, use a strict port, and set `forbidOnly` under `CI`. No CI workflow was added.

The only runner environment qualified here is macOS arm64. Behavior on a hosted Linux runner has not been verified, in particular H.264/AAC decoding in Playwright's Linux Chromium build, font-dependent layout, and the headless installability result. Adding a workflow now would mean speculative configuration and possibly red builds unrelated to the gate. A minimal workflow that runs `npm ci`, `npx playwright install --with-deps chromium`, `npm run check`, and `npm run test:e2e`, after a first verification of that runner, is recorded as a follow-up. No repository authority makes CI part of the Phase 1 exit gate.

## Limitations and nonclaims

This qualification does **not** establish:

- support or compatibility for any browser. Every status in [COMPATIBILITY.md](COMPATIBILITY.md) remains unchanged, including Chrome desktop, Edge desktop, and Chrome Android `NOT TESTED`, and the `MP4 / H.264 (AVC) / AAC` Progressive Watch status `NOT TESTED`;
- any Edge, Firefox, Safari, or other non-Chromium-engine result;
- physical Android Chrome qualification or any Android behavior; the 360 px viewport is layout evidence only;
- iPhone or iOS qualification;
- real cross-network behavior, NAT traversal, STUN across NAT, or TURN;
- synchronization or Local Sync behavior;
- Progressive Watch, MSE playback, fragmentation, or data-channel media transport;
- large-file, long-run, memory, thermal, or battery behavior, on desktop or mobile;
- real-world, camera, phone, or downloaded media;
- a deployed HTTPS origin, HTTP security headers, or a real install flow;
- any performance threshold.

## Deferred debt

`DEFERRED-PHYSICAL-001` through `DEFERRED-PHYSICAL-007`, listed in [PROJECT_STATE.md](../PROJECT_STATE.md), all remain **OPEN** and unchanged. Phase 1 closure does not close, rename, or narrow any of them. In particular, `DEFERRED-PHYSICAL-001` (physical Android Chrome local-media qualification) is not satisfied by any evidence here.

## Conclusion

**PASS — PHASE 1 EXIT GATE SATISFIED**

At revision `4bf6e311723ff3c59dc47d9b3b108c9006f0d7a3`:

- the installable web foundation selects and plays representative synthetic local media, VP8/WebM and MP4/H.264/AAC, in the repository's development browsers, Playwright Chromium 153 and Google Chrome 154;
- it reports capabilities accurately and without side effects;
- it has a reproducible automated baseline that passed repeatedly with retries disabled.

No synchronized or progressive behavior is implied. This is a development gate for the application foundation, not a product support declaration. Phase 2 — Internet P2P Foundation is next and has not started.
