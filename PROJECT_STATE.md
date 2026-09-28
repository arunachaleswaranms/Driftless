# Project State

This file is the authoritative handoff document for human and automated development sessions. Update it whenever a meaningful implementation or architecture change is accepted. Claims here must reflect repository evidence.

## Project

Driftless

## Current Version

`0.0.0-planning`

## Phase 0 — Architecture & Feasibility

**Phase status:** SOFTWARE FEASIBILITY CLOSED / PASS

**Final independent review gate:** `PASS — SAFE TO COMMIT AND CLOSE PHASE 0 SOFTWARE FEASIBILITY`

**Merged milestone:** [PR #1 — Phase 0: architecture and feasibility validation](https://github.com/arunachaleswaranms/Driftless/pull/1), merged into `main` at `17eea6a` on 2026-09-27. The reviewed Spike 0.7 implementation was committed at `e1ea11b` before merge.

**Architecture conclusion:** No architecture change required.

**Physical and real-network qualification:** DEFERRED; `DEFERRED-PHYSICAL-001` through `007` remain OPEN. Software closure is not a product support or physical-device pass.

## Current Development Stage

Phase 1 — Application Foundation: **IN PROGRESS**.

## Current Branch

`phase/1-application-foundation`

Phase 0 was merged through PR #1 at `17eea6a`. Phase 1 work proceeds on `phase/1-application-foundation`, created from `main` at `4c15a54`.

## Repository Status

The initial local repository structure exists:

- `apps/web/`
- `services/signaling/`
- `packages/protocol/`
- `packages/sync-engine/`
- `packages/transfer-engine/`
- `docs/adr/`
- `docs/planning/`
- `spikes/phase0/`

The master planning document exists at `docs/planning/Driftless_Master_Project_Plan_v0.1.docx`. The Phase 0 experiment framework and isolated Spike 0.1 through Spike 0.7 browser experiments now exist under `spikes/phase0/`. The Spike 0.3 synthetic binary-transfer, Spike 0.4 synthetic OPFS storage, Spike 0.5 MP4 parsing/segmentation, Spike 0.6 MSE progressive-playback, and Spike 0.7 integrated P2P playback experiments are laboratory code only. Spike 0.7 adds no dependency; it imports the Spike 0.5/0.6 modules and pinned MP4Box.js. Spike 0.5 pins MP4Box.js 2.4.1 as a spike-local dependency (`spikes/phase0/spike-05-mp4-segmentation/package.json`); it is not an approved production dependency. The production web client foundation exists under `apps/web/` (see Phase 1 below). No signaling service, synchronization engine, transfer engine, production cache, production transfer protocol, synchronization implementation, or Progressive Watch implementation has been initialized. `services/signaling/`, `packages/protocol/`, `packages/sync-engine/`, and `packages/transfer-engine/` remain empty.

## Accepted Architecture

- TypeScript, React, Vite, PWA, and HTML5 video form the planned web-client baseline.
- WebRTC is peer-to-peer-first; `RTCDataChannel` is planned for synchronization data and, in Progressive Watch, media transport.
- A small signaling service coordinates sessions and WebRTC negotiation but should not normally carry or permanently store media.
- STUN supports direct connectivity. TURN is the necessary fallback when direct connectivity fails and can relay media, creating bandwidth and cost exposure.
- Initial playback synchronization is host-authoritative.
- Local Sync and Progressive Watch are independent modes.
- The synchronization plane, media transfer plane, and signaling plane remain logically independent.
- Progressive Watch initially targets MP4 containing H.264/AVC video and AAC audio.
- Progressive playback is enabled only after runtime capability detection.
- MSE, OPFS or other browser storage, and MP4Box.js remain investigation areas, not proven choices. Spike 0.5 found MP4Box.js viable for inspection and segmentation of non-fragmented target media, but it is not selected. Spike 0.6 found progressive MSE playback of the Spike 0.5 planned segments viable in controlled desktop Chrome only; MSE is not qualified on Android or on other browsers.
- Development optimizes for two-person rooms before considering a maximum of three participants.
- The project advances through explicit phase exit gates.

See [Architecture](docs/ARCHITECTURE.md), [Media Pipeline](docs/MEDIA_PIPELINE.md), and the [accepted ADRs](docs/adr/).

## Completed

- Initial directory structure is present.
- Master planning DOCX is present under `docs/planning/`.
- Repository documentation baseline and ADR-0001 through ADR-0006 are present.
- Future-facing `.gitignore` is present.
- Phase 0 experiment tracking exists for Spikes 0.1 through 0.7.
- The isolated Spike 0.1 page implements local `File` to object-URL binding, native video controls, media diagnostics, error display, and object-URL cleanup without application-level whole-file reads or upload code.
- Spike 0.1 deterministic formatter/diagnostic tests pass: 5 tests, 0 failures on Node.js v26.3.0.
- A macOS 26.6.2 / Chrome 153.0.8010.48 smoke run loaded the experiment, reported target MP4/H.264/AAC MIME support as `probably`, initialized diagnostics, and produced no browser console warning/error. It did not exercise local file selection or playback.
- User-reported desktop Chrome evidence confirms local-file selection, compatible local playback, pause/resume, and seeking worked with good overall behavior. Exact file characteristics, seek directions/distances, and memory measurements were not recorded.
- Spike 0.1 is closed at `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`. Its desktop path is accepted from the actual manual evidence, while Android architecture risk and final Android support remain unqualified.
- The isolated Spike 0.2 page establishes two browser `RTCPeerConnection` peers using same-origin, in-memory development signaling and a text-only control data channel. It exposes required connection state, candidate types, selected-pair fields, protocol, RTT, and evidence-based path classification.
- Spike 0.2 deterministic diagnostic tests pass: 5 tests, 0 failures on Node.js v26.3.0.
- `AUTOMATED DESKTOP` validation on macOS 26.6.2 with Chrome 153 established offer/answer, ICE completion, `connected` state, an open data channel, `PING`/`PONG`, selected-pair diagnostics, and clean local cleanup in two same-browser tabs.
- The final selected pair snapshot was host/host over UDP with 1.00 ms RTT reported on each peer. Repeated local runs also observed unselected server-reflexive candidates. These diagnostics do not prove separate-network connectivity or establish a performance baseline.

- The isolated Spike 0.3 page transfers deterministic synthetic bytes over one ordered `RTCDataChannel` in framed chunks with event-driven `bufferedAmount`/`bufferedamountlow` backpressure, per-chunk Web Crypto SHA-256 and deterministic-pattern verification, a chunk-digest manifest, explicit fault modes, bounded control messages, and resource accounting. It never materializes the whole payload on either peer.
- Spike 0.3 deterministic tests pass: 10 tests, 0 failures on Node.js v26.3.0, including a real sender → fake channel → real receiver transfer. All Phase 0 tests: 20 pass, 0 fail.
- `AUTOMATED DESKTOP` validation used two headless Chrome 153.0.8010.53 pages on macOS 26.6.2, with mDNS host-candidate obfuscation disabled for the lab profile and a host/host UDP selected pair. It ran a 23-run lab matrix twice.
  - 1, 16, 64, and 128 MiB transfers at 16/64/128 KiB chunks passed integrity.
  - 256 KiB chunks were rejected before sending because the frame exceeds Chrome's negotiated 262,144-byte `maxMessageSize`.
  - Max `bufferedAmount` stayed ≤ high-water + one frame in all 38 sent runs.
  - All five fault modes were detected, and cleanup released all owned resources during and after transfers.
- Same-host warmed throughput plateaued at about 35 MiB/s. The first 2–4 s of sustained sending on a fresh association was markedly slower. These are lab observations, not Internet throughput or planning values.
- Spike 0.3 was checkpointed at `0664735`. This session proceeded to Spike 0.4 at the user's direction.
- The isolated Spike 0.4 page writes deterministic synthetic bytes to OPFS one reused block at a time. It uses `createWritable()` and, separately, `FileSystemSyncAccessHandle` in a dedicated worker. It verifies selected ranges and every byte, resumes from the stored size, persists an entry across reload, reports `estimate()`/`persisted()`/`persist()`, refuses oversize or low-headroom requests, and deletes with confirmed absence (**Clear Spike Storage**).
- Spike 0.4 deterministic tests pass: 9 tests, 0 failures, using in-memory fakes of the OPFS handle interfaces. All Phase 0 tests: 29 pass, 0 fail.
- `AUTOMATED DESKTOP` validation used headless Chrome 153.0.8010.53 on macOS 26.6.2 with a throwaway profile. The lab matrix ran twice.
  - Entries of 1 MiB, 64 MiB (64 KiB/1 MiB/4 MiB blocks), 256 MiB, 512 MiB, and 1 GiB passed range and every-byte verification.
  - Aligned and unaligned resume boundaries were intact. A 64 MiB entry survived a page reload.
  - Usage returned to baseline after each deletion, and the final OPFS root was empty.
  - V8 heap stayed ≤ 2.8 MB. Transient verification-read ArrayBuffer garbage peaked at about 128 MB and was reclaimed by GC.
- Spike 0.4 write-API findings, recorded as lab observations:
  - `createWritable()` data is invisible until `close()`.
  - A `keepExistingData` resume copies the existing file (O(n) time and 2× usage while open).
  - The worker sync handle writes in place with an exclusive lock, and the main thread can read flushed data.
  - Headless-profile quota was 10 GiB (`usage + 10 GiB`), which is environment-specific.
  - `persist()` resolved `false`.

- Spike 0.4 was checkpointed at `72c8629`. This session proceeded to Spike 0.5 at the user's direction.
- The isolated Spike 0.5 page reads a locally selected MP4 in bounded `File.slice()` blocks, one read in flight, with no upload (`connect-src 'none'`). Before MP4Box.js 2.4.1 sees any bytes, it runs a header-only box scan and a `moov` sample-table budget check. It then:
  - inspects tracks, codecs, timing, and keyframes;
  - produces fragmented-MP4 init and media segments in memory with two strategies (MP4Box.js built-in `onSegment`, and a deterministic time plan derived from the sample tables and cut with `createFragment()`);
  - verifies every segment with an independent fMP4 box walker, then releases it.
- Spike 0.5 deterministic tests pass: 18 tests, 0 failures, 11 of them running real MP4Box.js over in-code MP4 fixtures. All Phase 0 tests: 47 pass, 0 fail.
- `AUTOMATED DESKTOP` validation used headless Chrome 153.0.8010.53 on macOS 26.6.2 and synthetic FFmpeg test media only. The media ranged from 1.2 MB to 4.53 GB and covered `moov` first and last, fragmented, HEVC, MP3-in-MP4, Opus, WebM, video-only, two-audio, truncated, random, and oversize-claim inputs. The matrix ran twice.
  - Every target file was classified `TARGET COMPATIBLE` and produced a verified init segment plus complete, contiguous, monotonic media segments, with 0 verification problems.
  - The 90-minute, 4.53 GB `moov`-last file had metadata after 7 reads and 7.0 MB. Full passes held at most 6.3 MB of source data in the parser.
  - The planned segment at 45:01 needed 8 reads and 8.7 MB, and it was byte-identical to its sequential cut.
  - Non-target and malformed inputs were classified or refused before parsing. The console was empty, and the only network requests were same-origin static files.
- Spike 0.5 findings, recorded as lab observations:
  - MP4Box.js 2.4.1 built-in `rapAlignement` segments end on the keyframe, so later video segments start one sample after it. Its boundaries also change after `seek()`.
  - All segmented tracks must share one `nbSamples`.
  - Sample-table expansion costs about 343 B of JS heap per sample (142 MB for 90 minutes).
  - An undrained, unselected track pins the whole file in parser buffers.
  - Already fragmented sources were retained at 2× their size, so they are classified `NON-TARGET`.

- Spike 0.5 was checkpointed at `9d802b6`. This session proceeded to Spike 0.6 at the user's direction.
- Spike 0.6 passed independent re-review after the B1, B2, and B3 fixes and was committed at `7bbb10f`. Its status is `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`; the review history below is retained.
- The isolated Spike 0.6 page plays a locally selected MP4 through MSE while supplying it progressively.
  - It cuts Spike 0.5 planned, keyframe-aligned fMP4 segments on demand from bounded `File.slice()` windows, and verifies and refuses bad fragments.
  - It releases segments with deterministic arrival profiles (FAST 8×, NORMAL 1.5×, SLOW 0.5×, BURSTY, MANUAL).
  - It appends through a per-SourceBuffer queue that never appends while `updating`, into one muxed or two separate SourceBuffers.
  - It gates on a lookahead cap and append backpressure, trims behind the playhead, reprioritises on unbuffered seeks, calls `endOfStream()` only when idle, and tears down with a resource report.
- Spike 0.6 tests pass: 42 tests, 0 failures. They include 16 deterministic pipeline regressions for B1, B2, and B3 (gated preparation, seeded rapid-seek storms in both SourceBuffer layouts), and 6 preparer tests running real MP4Box.js. The preparer's cuts are byte-identical to Spike 0.5's planned cuts. All Phase 0 tests: 89 pass, 0 fail.
- Post-review Chrome reruns passed early playback, buffer growth, underrun/recovery, buffered and unbuffered seeks, separate-track append, EOS, refusal, and cleanup. The exact review seek race retried segment 7 and resolved seeking in 26.9 ms; 10 further seek cycles found no falsely appended segment. The review reset/load probe and 5 additional rapid reset/load cycles kept the new session owned and playable, with old MediaSources closed and clean final teardown. After the B3 fix, Chrome seek storms on MP-02 (1,147 seeks in double and triple bursts, many during SourceBuffer updates, including one with cuts delayed 20–60 ms) produced 0 pipeline failures, 0 permanent `seeking` hangs, and 0 stale or partial `APPENDED` promotions. The same delayed-cut storm against the pre-fix code failed 17 times with `DROPPED`. The review's own storm script, rerun unchanged, found 0 failures in 252 seeks, and the accepted MSE scenarios all passed again. The subsequent independent re-review accepted these fixes. See the Spike 0.6 result record.
- `AUTOMATED DESKTOP` validation used Chrome 153.0.8010.53 on macOS 26.6.2 (headless, plus one headed smoke run) with synthetic media only. The autoplay policy was left in force: `play()` without user activation was rejected, and runs used trusted CDP clicks. Two identical final runs followed a development run.
  - Playback began after 2 of 76 segments (MP-02, 110.5 MB), and after 2 of 2,700 segments on the 4.53 GB, 90-minute file when 0.31 % of it had been read. It continued while withheld segments were released: about 30 presented fps, advancing `currentTime`, and changing frame digests.
  - Buffer ahead grew to the 60 s cap under FAST delivery. SLOW delivery produced 4 `waiting` underruns, each recovering within 10 ms of the next append.
  - Buffered seeks took 11–17 ms. Unbuffered seeks (to 180 s, 90 s, 45:01, and 22:30) took 15–82 ms: they reprioritised one keyframe-aligned segment cut from one bounded window, with no SourceBuffer reset or init re-append.
  - `endOfStream()` after the last `updateend` produced a normal `ended`.
  - Reset, replace, MSE-failure, parser-failure, and `pagehide` teardown were clean.
  - 10 non-target or malformed files were refused before any MediaSource was created.
  - 0 console messages and 0 exceptions; only same-origin static requests.
- Spike 0.6 findings, recorded as lab observations:
  - A segment that does not start on a keyframe is accepted silently; frames up to the next keyframe are dropped.
  - Chrome applies source edit lists in MSE.
  - The init segment's `updateend` precedes `loadedmetadata`, and MP4Box.js init segments carry no duration.
  - A muxed SourceBuffer reports the intersection of its tracks.
  - `QuotaExceededError` occurred at about 159 MB of uncapped 720p lookahead, and clears only after playback advances.
  - No `stalled` event fired for MSE underruns.
  - A never-shown background tab defers `sourceopen` until it is shown.
  - `droppedVideoFrames` is unusable under this automation.

- The isolated Spike 0.7 experiment integrates two browser peers with development-only BroadcastChannel signaling, Spike 0.5/0.6 guarded MP4 preparation, bounded binary RTCDataChannel chunks and Spike 0.3 backpressure, receiver SHA-256 reassembly, MSE append queues, buffer feedback, experimental buffer windowing, pause/pacing, and seek generations. The receiver owns no source file. All implementation is under `spikes/phase0/`; no production directory was modified.
- `AUTOMATED DESKTOP / CONTROLLED NETWORK` Chrome 153 evidence on 2026-09-27 used two same-origin tabs and an ignored 110,544,641 B, 300.023 s synthetic MP4 with 76 planned segments. Both peers connected over a host/host UDP selected pair. Video and audio init appended before media. Actual receiver playback began with 2 segments, 3,218,827 B received (2.911789% of source size), and 8.730701 s buffered. Frames/time advanced while later segments arrived. Host `bufferedAmount` peaked at 589,416 B, within the 512 KiB high-water mark plus one 65,568 B frame, and backpressure pauses/resumptions occurred.
- Controlled Chrome runs demonstrated growing ahead buffer, a real non-seeking `waiting` at buffered end under host hold and constrained pacing, recovery when media arrived, buffered and unbuffered remote seek, repeated overlapping seek bursts with stale chunks discarded and latest target playing, malformed-frame rejection with transfer continuing, old/future MSE-range eviction, clean cleanup, and a second early-playback run without refreshing the tabs. Development runs exposed an undefined seek local, concurrent host source reads across generations, and duplicate receiver channel binding; all were fixed and retested. The complete record is [Spike 0.7 result](spikes/phase0/results/spike-07-p2p-progressive.md).
- All Phase 0 Node tests pass: 92 tests, 0 failures at the initial review (including 3 Spike 0.7 transport/reassembly/peer-ownership tests). Spike 0.7 syntax checks pass. No device appeared in `adb devices`.
- The first independent review of Spike 0.7 returned `REQUEST CHANGES — DO NOT COMMIT`. B1: the host's persistent transfer cursor ignored buffered/local seeks, so `remote seek → local buffered seek` and rapid mixed seeks stalled playback permanently at the old buffer end while far-future MSE media grew. B2: Phase 0 closure documentation was stale. Both are fixed:
  - Host scheduling now follows the receiver's current playback need. `BUFFER_STATUS` reports the generation, sequence, playhead, contiguous coverage, and the first segment missing at the contiguous frontier. Every seek starts a new generation; stale needs are ignored; the ahead cap counts only contiguous coverage; the host send window and a per-segment delivery limit bound transfer; `waiting` reports its need at once; and MSE trimming works while stalled.
  - Chrome validation of the fix also found and fixed a trimmed-tail need defect, a seek-boundary tolerance hang, a too-wide segment-end tolerance, and a pre-existing stale `initReady` that broke unbuffered seeks in second sessions.
  - All Phase 0 Node tests now pass: **120 tests, 0 failures**, including 28 Spike 0.7 scheduling unit and deterministic simulation tests. The simulated regressions fail against a model of the pre-fix scheduler.
  - In `AUTOMATED DESKTOP / CONTROLLED NETWORK` Chrome 153, reproductions A and B hung permanently (33.95 s) on a copy of the pre-fix build and passed 4/4 each on the fixed build. Three seeded mixed-seek stress runs (783 seeks, including bursts during backpressure, SourceBuffer updates, and active transport) had 0 permanent hangs, 0 pipeline failures, 63/63 gap crossings, 0 redeliveries, host send-ahead ≤ 20 s, and a maximum RTC `bufferedAmount` of 589,856 B. A full E2E regression pass (early playback at 2.911789%, concurrency, cap, backpressure, hold/underrun/recovery, buffered and remote seek, an eviction gap, malformed input, cleanup, and a second run with an unbuffered seek) passed.

No product feature is complete. Spikes 0.1–0.7 completed their software-feasibility questions, and Phase 0 software feasibility is closed after the final independent review passed. Spike 0.2 and Spike 0.3 retain `PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED`; Spikes 0.1, 0.4, 0.5, and 0.6 retain `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`. Spike 0.5 real-world media coverage remains `MANUAL TEST REQUIRED`. Spike 0.6 passed independent re-review after fixes for B1, B2, and B3 and was committed at `7bbb10f`. Spike 0.7's provisional software result was accepted on final independent review after its first `REQUEST CHANGES — DO NOT COMMIT` and subsequent fixes; it was committed at `e1ea11b`. Physical Android, external-network, and real-world media qualification remain deferred.

## Phase 1 — Application Foundation

**Phase status:** IN PROGRESS. The Phase 1 exit gate has not been evaluated and has NOT YET PASSED.

| Part | Scope | Status |
| --- | --- | --- |
| Phase 1A | Production React/Vite/PWA foundation and automated test baseline | Implemented |
| Phase 1B | Local browser media player: file selection, playback, media metadata, errors, and lifecycle | Implemented |
| Phase 1C | Capability detection: local runtime API observations | Implemented |
| Phase 1D | Qualification and closure, including evaluation of the Phase 1 exit gate | NOT STARTED (next) |

The web client lives under `apps/web/`. It is written from scratch; no Phase 0 spike code was copied into it.

### Phase 1A — foundation

- React 19, TypeScript 6.0, and Vite 8 as a standalone npm package with a committed lockfile. No repository-level workspace exists yet.
- A minimal application shell: application name, development-build notice, skip link, the local video area, and a browser-capabilities area (a placeholder until Phase 1C).
- PWA foundation: a web app manifest with 192 px and 512 px placeholder icons, and a service worker registered only in production builds. The worker has no fetch handler and caches nothing, so the application has no offline behavior.
- Production builds carry a same-origin-only Content Security Policy meta tag. The application makes no backend, analytics, telemetry, or other external requests.
- Tooling: `tsc -b` type checking, ESLint 10 with type-aware typescript-eslint rules, Prettier, Vitest with Testing Library and jsdom, and Playwright on Chromium.

### Phase 1B — local browser media player

- `apps/web/src/features/local-media/` plays one user-chosen local video file in a native `<video>` element with the browser's own controls (`controls`, `playsInline`, `preload="metadata"`, no autoplay). The user can choose, replace, and clear the file.
- The `File` is bound through `URL.createObjectURL()`. The application never reads the file contents (no `arrayBuffer()`, `FileReader`, or similar), and never uploads, caches, or stores it. The browser's media stack reads it on demand.
- Each selection owns one object URL and one media element, keyed by a selection id. On replacement, clear, or unmount, the element is paused and detached before the URL is revoked. Media events from a previous selection are ignored.
- The panel shows the file name, browser-reported type, and size, then the browser-reported duration and dimensions. Unknown or infinite durations are shown as not reported. The browser-reported type is not treated as a compatibility signal, and no local path is available to or shown by the page.
- `MediaError` codes are mapped to safe categories. The user-facing message says that this browser could not play the selected media, without naming a codec or exposing the browser's internal message.
- The production CSP now also allows `media-src 'self' blob:`, which the object URL requires. Without it, Chromium blocked the object URL under the `default-src 'self'` fallback. No other directive changed.
- The service worker is unchanged. Browsers do not dispatch `blob:` requests to service workers, and the browser tests confirm that no response came from the worker and that Cache Storage, OPFS, and IndexedDB stayed empty.
- Browser tests use two synthetic, generated VP8/WebM fixtures without audio (16,273 B and 6,496 B) under `apps/web/e2e/media/`, with their generator script, command, tool versions, and SHA-256 digests recorded there. They are not part of the production build.
- No runtime or development dependency was added.

### Phase 1C — capability detection

- `apps/web/src/features/capabilities/` replaces the placeholder with a local report of **runtime API observations**. A detector reads properties from an injectable global-scope object (the page's `window` by default) when the panel mounts, never at module import. Missing APIs are reported, not assumed; a getter that throws is reported as not evaluated instead of breaking the page.
- Each entry is reported as `Available`, `Not available`, or `Not evaluated` (the secure-context flag as `Yes` or `No`), with each individual API check listed in text.
- Current foundation: secure context (`window.isSecureContext`; browsers count localhost as secure, so this says nothing about a deployment), `File` and `Blob`, `URL.createObjectURL` and `URL.revokeObjectURL`, `HTMLVideoElement` with `HTMLMediaElement.prototype` `play`, `pause`, and `canPlayType`, and `navigator.serviceWorker`. The `canPlayType()` answers for `video/mp4` and `video/webm`, asked without codec parameters, are shown only as the browser's own declarations. No codec, profile, or H.264/AAC probe string is used.
- Later-phase prerequisites, informational only and unused by this build: `RTCPeerConnection`, `RTCPeerConnection.prototype.createDataChannel` and `RTCDataChannel`, `MediaSource`, `MediaSource.isTypeSupported`, and `SourceBuffer`, `navigator.storage.getDirectory`, and `crypto.subtle.digest`.
- Detection only reads properties and asks `canPlayType()` of a detached, source-less video element. It constructs no peer connection or MediaSource, opens no OPFS directory, requests no permission or storage persistence, hashes nothing, makes no request, and writes no storage. Results stay on the page and are neither transmitted nor persisted. There is no user-agent inspection.
- **Runtime observation is not product compatibility.** The report derives no browser support status and no mode eligibility; in particular there is no Progressive Watch availability result. Product compatibility remains governed by [COMPATIBILITY.md](docs/COMPATIBILITY.md), whose statuses are unchanged (`NOT TESTED`). Enabling Local Sync or Progressive Watch later requires their own runtime checks (negotiated protocol features, actual media inspection, storage conditions, runtime errors) and the evidence of their phase gates. Mode gating is not implemented.
- The CSP and service worker are unchanged. No runtime or development dependency was added.

### Phase 1 automated evidence

`AUTOMATED PASS` on macOS 26.6.2 with Node.js 26.3.0 and npm 11.16.0: 121 Vitest unit/component tests and 25 Playwright tests against the production build in Playwright's Chromium 153.0.8010.12.

- The Phase 1A smoke tests cover shell rendering, keyboard skip-link focus, narrow and desktop layout, manifest and icon delivery, service worker registration and control, the complete CSP, and zero Chromium manifest/installability errors other than the automation-only `in-incognito`.
- The Phase 1B unit/component tests cover the empty state, object URL binding, metadata, unknown durations, replacement, clear, same-file reselection, unmount, stale-event rejection, conservative errors, StrictMode and repeated-cycle URL balance, and the absence of file-content reads.
- The Phase 1B browser tests cover: metadata; playback that starts only after a trusted click and advances; pause; forward and backward seeks set through `currentTime`; keyboard play/pause; replacement and clear with URL revocation; an unplayable file; 5 rapid replace/clear cycles with every URL revoked exactly once; same-origin `GET`-only requests; and narrow and desktop fit.
- The Phase 1C unit/component tests use synthetic global scopes: fully populated, empty, and each API removed in turn, plus a throwing getter, wrong-typed values, and every `canPlayType()` answer. They verify that detection never calls the APIs it observes, gives identical reports on repeated runs without changing the scope, and that the panel uses only observation wording, including its explicit statement that API presence is not browser or product support.
- The Phase 1C browser tests compare every reported check and `canPlayType()` answer with the test browser's own globals, observed independently in the page. They also confirm the disclaimer, identical reports after a reload, and narrow and desktop fit. An instrumented load and reload recorded no peer connection, MediaSource, worker, socket, `fetch`, OPFS, persistence, permission, media-device, Cache Storage, IndexedDB, or Web Storage call and no dialog, and requests only for the application's own static files. Cache Storage, IndexedDB, OPFS, and Web Storage stayed empty from a same-origin baseline page through load and reload.
- In Chromium 153.0.8010.12 every observed API surface was present, the secure-context flag was true on `localhost`, and `canPlayType()` answered `maybe` for both `video/mp4` and `video/webm`. These are observations of one automation browser, not a compatibility result.
- Every browser test fails on any console error or warning, uncaught exception, or cross-origin request.

This is development evidence and not a compatibility claim. Playwright's Chromium reported sticky user activation at page load, and the fixtures have no audio, so the browser autoplay restriction itself was not exercised. The tests show only that the application never starts playback on its own. No physical device, other browser engine, MP4/H.264/AAC file, large file, or memory measurement was part of this evidence. `DEFERRED-PHYSICAL-001` remains open.

Not yet done in Phase 1: Phase 1D qualification and closure, including evaluation of the Phase 1 exit gate.

## Open Deferred Qualification

- Physical Android and real external-network qualification remain open under the debt list below. No deferred debt was closed by the software review or PR merge.

## Not Started

- Phase 2 and later implementation: signaling, rooms, WebRTC, synchronization, media transfer, and Progressive Watch. Physical and real-network qualification remains deferred.

## Evidence Classification Policy

Use these labels without promotion between categories:

1. `AUTOMATED PASS`
2. `DESKTOP MANUAL PASS`
3. `EMULATOR PASS`
4. `PHYSICAL DEVICE PASS`
5. `DEFERRED PHYSICAL`

Automation and emulator evidence may improve confidence but never satisfy a physical-device gate. If a future spike cannot establish architectural feasibility without a real external device or network, stop and report that limitation.

## Physical Qualification Debt

- `DEFERRED-PHYSICAL-001 — Spike 0.1 Android Chrome local media qualification`: validate file selection, playback, pause/resume, seeks, lifecycle cleanup, errors, and representative large-file resource behavior on physical Android Chrome. Android architecture risk remains unqualified; final Android support cannot be claimed.
- `DEFERRED-PHYSICAL-002 — Spike 0.2 Android Chrome and external-network WebRTC qualification`: validate two real peers on genuinely separate Internet networks, including at least one physical Android participant where applicable, and record selected direct or relay path. Current same-host desktop evidence is not a real-network result.
- `DEFERRED-PHYSICAL-003 — Spike 0.3 binary transfer over real external network / Android`: repeat bounded synthetic binary transfer between real peers on genuinely separate Internet networks, including at least one physical Android Chrome participant. Record the selected direct or relay path, the negotiated `maxMessageSize`, integrity, backpressure behavior, association warm-up, receiver/sender memory and CPU, and throughput under real loss and latency. Current evidence comes from headless same-host desktop Chrome and is not a real-network, TURN, or mobile result.
- `DEFERRED-PHYSICAL-004 — Spike 0.4 Android Chrome OPFS/storage qualification`: on physical Android Chrome, repeat bounded OPFS writes with representative sizes, range and full verification, resume, reload persistence, deletion, and headroom refusal. Also cover:
  - the worker sync-access-handle path;
  - `estimate()` quota and usage;
  - the `persist()` outcome;
  - storage-full, eviction, backgrounding, and tab-discard behavior;
  - transient read-buffer memory.

  Record device model, OS, browser version, and free storage. Current evidence comes from headless desktop Chrome with a 10 GiB throwaway-profile quota and is not a mobile or normal-profile result.

- `DEFERRED-PHYSICAL-005 — Spike 0.5 Android Chrome MP4 parsing/segmentation qualification`: on physical Android Chrome, repeat the pre-check, inspection, and built-in and planned segmentation on `moov`-first and `moov`-last target files, including a multi-GB, ≥ 90-minute file, plus later-position planned random access with hash comparison. Record:
  - heap after `onReady` (sample-table cost) and peak heap;
  - parser-retained bytes;
  - `File.slice()` behavior for Downloads and content-URI files;
  - throughput;
  - backgrounding during a long pass;
  - device model, OS, browser version, and free RAM.

  Current evidence comes from headless desktop Chrome with synthetic media and is not a mobile or real-world-media result.

- `DEFERRED-PHYSICAL-006 — Spike 0.6 Android Chrome MSE progressive-playback qualification`: on physical Android Chrome, repeat MSE-01 to MSE-12 with MP-01, MP-02, and the multi-GB MP-03. Cover:
  - early start from an initial buffer, ahead buffering, underrun and recovery;
  - seeks inside and outside the buffer, including 45:00 on the 4.53 GB file;
  - end of stream, reset, replace, and failure cleanup;
  - the `QuotaExceededError` limit and recovery;
  - backgrounding, screen-off, and a never-shown tab.

  Record device model, OS, Chrome version, free RAM, heap after the `moov` parse, `isTypeSupported` answers, audible A/V sync, and visible smoothness. Current evidence comes from automated desktop Chrome with synthetic media and muted audio, and is not a mobile or real-world-media result.

- `DEFERRED-PHYSICAL-007 — Spike 0.7 end-to-end Progressive Watch over physical Android / real external networks`: repeat the integrated two-peer MP4/H.264/AAC proof with at least one physical Android Chrome peer and peers on genuinely separate Internet networks. Record selected direct/relay candidate path, negotiated message size, metadata/init/fragment integrity, early playback percentage, concurrent transfer/playback, backpressure, buffer growth, slowdown/underrun/recovery, buffered and remote seeks including rapid bursts, pause, cleanup, second run, memory/CPU, and audible A/V sync. Test TURN where direct connectivity fails. Current evidence is same-host Chrome only; host/host UDP does not qualify Internet traversal or a TURN relay.

Phase 0 closure supplies no physical Android or iOS result, real cross-state Internet result, representative NAT traversal or STUN-across-NAT result, TURN relay result, broad browser-compatibility result, real-world media-corpus result, or long-run mobile memory/thermal result. These remain future qualification work, not inferred passes.

The project intentionally accumulates these physical Android gates for the later project-wide physical qualification stage. ADB inspection on 2026-09-21 found only `emulator-5554`; no emulator result has been promoted to physical-device evidence. ADB inspection on 2026-09-26 during Spikes 0.4, 0.5, and 0.6 found no attached device or emulator.

## Current Blockers

No architecture blocker has been observed. Spike 0.1 has no exact desktop memory measurements and retains physical Android debt. Spike 0.2 proves controlled same-host browser connectivity only; different-NAT, carrier-network, physical Android, and TURN behavior remain unqualified. The selected host/host pair must not be generalized to Internet reachability.

Spike 0.3 proves bounded, integrity-checked binary transfer in same-host headless Chrome only. The following remain inputs to later transfer-engine design, not blockers:

- Negotiated `maxMessageSize` constrains chunk size (256 KiB payload + header exceeds Chrome's 262,144 bytes).
- Fresh associations show a multi-second throughput warm-up.
- RTCDataChannel provides no receive-side application flow control.

Spike 0.4 proves bounded OPFS storage in headless desktop Chrome only. The following remain inputs to later transfer-engine and cache design, not blockers:

- `createWritable()` commits only on `close()`, so data in a long-lived stream cannot be read back for playback until it commits.
- A `keepExistingData` resume copies the whole existing file.
- `FileSystemSyncAccessHandle` avoids both but requires a worker and holds an exclusive write lock.
- Small (64 KiB) writes carry high per-call overhead relative to 1 MiB writes.
- Quota is environment-specific, `persist()` was not granted, and eviction remains possible.

Spike 0.5 proves bounded MP4 inspection and segmentation of synthetic, non-fragmented target media in headless desktop Chrome only. The following remain inputs to later media-pipeline design, not blockers:

- MP4Box.js 2.4.1's built-in segmenter is not keyframe-aligned for random access, and its boundaries are path-dependent. Deterministic, index-derived segmentation via `createFragment()` worked, but it touches semi-internal sample fields.
- Sample-table expansion (about 343 B per sample) may exceed mobile memory budgets for long or high-frame-rate media.
- Unselected tracks must be drained.
- Already fragmented sources are not handled with bounded memory.
- MP4Box.js can stall or log to `console.error` on malformed input, so driver-side guards are required.

Independent review of Spike 0.6 reproduced two blocker-level state-management defects: a partial segment was marked appended after a seek dropped queued audio (B1), and stale asynchronous teardown could clear a newer session (B2). The second review confirmed both fixed and reproduced a third (B3): a preparation superseded by a later unbuffered seek was reported as a fatal pipeline failure, leaving the element seeking until reset. All three have targeted fixes and deterministic regressions; the independent re-review accepted them and Spike 0.6 was committed at `7bbb10f`. (The user had explicitly authorized starting Spike 0.7 before that re-review.) Its controlled desktop playback evidence remains limited to synthetic media. The following remain inputs to later buffer-manager and Progressive Watch design, not additional blockers:

- Misaligned segments fail silently (dropped frames, no error), so keyframe alignment and independent verification are required.
- A buffer manager must reprioritise unbuffered seeks. Naive sequential delivery left a far seek pending indefinitely.
- Lookahead must be capped and `QuotaExceededError` treated as backpressure. The quota is environment-specific; about 159 MB in this headless profile.
- A receiver in a never-shown tab does not open its MediaSource until the tab is shown. Hidden tabs keep playing but throttle timers; long-duration throttling was not tested.
- Chrome applies edit lists in MSE. Other browsers were not tested.
- The sample-table heap (about 71 MB for 90 minutes at 30 fps) remains the main mobile memory risk.
- A/V sync, smoothness, and real-world media were not measured.

Spike 0.7 integrated those components in controlled Chrome and found no architecture blocker. Its development runs exposed an undefined seek-handler local, a host source-reader race when rapid seeks overlapped, and duplicate receiver channel binding; all were fixed and retested. The final experimental host joins superseded cuts, and the receiver rejects stale-generation chunks and binds one channel per session. The first independent review then reproduced a scheduling blocker (B1: a persistent host cursor ignored local seeks, stalling playback permanently after mixed seeks); the fix makes host scheduling follow the receiver's contiguous playback need with generation ownership. Final independent review passed the software-feasibility closure gate. Sample-index heap, MSE/decoder memory, Android, real external networks, TURN, and non-synthetic sources remain unqualified. OPFS was not integrated; `Spike 0.7 demonstrates bounded streaming pipeline; durable cache integration remains productionization work.`

## Open Questions

- Where will production signaling be hosted?
- Will STUN/TURN be self-hosted or provided by a third party?
- What TURN bandwidth, reliability, and cost are practical for progressive media?
- What exact MP4 fragmentation strategy is interoperable across target browsers? Spike 0.6 showed that desktop Chrome 153 plays Spike 0.5 planned fragments in both muxed and separate SourceBuffer layouts. Firefox, Safari, and Android Chrome are untested.
- What startup, low-water, high-water, and lookahead thresholds and quota handling should the buffer manager use on target devices? Spike 0.6 used laboratory values only.
- How should Progressive Watch behave when the receiver tab is backgrounded or has never been shown?
- How should the host represent the sample index to bound memory on long media, and should segment identity be the Spike 0.5 deterministic plan?
- Should already fragmented source MP4s be supported, and by what bounded-memory path?
- What transport chunk size and data-channel settings perform reliably?
- How do target browsers behave when storing multi-GB media? Spike 0.4 verified entries up to 1 GiB in headless desktop Chrome only.
- Should the receive cache use per-segment OPFS entries, a worker-owned sync access handle, or a layered memory/OPFS approach?
- Is Progressive Watch feasible on Safari macOS and Safari/iOS?
- How does Firefox behave with the proposed progressive playback pipeline?
- What cache persistence and eviction strategy best balances resume behavior and privacy?
- What exact media fingerprint format provides useful matching without excessive cost?
- What topology is appropriate for a third participant?

These questions must be resolved by evidence, not by assumptions or undocumented defaults.

## Next Exact Step

Continue Phase 1 — Application Foundation with Phase 1D qualification and closure: evaluate the Phase 1 exit gate against recorded evidence. Phase 1 is not complete until its exit gate is evaluated.

`DEFERRED-PHYSICAL-001` through `DEFERRED-PHYSICAL-007` remain open and must be retained through their applicable qualification gates.

## Decisions That Must Not Be Accidentally Reverted

- Use a web-first architecture.
- Develop and stabilize two-person rooms first.
- Use host-authoritative synchronization for initial versions.
- Keep Local Sync and Progressive Watch as independent modes.
- Keep playback synchronization and file transfer as separate subsystems.
- Keep permanent server-side media storage outside the normal architecture.
- Prefer peer-to-peer media transfer.
- Initially target MP4 with H.264/AVC video and AAC audio for Progressive Watch.
- Feature-detect progressive capability at runtime.
- Add three-person support only after two-person stability.
- Require real-device Android testing; emulation is not sufficient for the relevant gates.
- Require an explicit exit gate for every phase.

Changes to these decisions require a superseding ADR and corresponding documentation updates.

## Last Updated

2026-09-28
