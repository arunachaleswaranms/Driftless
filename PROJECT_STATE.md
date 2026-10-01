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

Phase 0 — Architecture & Feasibility: **CLOSED / PASS** (software feasibility; physical qualification deferred).

Phase 1 — Application Foundation: **CLOSED / PASS**. Phase 1 exit gate: **PASS** (see [Phase 1 qualification](docs/PHASE1_QUALIFICATION.md)).

Phase 2 — Internet P2P Foundation: **IN PROGRESS**.

| Part     | Scope                              | Status                           |
| -------- | ---------------------------------- | -------------------------------- |
| Phase 2A | Protocol & signaling foundation    | **IMPLEMENTED / REVIEW PASS**    |
| Phase 2B | Room join & WebRTC negotiation     | **IMPLEMENTED / REVIEW PASS**    |
| Phase 2C | Connection lifecycle & reconnect   | **IMPLEMENTED / REVIEW PASS**    |
| Phase 2D | Diagnostics / real-network closure | **IMPLEMENTED — QUALIFICATION PENDING** |

Phase 2 exit gate: **NOT PASSED**. The Phase 2B–2D browser evidence is two browser contexts on one development machine. The real-device, real-network evaluation is recorded in [PHASE2_QUALIFICATION.md](docs/PHASE2_QUALIFICATION.md).

## Current Branch

`phase/2-internet-p2p-foundation`

Phase 0 was merged through PR #1 at `17eea6a`. Phase 1 was merged through PR #3 at `4559bf4f0692f3b491819229d3596a81c0d319be`. Phase 2 work proceeds on `phase/2-internet-p2p-foundation`, created from `main` at `4559bf4`.

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

The master planning document exists at `docs/planning/Driftless_Master_Project_Plan_v0.1.docx`. The Phase 0 experiment framework and isolated Spike 0.1 through Spike 0.7 browser experiments now exist under `spikes/phase0/`. The Spike 0.3 synthetic binary-transfer, Spike 0.4 synthetic OPFS storage, Spike 0.5 MP4 parsing/segmentation, Spike 0.6 MSE progressive-playback, and Spike 0.7 integrated P2P playback experiments are laboratory code only. Spike 0.7 adds no dependency; it imports the Spike 0.5/0.6 modules and pinned MP4Box.js. Spike 0.5 pins MP4Box.js 2.4.1 as a spike-local dependency (`spikes/phase0/spike-05-mp4-segmentation/package.json`); it is not an approved production dependency. The production web client foundation exists under `apps/web/` (see Phase 1 below). The shared protocol package exists under `packages/protocol/`, the signaling service under `services/signaling/`, and the browser room and WebRTC client under `apps/web/src/features/room/` (see Phase 2 below). The repository is a root npm workspace (`apps/*`, `packages/*`, `services/*`) with one root `package-lock.json`. Phase 2D added connection diagnostics, the runtime ICE configuration, and the TURN credential boundary (no TURN server is part of the repository). No synchronization engine, transfer engine, production cache, production transfer protocol, synchronization implementation, or Progressive Watch implementation has been initialized. `packages/sync-engine/` and `packages/transfer-engine/` remain empty.

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

**Phase status:** CLOSED / PASS. **Phase 1 exit gate:** PASS, evaluated at revision `4bf6e311723ff3c59dc47d9b3b108c9006f0d7a3`. The detailed evidence record is [PHASE1_QUALIFICATION.md](docs/PHASE1_QUALIFICATION.md). This is an application-foundation development gate, not a product support declaration: every [COMPATIBILITY.md](docs/COMPATIBILITY.md) status is unchanged, and `DEFERRED-PHYSICAL-001` through `007` remain open. The Phase 1 branch passed independent review and was merged through PR #3 at `4559bf4`.

| Part | Scope | Status |
| --- | --- | --- |
| Phase 1A | Production React/Vite/PWA foundation and automated test baseline | Implemented |
| Phase 1B | Local browser media player: file selection, playback, media metadata, errors, and lifecycle | Implemented |
| Phase 1C | Capability detection: local runtime API observations | Implemented |
| Phase 1D | Qualification and closure, including evaluation of the Phase 1 exit gate | Complete — exit gate PASS |

The web client lives under `apps/web/`. It is written from scratch; no Phase 0 spike code was copied into it.

### Phase 1A — foundation

- React 19, TypeScript 6.0, and Vite 8 as a standalone npm package with a committed lockfile. No repository-level workspace existed in Phase 1; Phase 2A later moved the package into a root npm workspace without changing any locked version (see Phase 2A below).
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

### Phase 1A–1C automated evidence (recorded at `f2de4ea`)

This is the pre-qualification record; Phase 1D below supersedes its counts and adds MP4/H.264/AAC and installed-Chrome evidence.

`AUTOMATED PASS` on macOS 26.6.2 with Node.js 26.3.0 and npm 11.16.0: 121 Vitest unit/component tests and 25 Playwright tests against the production build in Playwright's Chromium 153.0.8010.12.

- The Phase 1A smoke tests cover shell rendering, keyboard skip-link focus, narrow and desktop layout, manifest and icon delivery, service worker registration and control, the complete CSP, and zero Chromium manifest/installability errors other than the automation-only `in-incognito`.
- The Phase 1B unit/component tests cover the empty state, object URL binding, metadata, unknown durations, replacement, clear, same-file reselection, unmount, stale-event rejection, conservative errors, StrictMode and repeated-cycle URL balance, and the absence of file-content reads.
- The Phase 1B browser tests cover: metadata; playback that starts only after a trusted click and advances; pause; forward and backward seeks set through `currentTime`; keyboard play/pause; replacement and clear with URL revocation; an unplayable file; 5 rapid replace/clear cycles with every URL revoked exactly once; same-origin `GET`-only requests; and narrow and desktop fit.
- The Phase 1C unit/component tests use synthetic global scopes: fully populated, empty, and each API removed in turn, plus a throwing getter, wrong-typed values, and every `canPlayType()` answer. They verify that detection never calls the APIs it observes, gives identical reports on repeated runs without changing the scope, and that the panel uses only observation wording, including its explicit statement that API presence is not browser or product support.
- The Phase 1C browser tests compare every reported check and `canPlayType()` answer with the test browser's own globals, observed independently in the page. They also confirm the disclaimer, identical reports after a reload, and narrow and desktop fit. An instrumented load and reload recorded no peer connection, MediaSource, worker, socket, `fetch`, OPFS, persistence, permission, media-device, Cache Storage, IndexedDB, or Web Storage call and no dialog, and requests only for the application's own static files. Cache Storage, IndexedDB, OPFS, and Web Storage stayed empty from a same-origin baseline page through load and reload.
- In Chromium 153.0.8010.12 every observed API surface was present, the secure-context flag was true on `localhost`, and `canPlayType()` answered `maybe` for both `video/mp4` and `video/webm`. These are observations of one automation browser, not a compatibility result.
- Every browser test fails on any console error or warning, uncaught exception, or cross-origin request.

This is development evidence and not a compatibility claim. Playwright's Chromium reported sticky user activation at page load, and the fixtures have no audio, so the browser autoplay restriction itself was not exercised. The tests show only that the application never starts playback on its own. No physical device, other browser engine, MP4/H.264/AAC file, large file, or memory measurement was part of this evidence. `DEFERRED-PHYSICAL-001` remains open.

### Phase 1D — qualification and closure

- The exit gate was divided into five criteria, each evaluated at the committed candidate `4bf6e311723ff3c59dc47d9b3b108c9006f0d7a3`. All five pass:
  - G1, the installable web foundation;
  - G2, local media selection;
  - G3, local playback;
  - G4, accurate capability reporting;
  - G5, the automated baseline.
- Qualification found no product defect, and no product source changed. It closed qualification gaps with tests and a fixture:
  - a synthetic MP4/H.264 High/AAC-LC fixture (185,070 B, 8 s, 320 × 180, `moov` first), with its generator and provenance;
  - two full-lifecycle browser tests, WebM→MP4 and MP4→WebM. They check decoded frames, pause, forward and backward seeks with continued playback, decoded audio, replacement during playback, clear, reselection, object URL ownership, 0 script `play()` calls, requests, and storage;
  - the MP4 fixture in the rapid-replacement test;
  - a PNG IHDR check of icon dimensions, and a check that the manifest `id`, `start_url`, and `scope` resolve to the application root;
  - a test that the controlling service worker serves nothing and caches nothing;
  - an opt-in Playwright project, `DRIFTLESS_E2E_CHROME=1`, that runs the suite in the installed Google Chrome.
- Mutation checks confirmed that the new tests fail when the app calls `play()`, revokes its current URL prematurely, or gains a service worker fetch handler or install-time cache.
- `AUTOMATED DESKTOP / DEVELOPMENT BROWSER` results on macOS 26.6.2 with Node.js 26.3.0 and npm 11.16.0, from `npm ci` at the qualification revision:
  - `npm run check`: typecheck, lint, format, and build pass, and Vitest has 121 passed, 0 failed, 0 skipped;
  - `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities;
  - three consecutive `npm run test:e2e -- --retries=0` runs: 29/29 passed in Playwright Chromium 153.0.8010.12;
  - two `DRIFTLESS_E2E_CHROME=1` runs: 58/58 passed, adding Google Chrome 154.0.8037.58;
  - 0 flaky tests, 0 console messages or page errors, and no leaked preview server.
- Microsoft Edge is not installed here and was `NOT EXERCISED IN THIS ENVIRONMENT`. Firefox and Safari were not exercised, and no non-Chromium engine, physical device, or real network was part of this evidence.
- No runtime or development dependency changed; `package.json` gained only the `test-media:mp4` script. No CI workflow was added. CI readiness and the unverified Linux-runner behavior are recorded as a follow-up in the qualification record.

## Phase 2 — Internet P2P Foundation

**Phase status:** IN PROGRESS. **Phase 2 exit gate:** NOT PASSED — "Two real devices on different networks establish and recover an authenticated WebRTC data-channel session. Evidence records whether the selected path is direct P2P or TURN relay." Phase 2A does not evaluate it.

### Phase 2A — Protocol & Signaling Foundation (IMPLEMENTED / REVIEWED)

Implemented on `phase/2-internet-p2p-foundation` at `810af89` and passed independent GitHub review. The review recorded two non-blocking notes, both resolved in Phase 2B: NB-01, the shared parser's preliminary size check used string length rather than UTF-8 bytes; and NB-02, the timing flakiness of a local-player lifecycle test under host load, described below. The description below is the Phase 2A record; Phase 2B changed the message bound and the rate limit.

- **Workspace.** A root npm workspace now spans `packages/*`, `services/*`, and `apps/*`. The Phase 1 lockfile moved to the root as the single `package-lock.json`: all 253 previously locked packages kept their exact versions, and the web production build is byte-identical to one built from `main`. `apps/web/package-lock.json` is gone, and the unchanged Prettier configuration moved to the root. Every `apps/web` script is unchanged. Root scripts: `npm run check` (protocol, signaling, and web checks), `npm run test`, `npm run test:e2e`, `npm run build`, `npm run verify`. The Phase 1 qualification remains the record for its standalone revision `4bf6e31`.
- **`packages/protocol/` (`@driftless/protocol`).** A transport-neutral TypeScript contract with no runtime dependency:
  - the versioned envelope `{ protocolVersion: 1, type, sequence, sentAt, payload }`, with exact fields at every level;
  - client messages `ROOM_CREATE`, `ROOM_JOIN`, `ROOM_LEAVE`;
  - server messages `ROOM_CREATED`, `ROOM_JOINED`, `ROOM_LEFT`, `ROOM_PARTICIPANT_JOINED`, `ROOM_PARTICIPANT_LEFT`, `ROOM_CLOSED`, `ERROR`;
  - canonical base64url identifiers: room ID 16 bytes, invite secret 32 bytes, participant ID 12 bytes;
  - error codes `INVALID_MESSAGE`, `UNSUPPORTED_PROTOCOL`, `INVALID_STATE`, `ROOM_UNAVAILABLE`, `ROOM_FULL`, `RATE_LIMITED`, `SERVER_ERROR`;
  - hand-written parsers that never throw and return typed results or fixed reason tokens. Unknown versions fail closed as `UNSUPPORTED_PROTOCOL`.

  `ROOM_LEFT` was added to confirm an intentional leave. See [PROTOCOL.md](docs/PROTOCOL.md).

- **`services/signaling/` (`@driftless/signaling`).** Node's HTTP server plus `ws` 8.22.0: `GET /healthz` returns only `{"status":"ok"}`, and the WebSocket endpoint is `/v1/signaling`. The transport, protocol parser, connection controller, and room store are separate layers; the room store never sees a socket.
  - Rooms are in memory only and lost on restart.
  - The creator becomes host and receives a room ID and a separate 256-bit invite secret from `crypto.randomBytes`. Only a SHA-256 digest of the secret is retained, and it is compared in constant time.
  - A missing room, an expired room, and a wrong secret all return `ROOM_UNAVAILABLE`; `ROOM_FULL` is revealed only after a correct secret. A third participant is never admitted, and one connection belongs to at most one room.
  - If the guest leaves or disconnects, the host is notified and the room stays open. If the host leaves or disconnects, the room closes and the guest is notified; the guest is never promoted.
  - Rooms expire at a configurable lifetime (60 s–24 h, provisional default one hour) through one periodic sweep, and joins are refused at expiry before the sweep runs.
  - Bounds and policy: 4096-byte messages; binary messages refused; per-connection token bucket (burst 20, 5 per second); 5 invalid messages per connection; strictly increasing client sequences; 256 connections; exact-match origin policy with development defaults for the local Vite origins and a required https list in production; no query strings on the upgrade URL; default bind `127.0.0.1`.
  - Logging is a closed set of structured events with no secrets, identifiers, payloads, URLs, headers, or IP addresses.
  - Environment configuration is validated and never silently replaced by defaults.
  - Plain `ws://` is a development-only exception; production requires HTTPS/WSS through TLS termination.
- **Web client.** No application source changed. The browser app does not connect to signaling. Only workspace tooling and documentation were adjusted.
- **Not implemented:** WebRTC (`RTCPeerConnection`, offer/answer, ICE), STUN, TURN, `RTCDataChannel`, room UI, reconnect or session resumption, heartbeat and idle timeouts, Local Sync, playback synchronization, transfer, and any real-network evidence. A dropped connection loses its membership; Phase 2C owns reconnect.
- **New dependencies:** runtime `ws` 8.22.0 (signaling); development `@types/ws` 8.18.x. The new packages otherwise reuse the web package's existing development tools and versions.

**Phase 2A automated evidence.** `AUTOMATED PASS` on macOS 26.6.2 with Node.js 26.3.0 and npm 11.16.0, from `npm ci` at the root. These are Node and loopback results, not browser, device, WebRTC, or network evidence.

- `@driftless/protocol`: 62 Vitest tests passed (53 parser, 9 identifier), plus a smoke test importing the built package through its `exports` map.
- `@driftless/signaling`: 96 Vitest tests passed (20 room store, 27 controller, 28 real-server integration, 10 configuration, 6 credential, 5 rate limiter), plus a smoke test running the built `dist/main.js` as a child process.
- `@driftless/web`: typecheck, lint, format, 121 Vitest tests, and build pass. The production bundle is byte-identical to one built from `main`.
- Playwright Chromium, full suite: most runs passed 29/29, including four runs of this branch alternated with four runs of a `main` worktree, where all eight passed 29/29. The two full-lifecycle tests also passed 20/20 when repeated alone.
- Two full-suite runs of this branch each had one failure in the same test, "runs the full lifecycle from video/mp4 to video/webm". Both times, playback had not passed 1 s within the 5 s poll after the first trusted click (it reached 0 s and 0.15 s). Both happened while other applications on the machine kept the load average between 10 and 21.
- Because the bundle is identical and `main` ran the same suite, this is recorded as an intermittent timing failure under host load, not a regression. Phase 2B hardened the test (NB-02, below).
- `npm audit`: 0 vulnerabilities.

### Phase 2B — Room Join & WebRTC Negotiation (IMPLEMENTED / REVIEW PASS)

Implemented on `phase/2-internet-p2p-foundation` at `5d25fea` on top of the reviewed Phase 2A commit, and passed independent GitHub review. The description below is the Phase 2B record; Phase 2C deliberately changed its no-recovery behavior and extended its handshake (see Phase 2C below).

- **Phase 2A review notes.**
  - NB-01: the shared parser now enforces its bound in UTF-8 bytes. `fitsUtf8Bytes` and `utf8ByteLength` in `packages/protocol/src/encoding.ts` count bytes from UTF-16 code units with pure arithmetic, exactly as `TextEncoder` and `WebSocket.send()` encode, including lone surrogates as U+FFFD; no `Buffer` or `TextEncoder` is used in the package. The service's `ws` `maxPayload` and the parser use the same constant. Tests compare the count with `TextEncoder` for every code unit and random strings, and show that 2-, 3-, and 4-byte text whose string length fits but whose bytes do not is rejected, both by the parser and over a real socket.
  - NB-02: the local-player tests now wait, after the trusted click, for the element's own `playing` event and then poll until `currentTime` passes the unchanged thresholds (more than 1 s in the lifecycle tests) and new frames have been decoded. Only the polling bound changed, from the 5 s default to 30 s, with the reason recorded in the test: under load averages of 10–21 playback had advanced only 0–0.15 s within 5 s. The waits remain event- and state-driven, with no fixed sleeps, retries, or skips. The two full-lifecycle tests then passed 40/40 (20 each) with retries disabled, and the full suite passed in every run below.
- **Protocol.** A negotiation ID (18 random bytes, 24 base64url characters; 18 rather than 16 bytes keeps every identifier a distinct length). `RTC_OFFER` and `RTC_ANSWER` `{ negotiationId, sdp }`, `ICE_CANDIDATE` `{ negotiationId, candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } }`, and `ICE_COMPLETE` `{ negotiationId }`, valid in both directions and naming no destination or role. Peer handshake `PEER_HELLO` and `PEER_READY` `{ negotiationId, senderId, recipientId }` on the data channel. Provisional bounds: signaling message 32,768 B, SDP 16,384 B, candidate 1024 B, `sdpMid` 64 B, m-line index 0–63, username fragment 256 B, 32 candidates per participant per negotiation, peer message 1024 B. Chromium negotiation in the browser tests produced descriptions of about 715 B and two candidates per peer.
- **Signaling.** The room store decides negotiation legality and the recipient from membership: only the host offers, only the guest answers once, one negotiation per guest, a second offer or the room's most recent ID is refused, every message must name the active negotiation, the guest trickles only after answering, and candidate counts and completion are bounded per participant. A guest's departure discards the negotiation. The controller relays a rebuilt copy of the validated payload to the peer only, and refuses a message whose relay could exceed the bound. Only counters and flags are kept; no SDP or candidate is stored, parsed, or logged. The rate limit is now burst 48, 10 per second, which admits one whole negotiation burst and still closes a flood. One new log event, `negotiation_relayed`, carries a fixed step token.
- **Browser.** `apps/web/src/features/room/`: `RoomPanel` (React) over `RoomController`, which owns `SignalingClient` (WebSocket) and `PeerSession` (`RTCPeerConnection`).
  - Signaling uses the page's own origin: `wss` on `https`, `ws` only on loopback; the URL carries no credential. The development and preview servers forward `/v1/signaling` to a loopback service. The CSP is unchanged.
  - Every server message is parsed with the shared parser; invalid or out-of-sequence messages close the connection. Client sequences increase across rooms on one socket.
  - The host creates one ordered, reliable channel, `driftless-control`, and offers; the guest answers and accepts only that channel. ICE trickles both ways as validated plain objects; early remote candidates wait in a queue of at most 32 and 16 KiB.
  - The UI shows "Peer data channel is connected." only after the handshake has crossed the channel in both directions.
  - STUN: none by default; `VITE_RTC_STUN_URLS` accepts up to four validated `stun:`/`stuns:` URLs. No TURN.
  - No media: no `getUserMedia`, `getDisplayMedia`, `addTrack`, or `addTransceiver`.
  - The invite secret is in memory only while its room exists, masked until revealed, copied on request, and never stored, logged, or placed in a URL.
  - Stale events are rejected by session identity and negotiation ID, so a late event from an earlier room, guest, or negotiation cannot change the current one.
  - On peer failure the session is torn down and the user decides whether to leave; nothing is retried. When signaling closes, the peer session is torn down too. No reconnect, ICE restart, or renegotiation.
- **Placement.** The room panel sits below the Phase 1 local player and capability report, spanning the full width, so the Phase 1 layout and keyboard order are unchanged.
- **Dependencies.** No new external package. `@driftless/web` gained the workspace dependency `@driftless/protocol`; its `dev` script now builds the protocol package first.

**Phase 2B automated evidence.** `AUTOMATED PASS` on macOS 26.6.2 with Node.js 26.3.0 and npm 11.16.0, from `npm ci` at the root. The browser results are `AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE`: separate browser contexts in one browser on one machine, a loopback signaling service, and no ICE server. They are not real-network, NAT-traversal, TURN, Android, or compatibility evidence, and no selected ICE path is claimed.

- `npm run check`: typecheck, lint, format, tests, builds, and both smoke tests pass. `@driftless/protocol` 153 Vitest tests; `@driftless/signaling` 125 Vitest tests; `@driftless/web` 225 Vitest tests. 0 failed, 0 skipped.
- Playwright, retries disabled, Playwright Chromium 153.0.8010.12: three consecutive full runs passed 37/37 (the 29 Phase 1 tests and 8 room tests), 0 flaky, 0 skipped.
- The room happy path passed 10/10 when repeated alone, and the whole room file 24/24 when repeated three times. The two local-player full-lifecycle tests passed 40/40.
- `DRIFTLESS_E2E_CHROME=1`: 74/74, adding Google Chrome 154.0.8037.92.
- Each room run started its own signaling service and preview server and stopped both: nothing remained listening on ports 8790 or 4173 afterwards.
- The room tests observed one peer connection per side, `connected`, with no senders, receivers, or transceivers; exactly one open `driftless-control` channel, ordered, with no retransmit or lifetime limit; `PEER_HELLO` and `PEER_READY` sent and received by both peers for the same negotiation; and, after leave, a closed connection and channel. They also observed no media call, no CSP violation, only same-origin static requests and one same-origin socket, no room data in the URL or storage, and no console warning or error.
- `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities.

### Phase 2C — Connection Lifecycle & Reconnect (IMPLEMENTED / REVIEW PASS)

Implemented on `phase/2-internet-p2p-foundation` on top of the reviewed Phase 2B commit `5d25fea`, at `e1cf99a` with the terminal-leave fix at `df21cad`, and passed independent GitHub review. A current two-person room recovers, within bounds, from signaling loss, a brief signaling network interruption, peer data-channel failure, a guest's or host's signaling loss, and both at once.

- **Session identity.** Each room has a non-secret session ID (20 bytes from `crypto.randomBytes`, 27 base64url characters) generated by the service with the room, immutable, returned to both participants, preserved across resume, and invalid once the room ends. `PEER_HELLO` and `PEER_READY` now carry it, so the handshake is bound to session, negotiation, sender, and recipient, and a message from another session, an earlier room incarnation, another participant, or another negotiation fails closed.
- **Resume credential.** Each participant receives its own 264-bit resume secret, once, at admission; it is not the invite secret, is never shared with the other participant, and authorizes only resuming its own membership. The service keeps only `SHA-256(secret)`; the browser keeps the secret in the room controller's private memory only — never in rendered state, the page, a URL, storage, or a log — so a page reload cannot resume a room.
- **Challenge-response resume.** `SESSION_RESUME_BEGIN { sessionId, participantId }` → `SESSION_RESUME_CHALLENGE { challenge }` (192 bits, bound to the connection, single use, 10-second TTL, issued identically for any session) → `SESSION_RESUME_PROVE { challenge, proof }` with `proof = HMAC-SHA-256(SHA-256(secret), 76-byte canonical input)` binding a domain separator, the session ID, the participant ID, and the challenge → `SESSION_RESUMED` with an authoritative snapshot (session, room, participant, role, expiry, the peer's presence, the active negotiation ID, and the negotiation count). The secret is never resent. Verification is constant-time; every refusal is one recoverable `SESSION_UNAVAILABLE`. Web Crypto in the browser and Node's crypto in the service; a fixed vector computed independently in Python checks both.
- **Stable membership.** The room store separates stable participants (identity, role, resume key) from their current connection binding; at most one live binding exists, and a resume never takes over a live connection. A new connection starts its own sequence space; only the accepted proof authorizes it, and nothing from the old connection is replayed or accepted.
- **Connection endings.** An ordinary transport loss (including a missed WebSocket protocol ping, provisional 15-second interval) holds the membership for a reconnect grace period (provisional 30 s, configurable 5–120 s): the guest keeps its slot and the host its room, nobody is promoted, and the other member receives `ROOM_PARTICIPANT_CONNECTION` `RECONNECTING`, then `CONNECTED`. At the deadline a guest is removed (`RECONNECT_TIMEOUT`) and a host's room closes (`HOST_RECONNECT_TIMEOUT`, invite invalid). Room expiry overrides grace. `ROOM_LEAVE`, a client close with 1000, 1001, or 1002, and every policy or protocol closure end the membership at once and are never resumable; a browser abandoning a resume attempt closes with 4000, which stays resumable.
- **No offline queue.** Every negotiation or recovery message towards a reconnecting participant is refused; recovery after resume is snapshot reconciliation, never replay.
- **Browser reconnect.** On signaling loss the room controller keeps a connected peer session, abandons an unfinished negotiation, and resumes on a fixed, finite schedule: immediately, then 250 ms, 500 ms, 1 s, 2 s, 4 s, 4 s, 4 s (8 attempts), each abandoned after 5 s. Exactly one schedule exists; all timers are injected and cancelled on leave, room end, success, and shutdown. After `SESSION_RESUMED` it checks that the snapshot names its exact membership and reconciles: it keeps a peer session only if connected and on the active negotiation, closes any other, and starts or requests a fresh negotiation. When every attempt fails (for example after a service restart) the room ends and the peer session is closed. These values are provisional, not tuned for mobile networks.
- **Peer recovery.** A failed peer session is replaced, never repaired: no `restartIce()`. The guest sends `RTC_RECOVERY_REQUEST { negotiationId }`; the host sends `RTC_RECOVER { previousNegotiationId, negotiationId, sdp }` with a fresh `RTCPeerConnection`, negotiation ID, `driftless-control` channel, and handshake. The service accepts a recovery only from the host, naming the exact active negotiation, with an ID never used by that guest membership, and replaces the negotiation atomically; the old negotiation's answers and ICE are refused. One guest request is accepted per negotiation. A guest membership uses at most `MAX_NEGOTIATIONS_PER_MEMBERSHIP` = 4 negotiations (first plus three recoveries, provisional); then recovery stops in a failed state and the user can leave. The host recovers unprompted one second after its own session fails unless the guest's request or departure arrives first (`HOST_RECOVERY_DELAY_MS`, provisional): browser testing showed that a guest's intentional leave closes the data channel and can reach the host before the service's notice, which otherwise started a pointless recovery negotiation.
- **Handshake timing (Phase 2B behavior changed).** The host now sends `PEER_HELLO` first, when its channel opens; the guest sends its `PEER_HELLO` and `PEER_READY` only in reply. Repeated Phase 2C browser runs found a rare same-host Chromium failure in the initial Phase 2B handshake: the guest's greeting, sent as soon as its announced channel was open, was never delivered to the host's channel, while its later `PEER_READY` was, so both sides waited at "Connecting…" with transport and channels up. With the old timing it occurred in 3 of 140 serial runs of the recovery test (each run has an initial and a recovery handshake); after the fix, in 0 of 160. The message set and validation are unchanged.
- **Implementation hardening.** Pre-commit review of the implementation found and fixed: an abandoned resume attempt closed with 1000, which ended a membership the service had just resumed (now 4000, resumable); a host offer that failed before leaving the browser still became the host's idea of the active negotiation, so its next recovery offer named a negotiation the service never saw and was silently refused, leaving both sides waiting (the active ID is now rolled back; the attempt still counts against the bound); and a client protocol-error close (1002) was held for the grace period (now terminal). Each has a regression test.
- **Known limitation.** A silently dead network path is noticed by the service only when a ping goes unanswered (up to two 15-second intervals), and resume is refused until then, so the browser's roughly 16-second retry schedule can give up first, for example after a network switch; the browser has no liveness check of its own. Choosing these values needs real-network evidence and belongs to Phase 2D.
- **Leaving while reconnecting.** Leave room while signaling is reconnecting is an authoritative, bounded terminal leave rather than a local one. The peer connection closes at once and the UI shows "Leaving the room…". The reconnect schedule's purpose changes from resume to leave (an attempt in flight continues under the new purpose): on `SESSION_RESUMED` the browser sends `ROOM_LEAVE` immediately, with no reconciliation or negotiation, then discards the credentials on `ROOM_LEFT`. The service therefore frees a guest's slot, or closes a host's room and invalidates its invite, at once. The leave schedule is finite (immediately, 250 ms, 500 ms, 1 s, 2 s; each attempt bounded by the 5-second attempt timeout, which also bounds the wait for `ROOM_LEFT`; provisional); `SESSION_UNAVAILABLE` completes the leave. If the service cannot be reached throughout, the browser leaves locally and discards the credentials, and the membership — a held guest slot, or a host's room and invite — stays valid on the service until the reconnect grace period or room lifetime ends. The first Phase 2C implementation left locally only in this case, which let a host's room and invite outlive the host's "You left the room." No protocol or service change was needed.
- **Interface.** The state model keeps membership, own signaling, the peer's signaling presence, and the peer transport independent. The polite status line states, for example, "Peer data channel connected. Signaling is reconnecting…", "The other participant is reconnecting…", "Peer connection lost. Recovering…", "Connection restored.", and "The room session could not be recovered."; it never says fully connected while signaling is unavailable and announces no retries. **Leave room** remains usable while reconnecting. No secret, challenge, proof, retry count, timer, or raw error is shown.
- **Logging.** New fixed events `participant_disconnected`, `resume_challenge_issued`, `participant_resumed`, `resume_rejected`, `reconnect_timeout`, negotiation steps `recover` and `recovery_request`, and the transport detail `liveness_timeout`; no secret, key, proof, challenge, or identifier is logged.
- **Bounds.** At most 256 rooms held at once (including rooms whose host is reconnecting), one resume key per participant, one pending challenge per connection, at most four used negotiation IDs per membership, one sweep and one liveness timer in the service, and one resume schedule per room session in the browser.
- **Not implemented in Phase 2C** (Phase 2D added TURN credentials and `getStats` diagnostics): `restartIce()`, recovery across page reload or service restart, real-network or physical-device qualification, Local Sync, playback synchronization, media transfer, and Progressive Watch.
- **Dependencies.** None added or changed. Web Crypto, Node's crypto, and the existing `ws` are used.

**Phase 2C automated evidence.** `AUTOMATED PASS` on macOS 26.6.2 with Node.js 26.3.0 and npm 11.16.0, from `npm ci` at the root. Browser results are `AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE`: separate browser contexts in one browser on one machine, a loopback signaling service, real WebSockets and WebRTC objects, and no ICE server. A lost signaling connection is the application's real socket closed from the page with an application close code; a network outage is Chromium's offline emulation, which in these browsers blocked new sockets and left the open data channel working. None of this is real-network, NAT-recovery, Internet-reconnect, carrier or mobile, TURN, Android, or compatibility evidence.

- `npm run check`: typecheck, lint, format, tests, builds, and both smoke tests pass (the signaling smoke test now includes a resume round trip). `@driftless/protocol` 217 Vitest tests; `@driftless/signaling` 185; `@driftless/web` 280. 0 failed, 0 skipped.
- Playwright, retries disabled, Playwright Chromium 153.0.8010.12: three consecutive full runs passed 46/46 (29 Phase 1, 8 room, 9 reconnect), 0 flaky, 0 skipped. `DRIFTLESS_E2E_CHROME=1`: 92/92, adding Google Chrome 154.0.8037.92.
- Targeted, one worker, retries disabled, on the final tree: the peer data-channel recovery happy path passed 10/10 consecutive runs, each in a fresh room with a fresh peer connection, negotiation ID, and channel (and 140/140 more while verifying the handshake fix); the ten-reconnect-cycle test passed 3/3 (30 cycles); the room and reconnect files together passed 45/45 over three repeats (before the two leave tests were added). For the terminal leave: the guest and host leave-while-reconnecting tests, signaling reconnect, peer recovery, and the combined outage passed 50/50 (ten serial repeats each), and the connected-leave room tests 15/15 (five each).
- The terminal-leave tests observed, on the leave socket, `SESSION_RESUME_BEGIN`, `SESSION_RESUME_PROVE`, and `ROOM_LEAVE` only, `ROOM_LEFT` last, no frame carrying the resume secret, every socket closed, the peer connection closed from the moment Leave was clicked, "Leaving the room…" followed only by "You left the room.", the other participant seeing the intentional departure at once, a new guest connecting with the old invite (guest case) or the old invite refused (host case), and nothing in the page, URL, or storage. One repeat showed the expected race of a guest's recovery request relayed to the host's leave connection before its `ROOM_LEAVE` took effect; it was ignored. Both tests fail against the earlier local-only leave.
- The reconnect tests observed: the same session ID, participant ID, and role in every `ROOM_CREATED`/`ROOM_JOINED` and `SESSION_RESUMED`; BEGIN → CHALLENGE → PROVE → RESUMED on every resumed socket and no frame after admission containing the resume secret; the original `RTCDataChannel` open throughout signaling recovery with no new peer connection or negotiation; ten consecutive reconnects in one room with one live socket per side; a fresh peer connection, negotiation, channel, and handshake carrying data both ways after channel failure, alone and combined with a signaling outage; three recoveries then a safe failed state with Leave working; no media calls, senders, receivers, or transceivers; no CSP violation; and empty Web Storage, IndexedDB, OPFS, and Cache Storage with one navigation.
- The only console errors were Chromium's own `ERR_INTERNET_DISCONNECTED` messages for attempts refused during the emulated outage, accepted by exact pattern in the two outage tests only; every other test fails on any console error or warning.
- Development runs found and fixed two defects: the leave race and the handshake timing race above. The first run of the new reconnect file also had one failure of the guest-outage test whose output was not captured; every reconnect test begins with an initial handshake, so it may have been the handshake race, but that is not established. The test did not fail in any later run.
- Each run started and stopped its own signaling service and preview server; nothing remained listening on ports 8790 or 4173.
- Mutation checks confirmed that the browser reconnect tests fail when a working data channel is dropped on signaling loss, the negotiation bound is ignored, any recovery offer is accepted, a mismatched session is kept, the schedule never ends, or a resume sends an extra message; one surviving mutation exposed a gap (a recovery request lost while the host was away was never repeated), which was fixed and given a test.
- `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities.

### Phase 2D — Diagnostics / Real-Network Closure (IMPLEMENTED — QUALIFICATION PENDING)

Implemented on `phase/2-internet-p2p-foundation` on top of the reviewed Phase 2C commit `df21cad`. The real-device, real-network evaluation and the Phase 2 gate decision are recorded in [PHASE2_QUALIFICATION.md](docs/PHASE2_QUALIFICATION.md).

- **Connection diagnostics.** `apps/web/src/features/room/connectionStats.ts` classifies the selected ICE path from `RTCPeerConnection.getStats()`: `transport.selectedCandidatePairId` → the candidate pair (which must have `state: "succeeded"`) → its local and remote candidates' `candidateType`. `TURN_RELAY` is a relay candidate on either side; `DIRECT` is a known pair with neither relayed (host, srflx, prflx — not necessarily one network); everything less certain, including no or conflicting selected pairs, a missing or unfamiliar candidate, a pair that has not succeeded, and failed statistics, is `UNKNOWN` with a fixed reason. A single pair marked `selected: true` is used only when no transport names a pair. Only candidate types and transport/relay protocols are read into the result; no address, port, candidate string, URL, SDP, ICE username fragment, fingerprint, or identifier.
- **Diagnostics lifecycle.** The room controller reads statistics once when a peer connection becomes connected (including every recovered one) and on **Refresh diagnostics**; there is no polling and no timer. A replaced or closed connection's snapshot is discarded at once and a late read of it is dropped, so diagnostics always describe the current connection. Diagnostics are observational: a failure leaves the path `UNKNOWN`; nothing renegotiates, restarts ICE, changes policy, or recovers because of them. They have their own subscription, so room-state subscribers see exactly the Phase 2C notifications. Nothing is sent anywhere, persisted, or logged.
- **Interface.** A collapsed **Connection diagnostics** section in the room shows signaling, peer-connection, ICE, and data-channel states; the path; candidate types; transport and relay protocol; the negotiation count of four; TURN availability; the ICE policy; and the build revision (`DRIFTLESS_BUILD_REVISION`). **Copy diagnostics** copies the same safe fields as text. No compatibility or support badge is shown.
- **Runtime ICE configuration and TURN credentials.** New protocol messages `RTC_CONFIG_REQUEST {}` and `RTC_CONFIG { expiresAt, iceServers }` with exact, bounded entries (at most 4 entries of at most 4 `stun:`/`stuns:`/`turn:`/`turns:` URLs, credentials exactly on TURN entries, 128-byte username and credential, lifetime at most one day). The service answers only a connection that carries a room membership, only on that connection, at most 8 times per connection; a connection in no room or still resuming is refused. TURN credentials use the TURN REST shared-secret scheme ([ADR-0007](docs/adr/0007-ephemeral-turn-credentials.md)): `"<expiry>:<HMAC-derived per-participant label>"` and `base64(HMAC-SHA1(secret, username))`, valid for `SIGNALING_TURN_CREDENTIAL_TTL_SECONDS` (default 3600 s, 60–86400) and never past the room. The secret comes from `SIGNALING_TURN_SECRET_FILE` or `SIGNALING_TURN_SECRET`; it is never logged or echoed. The browser requests the configuration once after admission, waits at most 3 s for it before a peer connection (then connects without TURN), refetches within 60 s of expiry, keeps it in memory only, and forgets it with the room. No TURN credential is ever in the build, the room state, the diagnostics, the export, or a log.
- **ICE policy.** `all` normally. `VITE_RTC_ICE_TRANSPORT_POLICY=relay` is a qualification-only build setting; without TURN such a session fails at once with `relay_unavailable` and recovery stops at the negotiation bound.
- **Deployment boundary.** [DEPLOYMENT.md](docs/DEPLOYMENT.md): same-origin HTTPS/WSS through a TLS reverse proxy, loopback-bound signaling, production origin list, secret files, security response headers, a coturn configuration with `use-auth-secret`, quotas, and denied private peer ranges, relay qualification builds on a separate origin, and the smoke test. No deployment target, domain, certificate, or TURN service is part of the repository.
- **Dependencies.** None added or changed. Node's crypto derives credentials; the browser uses the platform `getStats()`.

**Phase 2D automated evidence.** `AUTOMATED PASS` on macOS 26.6.2 with Node.js 26.3.0 and npm 11.16.0. Browser results are `AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE`: separate browser contexts in one browser on one machine, a loopback signaling service with no STUN or TURN configured, and real `RTCPeerConnection` objects. The exact commit, full verification counts, and the real-network results are in [PHASE2_QUALIFICATION.md](docs/PHASE2_QUALIFICATION.md).

- `@driftless/protocol` 234 Vitest tests (17 new); `@driftless/signaling` 206 (21 new); `@driftless/web` 329 (49 new). Playwright: 50 tests (4 new diagnostics tests).
- Supplemental, not real-network evidence: a loopback TURN server (pion/turn v4.1.4 with its TURN REST shared-secret handler, run from a scratch directory, not part of the repository) accepted the service-issued credentials; a relay-only build connected two Chromium contexts with both diagnostics reporting `TURN relay` (relay/relay, UDP), a normal build with TURN offered selected a direct srflx/prflx pair, and a credential from a mismatched secret did not connect. Same machine, same loopback interface.

## Open Deferred Qualification

- Physical Android and real external-network qualification remain open under the debt list below. No deferred debt was closed by the software review or PR merge. Phase 2A's Node loopback tests and Phase 2B's and 2C's same-host browser tests do not satisfy `DEFERRED-PHYSICAL-002`.

## Not Started

- Later phases: synchronization, media transfer, and Progressive Watch. Physical and real-network qualification remains deferred.

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
- Will STUN/TURN be self-hosted or provided by a third party? ADR-0007 adopts a provider-neutral credential scheme and recommends self-hosted coturn; no host or provider has been chosen.
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

Real-device, real-network qualification of the committed Phase 2D candidate, recorded in [PHASE2_QUALIFICATION.md](docs/PHASE2_QUALIFICATION.md). Do not begin Phase 3.

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

2026-10-01
