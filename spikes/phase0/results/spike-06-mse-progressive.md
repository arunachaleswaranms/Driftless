# Spike 0.6 Result — MSE Progressive Playback

## Spike

`0.6 — MSE Progressive Playback`

## Result

`PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`

Final software status: Spike 0.6 **passed independent re-review and was committed at `7bbb10f`** (`test: validate MSE progressive playback`). Physical Android qualification remains open as `DEFERRED-PHYSICAL-006`, and real-world media coverage remains `MANUAL TEST REQUIRED`.

Review history, retained: the initial controlled-desktop provisional result below was challenged by independent review. The first independent review reproduced two blocker-level state-management defects (B1, B2) and returned `REQUEST CHANGES — DO NOT COMMIT`. The second independent review confirmed B1 and B2 fixed but reproduced a third blocker (B3) and again returned `REQUEST CHANGES — DO NOT COMMIT`. The final independent re-review accepted the B1, B2, and B3 fixes, after which the spike was committed. The defects and corrective evidence are retained in [Independent Review Fixes](#independent-review-fixes). This record was committed while it still read `READY FOR INDEPENDENT RE-REVIEW`; the status above was corrected afterwards, during Spike 0.7 closure documentation.

Software feasibility of progressive MSE playback passed in controlled desktop testing. In Chrome 153, local MP4/H.264/AAC media was prepared with the Spike 0.5 deterministic plan and appended to MSE one keyframe-aligned segment at a time, paced by a deterministic arrival simulator. With it:

- **Early start.** Playback started after 2 of 76 segments (110.5 MB file). On the 4.53 GB, 90-minute file it started after 2 of 2,700 segments, when 0.31 % of the file had been read.
- **Continued supply.** Playback continued while later segments were released over time.
- **Buffering.** The buffer grew ahead of playback under fast delivery, and playback stalled and recovered under slow delivery.
- **Seeking.** Seeks inside and outside the buffered range worked. Seeks outside it needed no SourceBuffer reset.
- **End and cleanup.** Media reached a normal `ended` state after `endOfStream()`, and every reset, replace, failure, and page-unload path released everything the pipeline owned.

No architecture change was required by the three state-management fixes.

The result is provisional for these reasons:

- MSE-13 (physical Android Chrome) has no evidence (`DEFERRED-PHYSICAL-006`).
- All media was synthetic (Spike 0.5 FFmpeg test sources); real-world media is `MANUAL TEST REQUIRED`.
- Evidence comes from automated Chrome on one macOS host, mostly headless. There was one headed smoke run, and no other browser was tested.
- Audio was muted at the browser level (`--mute-audio`). Audio/video synchronization and perceived smoothness were not measured and need manual observation. Chrome's `droppedVideoFrames` counter was unusable in this environment, for MSE and native playback alike. See [Browser Playback Evidence](#browser-playback-evidence).

## Independent Review Fixes

### First independent review — B1 and B2

Independent review returned `REQUEST CHANGES — DO NOT COMMIT` after reproducing two blocker-level defects in actual Chrome. The original findings remain part of this record.

- **B1 — incomplete segment after seek.** A seek could discard queued audio while video was in flight. The old completion fallback treated a missing remaining-parts entry as a final part and marked the video-only segment appended. A later seek into that segment could remain in `seeking` while subsequent delivery continued. Each delivery now has an explicit attempt ID and a set of required track parts. Dropping any queued part abandons that attempt; only successful completions carrying the current attempt ID can mark the segment appended. An abandoned segment is immediately eligible for a complete new delivery. Delivery waits while the unbuffered target is in flight, bounding following-segment release.
- **B2 — stale teardown after replacement.** An asynchronous reset could finish after a new load became current and clear the new controller session. Load and reset now use a serialized controller operation chain. Teardown, refusal, failure, media callbacks, append completions, and asynchronous load continuations check their owning session before changing controller state. Source-open and source-close wait listeners and timeouts are tracked by the owning session and released on event, timeout, abort, or teardown.
- **Deterministic regressions.** `pipeline-races.test.mjs` uses real Spike 0.5 preparation with controlled fake SourceBuffer completion. B1 holds video in flight, drops queued audio, completes stale video, retries, and requires both fresh parts before `APPENDED` and seek completion. `RESET-RACE-01` holds A's source closure while B is queued; `RESET-RACE-02` fires A's old failure callback after B is active; `RESET-RACE-03` queues load/reset/load/reset and verifies closed MediaSources and no live resources. These assertions would fail on the reviewed implementation: the old missing-parts fallback promotes B1, while un-serialized lifecycle operations and stale global writes break B2.
- **Automated validation.** All 77 Phase 0 tests pass, including all 30 Spike 0.6 tests. JavaScript syntax checks and `git diff --check` pass.

### Browser stress after the B1/B2 fixes

`AUTOMATED DESKTOP`, Google Chrome 153.0.8010.53 in throwaway headless profiles, synthetic local MP4, browser audio muted. The independent review's temporary CDP harness was rerun against the patched page; its files remain outside the repository.

- **Previously passing behavior:** MSE-05 early playback 10/10, MSE-06 buffer growth 8/8, MSE-08 buffered seeks 11/11, MSE-09 unbuffered seeks 22/22, MSE-10 EOS 10/10, MSE-11 cleanup/replacement/failure 12/12, separate SourceBuffer setup 15/15 and early playback 10/10, MSE-07 underrun/recovery 7/7, MSE-12 refusal 3/3, and S2 continuity 6/6. The early-playback check includes advancing `currentTime`, presented and changing frames, and further appends after playback starts. Bounded reads used no whole-file `arrayBuffer()` calls. These reruns emitted 0 console messages and 0 exceptions.
- **Exact seek race:** The review's Chrome trigger captured segment 7 video in flight with its audio queued. The seek dropped one queued audio operation. After that append boundary, no segment was falsely labelled appended against an unbuffered interior (`phantoms: []`). Seeking back to 26.9 s redelivered segment 7, buffered the target, fired `seeked` in 26.9 ms, and playback advanced. During the 20 s observation, `seeking` stayed false and delivery followed the progressing playhead rather than running away at an unavailable target. Ten additional seek/load/reset cycles found 0 phantom segments, 0 console messages, and 0 exceptions.
- **Reset/load race:** The review's back-to-back reset/load probe reported clean A reset, successful B load, B still current in `streaming`, B play progressing to 1.93 s, and clean subsequent B reset. Five further rapid reset/load cycles each reported clean old-session resources (0 live URLs, timeouts, intervals, frame callbacks, and listener groups), old MediaSource `closed` with 0 SourceBuffers, a distinct current session that played, and a clean final reset to `idle` with no session or video `src`. There were 0 console messages and 0 exceptions. The review harness calls its captured current B reference `orphan`; in this rerun it was the owned current session and was later cleaned normally.

### Second independent review — B3

The second independent review confirmed the B1 and B2 fixes, including under stress, and returned `REQUEST CHANGES — DO NOT COMMIT` for a new blocker. The architecture was not disproved; this was a scheduler/state-machine defect.

- **B3 — successive unbuffered seeks turned a superseded preparation into a fatal pipeline failure.**
  - **Root cause.** `#deliver(k)` awaited `#takePrepared(k)` while k's prepared slot stayed registered. A further unbuffered seek re-ran `#fillPrepared()`, which dropped every slot no longer among the next needed segments, including the one the delivery was waiting on. A slot dropped before its cut rejected with `PreparationError("DROPPED")`. `#deliver()` treated that like a real preparation failure, so the pipeline went to `failed`, the scheduler stopped, the element stayed `seeking`, and only Reset recovered.
  - **Reproduction by the review.** Deterministic in Node (30/30 controlled runs), and repeatedly in Chrome under rapid successive seeks.
  - **Second path, found while fixing.** A slot dropped *during* its cut resolved with its fragment bytes already released. The old code relied on the later stale-target check to discard it; if the latest seek returned to the same segment, those released bytes would have been enqueued.
- **Fix** (`pipeline.mjs`, scoped to delivery/preparation ownership):
  - Every `seeking` increments a per-session `seekGeneration`.
  - `#dropPrepared()` records `{ reason, seekGeneration }` on the dropped slot instead of a bare flag.
  - `#takePrepared()` returns `{ slot, entry }` or `{ slot, error }`. `#deliver()` records the generation when it starts waiting and classifies the outcome on the slot it waited on:
    - session closing, failed, or no longer current → return without touching state (unchanged B2 ownership);
    - any error other than `DROPPED` → fatal, as before (for example `SEGMENT_INVALID`, `SOURCE_TRUNCATED`, parser failure);
    - slot dropped with reason `not-next` at a **later** seek generation than the one the delivery started with → **superseded**: record `preparation-superseded` (stage `before-cut` or `during-cut`), count `totals.supersededPreparations`, and return `false`;
    - any other drop (a drop with no newer seek, or another reason) → fatal `PREPARATION_DROPPED_UNSUPERSEDED`, so an internal invariant violation is not silently ignored.
  - No other path changed. Attempt IDs and required parts (B1), lifecycle serialization and session ownership (B2), gating, and the scheduler itself are untouched.
- **Scheduler semantics.** A superseded delivery returns `false`, which the scheduler already treats as a stale release: it immediately re-reads `nextIndex()` (the next needed segment from the current playhead) and releases that. The superseded segment is never marked in flight, gets no attempt, and does not remain the target. Each supersession requires a newer `seeking` event, so there is no busy retry loop; the latest seek target wins.
- **Deterministic regressions** (`pipeline-races.test.mjs`; real Spike 0.5 preparation, preparer cuts held behind a test gate, controlled fake SourceBuffer completion):
  - `B3 (muxed|separate, tick|release)` reproduce the audit sequence exactly, 25 times each: initial preparation settles; seek A holds A's cut; seek B drops A mid-cut, and a delivery (scheduler urgent tick, or explicit `release()`) starts waiting on B's uncut slot queued behind it; seek C drops B's slot; the gate opens. They assert: one `preparation-superseded` (k = B, `before-cut`); no failure; scheduler not stopped; exactly one delivery (the latest target); neither A nor B left available; both fresh parts required before `APPENDED`; the seek record reaches `seeked`; `seeking` clears; the next segment delivers and appends; clean reset.
  - `B3: a dropped preparation without a newer seek is an invariant violation` → `PREPARATION_DROPPED_UNSUPERSEDED`, 0 supersessions.
  - `B3: a genuine preparation error for the current target still fails the pipeline` → `SEGMENT_INVALID`.
  - `B1 × B3 (muxed|separate)`: a seek abandons a partial attempt (muxed: queued audio dropped; separate: audio complete, video queued), successive seeks supersede a preparation, stale completions of the abandoned attempt arrive and do not promote it, the retry is a new attempt requiring both parts, and seeking resolves.
  - `B3 × B2 (reset|replace)`: session A's superseded, gated preparation settles only after replacement session B is active. B stays current, `streaming`, unfailed, with no supersession recorded, and completes an unbuffered seek; A records no failure; resets are clean with no live object URLs.
  - `B3 rapid successive seeks (muxed|separate)`: seeded storms, 4 seeds × 30 bursts of 2–6 seeks per layout (482 seeks each), with seek-abort on for odd seeds. Between seeks the storm randomly steps microtasks or timers, releases a held cut, completes an in-flight append/remove, or releases extra segments. After every burst: no failure, the latest seek's segment appended, the latest seek current, `seeking` cleared, deliveries per burst bounded. An independent audit wraps every append completion and requires each `APPENDED` promotion to carry the current attempt ID with all parts complete. Observed: muxed 59 supersessions, 20 abandoned attempts, 40 seeks while updating, 116 promotions; separate 58, 10, 53, 125. 0 audit violations; at most 3 deliveries per burst and 2 live attempts.
  - Against the pre-fix `pipeline.mjs` (run from a scratch copy; history untouched), the four B3 scenarios, both B1 × B3 tests, and both storms fail with `pipeline failed: DROPPED` (or, via `release()`, with 0 released), and the invariant test fails. The genuine-error and B3 × B2 tests are guards: apart from the new counter field, they pass on the pre-fix code, confirming that behavior is preserved.
- **Automated validation.** All 89 Phase 0 tests pass (47 earlier + 42 Spike 0.6, of which 16 are pipeline regressions). `node --check` on every Spike 0.6 module and `git diff --check` pass.

#### Chrome stress after the B3 fix

`AUTOMATED DESKTOP`, Google Chrome 153.0.8010.53 (`HeadlessChrome/153.0.0.0`) in throwaway profiles, MP-02 (110.5 MB, 76 segments), browser audio muted, one trusted CDP click for activation. The scratchpad CDP harness is not committed. Each storm alternated muxed and separate SourceBuffer layouts, FAST delivery, random `seekAbort` and back-buffer trimming. Seeks were issued at SourceBuffer `updatestart` 60 % of the time, in bursts of 1 (single), 2 (double), or 3 (triple) seeks, either back to back in one task or spaced by up to 40 ms or an `updatestart`. An independent in-page audit wrapped every append completion as in the Node storm.

| Storm | Seeks (single / double / triple bursts) | While updating | Pipeline failures | Permanent `seeking` hangs | Supersessions (before / during cut) | Stale or partial `APPENDED` | Abandoned attempts (seek drop / abort) | Redeliveries | Max live attempts | Max deliveries per seek wait | Latest-target mismatches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fixed, native cut timing | 649 (209 / 133 / 58) | 150 | 0 | 0 | 1 (1 / 0) | 0 / 0 | 29 / 27 | 56 | 1 | 4 | 0 |
| Fixed, cuts delayed 20–60 ms | 498 (150 / 102 / 48) | 194 | 0 | 0 | 28 (20 / 8) | 0 / 0 | 30 / 0 | 182 | 2 | 3 | 0 |
| **Pre-fix**, cuts delayed 20–60 ms | 486 (160 / 94 / 46) | 285 | **17, all `DROPPED`** (13 muxed, 4 separate) | 0 counted: the harness records the failure and reloads before its 15 s hang timeout | 0 | 0 / 0 | 98 / 64 | 61 | 1 | 4 | 0 |

- **Why the delayed-cut storm was added.** With native timing, cuts finish in about 10 ms, so a later seek rarely lands while a delivery waits on an uncut slot (1 supersession in 649 seeks). The harness therefore wrapped the page's `prep.cut()` with a 20–60 ms delay, standing in for slower storage and widening the race window. The same harness against the pre-fix page (served from a scratch copy of the pre-fix `pipeline.mjs` with otherwise identical files) reproduced B3 17 times.
- **Fixed runs.** 1,147 seeks, 0 pipeline failures, 0 permanent `seeking` hangs, 0 stale or partial `APPENDED` promotions, 0 in-flight segments without an attempt, 0 phantom appended segments (checked against `video.buffered` when trimming was off), 0 latest-target mismatches (after `seeked`, `currentTime` and the current seek record matched the last requested target). Seek latency p50 18.1 / p95 39.6 ms at native timing, 49.2 / 164.8 ms with delayed cuts. Every session reset clean. 0 console messages, 0 exceptions, only same-origin `GET`s.
- **Review repro script, unchanged.** The second review's own in-page seek-storm script (copied byte-for-byte from its scratchpad, SHA-256 verified) was rerun against the fixed page on MP-02: 252 seeks (52 double, 132 during SourceBuffer updates) over both layouts, 0 `DROPPED` failures, 0 other failures, 0 hangs without failure, 0 partial or stale `APPENDED` promotions of 287 checked, 55 abandoned attempts, at most 3 deliveries while seeking and 1 live attempt, 0 console messages.

#### MSE regression after the B3 fix

Same browser and flags, one fresh profile, all scenarios run in sequence through the page's `runScenario()` with a trusted activation click. Every run reported `PASS`, with 0 console messages, 0 exceptions, and only same-origin `GET`s:

| Scenario | Media | Checks | Key observation |
| --- | --- | --- | --- |
| MSE-05 early playback (muxed) | MP-02 | 10/10 | Began after 2 of 76 segments with 6,611,303 of 110,544,641 B read. `currentTime` advanced to 16.76 s. 5 segments were appended after playback began, and 502 frames were presented. |
| MSE-05 early playback (separate SourceBuffers) | MP-02 | 10/10 | Same start. Reached 16.79 s with 503 frames presented. |
| MSE-05 early playback | MP-03 4.53 GB | 10/10 | Began after 2 of 2,700 segments with 13,920,626 B read. Reached 12.03 s with 361 frames presented. |
| MSE-06 ahead buffering | MP-02 | 8/8 | — |
| MSE-07 underrun / recovery | MP-02 | 7/7 | 4 underruns (at 1.95, 8.66, 10.91, and 13.88 s; 2.0–8.9 s each). Each resumed 0.4–8.2 ms after the next append. |
| MSE-08 buffered seek | MP-02 | 11/11 | — |
| MSE-09 unbuffered seek | MP-02 and MP-03 | 22/22 each | — |
| MSE-10 end of stream: playthrough | MP-01 | 10/10 | One `endOfStream()`, `ended`, `currentTime` 10 = duration. |
| MSE-10 end of stream: seek near end | MP-05 | 9/9 | One `endOfStream()`, `ended` at 300 s. |
| MSE-11 cleanup (reset, replace, MSE failure, parser failure) | MP-02, MP-01, `mp08a` | 12/12 | All teardowns clean. |
| MSE-12 unsupported media refusal | 10 non-target / malformed files | 3/3 | — |
| S1 separate-buffer layout / edit lists | MP-02 | 5/5 | — |
| S2 timestamp continuity | MP-02 | 6/6 | — |

The page ended `idle`, with no session and a clean last teardown report. The B3 storms above also covered rapid successive unbuffered seeks, reset, and cleanup: every storm session reset clean.

#### Non-blocking notes from the second review (recorded, not changed)

1. In separate-buffer mode, stale content behind the back-buffer window may briefly be marked `APPENDED` after old audio is trimmed; seek reconciliation currently recovers.
2. Repository tests do not independently isolate the attempt-ID check.
3. Lifecycle serialization means Reset can wait for an in-progress load to finish.
4. Exact real-world presentation-time versus decode-time seek mapping remains later hardening work.
5. Carried from this fix: a genuine preparation error (for example `SOURCE_TRUNCATED`) for a segment that a later seek has already superseded is still fatal. This is conservative; the error is a real property of the file and recurs if that segment is needed again.

## Experiment Scope

In scope:

```text
local MP4 → bounded File.slice() reads → Spike 0.5 moov parse + deterministic plan
  → cut one planned segment (video + audio fMP4 fragments), verify, hold ≤ 2 ahead
  → simulated arrival (FAST 8× / NORMAL 1.5× / SLOW 0.5× / BURSTY / MANUAL)
  → append queue per SourceBuffer (serialised on updating/updateend)
  → MediaSource → HTMLVideoElement
```

Out of scope and not implemented:

- WebRTC or any network media transfer;
- P2P Progressive Watch;
- OPFS or other storage (no bridge was needed);
- synchronization;
- transcoding and FFmpeg in the page;
- production packages;
- Spike 0.7.

The page's CSP sets `connect-src 'none'` and allows `media-src` only for `blob:`.

## Environment

- **Date and revision.** 2026-09-26, repository revision `9d802b6` plus the uncommitted Spike 0.6 files. Spike 0.5 was used unchanged.
- **Host.** macOS 26.6.2 (25G83), Apple M5, 16 GB RAM. Node.js v26.3.0. Python 3.9.6 `http.server` served `spikes/phase0/` on `http://127.0.0.1:4177`.
- **Browser.** Google Chrome 153.0.8010.53 in a throwaway profile, deleted after each run. The User-Agent reported `HeadlessChrome/153.0.0.0` in the final runs.
  - Flags: `--headless=new --no-first-run --no-default-browser-check --enable-precise-memory-info --mute-audio --window-size=1280,1600`.
  - The autoplay policy was **not** relaxed: no `--autoplay-policy` flag was used.
  - One headed smoke run (same Chrome, no `--headless`) repeated MSE-02/03/04 and MSE-05; both passed.
- **Driver.** A scratchpad Chrome DevTools Protocol (CDP) driver, not committed. It:
  - selected local files with `DOM.setFileInputFiles` (a local file reference, no upload);
  - pressed page buttons with trusted `Input.dispatchMouseEvent` clicks, which grant real user activation;
  - recorded every console message, exception, log entry, and network request;
  - sampled `Runtime.getHeapUsage` every 500 ms;
  - read the video element's listeners with `DOMDebugger.getEventListeners`.

  A second, same-origin spike tab (`?observe-unload`) recorded `pagehide` teardown reports posted over `BroadcastChannel`.
- **Runs.**
  - **Run A** was a development run. It exposed the defects listed in [Development Defects Found and Fixed](#development-defects-found-and-fixed).
  - **Runs B and C** executed the same final 26-item matrix plus the never-shown-tab probe. Two experiments were rerun in both runs, and the original outputs are kept beside the reruns:
    - S1, after a fix to which fragments its comparison counted;
    - MSE-09, after its "no SourceBuffer reset" check was tightened to also require 0 `remove()` calls (the recorded value was already 0).

  Figures are from run B unless marked; run C agreed on every graded result.
- **Android.** `adb devices` listed no device.

### Development Defects Found and Fixed

These were fixed before runs B and C. None was a browser or architecture problem.

- **Init `updateend` wedged the append queue.** The pipeline's `onOpDone` callback threw on the init segment's `updateend` because end-of-stream bookkeeping ran before delivery state existed. The queue was left in `appending`. Fixed with guards in the pipeline and a regression-tested queue change: consumer callback errors are counted and no longer stop the queue.
- **Experiment hooks bypassed the one-read limit.** The MSE-09 experiment hooks (`abort()` and non-keyframe controls) called `cut()` directly while background preparation had a read in flight. Spike 0.5's one-read-in-flight guard threw. Experiment cuts now go through the same serial preparation chain.
- **Checks that encoded timing assumptions:**
  - `loadedmetadata` / `readyState` were read at the init segment's `updateend` (see [MSE State Findings](#mse-state-findings));
  - a start-up wait was classified as an underrun;
  - a BURSTY observation run was graded;
  - the MSE-09 backward-seek target became buffered because back-buffer trimming removed the start-up range;
  - a muxed SourceBuffer's empty intersection before segment 0's audio fragment was flagged as a gap;
  - S1 compared ranges against fragments appended after the snapshot.
- **Unload observation.** DevTools does not report a document's `pagehide` console output once it navigates, neither cross-origin nor same-origin. Evidence now comes from the `BroadcastChannel` observer tab.

## Test Media

These are the Spike 0.5 synthetic files, generated by `spike-05-mp4-segmentation/tools/make-test-media.sh` into the Git-ignored `spikes/phase0/test-media/spike-05/`. No media is committed and no real-world media was used.

| ID | File | Size | Duration | Layout | Video | Audio | Plan (≈ 2 s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MP-01 | `mp01-small-faststart.mp4` | 1,178,804 B | 10.0 s | `moov` first | `avc1.4d401e` 640×360, 2 s GOP, B-frames | `mp4a.40.2` 48 kHz | 5 segments |
| MP-02 | `mp02-typical-720p-moov-last.mp4` | 110,544,641 B | 300.0 s | `moov` last | `avc1.64001f` 1280×720 High, irregular GOP 0.53–5.93 s, B-frames | `mp4a.40.2` 44.1 kHz | 76 segments, 2.0–7.3 s |
| MP-05 | `mp05-typical-720p-faststart.mp4` | 110,544,641 B | 300.0 s | `moov` first | as MP-02 | as MP-02 | 76 |
| MP-03 | `mp03-large-90min-moov-last.mp4` | 4,525,650,413 B | 5,400.0 s | `moov` last, 64-bit `mdat` | `avc1.42c01f` 1280×720, 2 s GOP | `mp4a.40.2` 48 kHz | 2,700 × 2 s |
| Non-target / malformed | `mp04a`–`mp04f`, `mp07`, `mp08a`–`mp08d` | — | — | — | — | — | — |

The non-target and malformed files cover HEVC, MP3-in-MP4, Opus-in-MP4, WebM, video-only, two AAC tracks, a fragmented source, a truncated `mdat`, a truncated `moov`, random bytes, and an oversize `moov` claim.

Every target file carries an FFmpeg edit list on both tracks (`media_time` 1024: video 0.0667 s, audio 0.0232 s for MP-02).

## Implementation

`spikes/phase0/spike-06-mse-progressive/`:

- **`preparer.mjs`.** Imports the Spike 0.5 pre-check, classification, plan, reader, and verifier unchanged. It parses until the `moov`, with a stall guard and a read budget, and then:
  - builds the combined init segment and per-track inits (MP4Box.js `initializeSegmentation()` and `initializeSegmentation("per-track")`);
  - cuts planned segment *k* from one bounded window with `createFragment()`;
  - verifies every fragment independently and **refuses** any that fails. Verification checks `tfdt` against the sample table, the `trun` count, duration, and sizes, the `mdat` bounds, and that the video fragment starts on a sync sample.

  A unit test shows `cut(k)` is byte-identical (SHA-256) to Spike 0.5's planned cut for both layouts and any cut order.
- **`append-queue.mjs`.** An explicit state machine: `idle`, `appending`, `removing`, `blocked`, `failed`, `closed`.
  - One operation is in flight per SourceBuffer. `appendBuffer()`/`remove()` are issued only when `updating` is false and nothing of ours is outstanding, so there is no timing guess.
  - `error` fails the queue closed. `abort` marks the in-flight operation.
  - On `QuotaExceededError` the queue evicts behind the playhead and retries, or defers.
  - `clearPending()` supports seeks.
  - Bytes are dropped as soon as an operation completes, is cleared, or fails.
- **`delivery.mjs`.** Deterministic profiles (FAST 8×, NORMAL 1.5×, SLOW 0.5×, BURSTY, MANUAL) and a scheduler with an initial burst, hold/resume/release, gating, and urgent release. `SegmentState` computes the next needed segment from the playhead, or the lowest missing index for the naive control.
- **`pipeline.mjs`.**
  - **Setup.** MediaSource lifecycle: `sourceopen` with a timeout, then the object URL is revoked after `sourceopen`. One muxed or two separate SourceBuffers, init first, then an explicit `duration`.
  - **Delivery.** A lookahead gate (60 s) and append backpressure (≥ 4 queued operations), plus back-buffer trimming with `remove()` (30 s behind the playhead). At most 2 segments are prepared ahead.
  - **Seeking.** Seek classification and reprioritisation (Case B clears queued appends and releases the target's segment at once), with stale-delivery dropping. A preparation superseded by a newer seek is cancelled, not failed (B3).
  - **End of stream.** `endOfStream()` only when the last segment is appended, nothing is needed ahead of the playhead, nothing is in flight, and no queue is busy.
  - **Recording.** Event, stall, and seek recording, and `requestVideoFrameCallback` frame counting.
  - **Teardown.** `reset()` / `teardownSync()` produce a resource report: URLs, timeouts, intervals, frame callbacks, listener groups, queues, prepared entries, MediaSource and video state.
- **`scenarios.mjs`.** MSE-01 to MSE-12, supplementary S1 to S5, an unload probe, and a native-playback control. All checks record their observed values.

## Automated Validation

```text
node --test spikes/phase0/spike-0{1,2,3,4}-*/src/*.test.mjs \
            spikes/phase0/spike-05-mp4-segmentation/src/*.test.mjs \
            spikes/phase0/spike-06-mse-progressive/src/*.test.mjs
PASS — 73 tests, 0 failed (47 earlier Phase 0 + 26 Spike 0.6).
(Original run. After the independent-review fixes: 89 tests, 0 failed (47 + 42 Spike 0.6); see Independent Review Fixes.)

node --check on every Spike 0.6 module — PASS.
```

- **`queue-delivery.test.mjs`** (20 tests). The fake SourceBuffer throws `InvalidStateError` if called while updating, and follows the MSE event order. Coverage:
  - ordered one-at-a-time appends with bytes released;
  - `clearPending` with an in-flight append;
  - an `error` event failing the queue closed;
  - `QuotaExceededError` handled by evict-and-retry, by defer-and-resume, and by the attempt limit;
  - `abort()`;
  - foreign `updating`, and events arriving after `close()`;
  - queue bounds;
  - a consumer callback exception (regression);
  - release delays for every profile;
  - scheduler burst, interval, withhold, hold/resume, gate, urgent, stale retry, and `stop()`;
  - `SegmentState`, ranges, the bounded log, and the resource tracker.
- **`preparer.test.mjs`** (6 tests, real MP4Box.js 2.4.1 over the Spike 0.5 in-code fixtures). Coverage:
  - classification and MIME strings;
  - combined and per-track inits;
  - byte-identity with Spike 0.5 and one window per cut;
  - refusals: non-BMFF, HEVC, MP3, and a truncated source at cut time;
  - a mid-GOP negative control;
  - `close()`.

The unit tests do not establish playback. Playback evidence is below.

## Test Status

| Test | Status | Evidence (run B; C agreed) |
| --- | --- | --- |
| MSE-01 Capability detection | `AUTOMATED DESKTOP PASS` (5/5) | Derived `video/mp4; codecs="avc1.64001f, mp4a.40.2"`, video-only and audio-only supported. Invalid profile and unknown codec rejected. Capability only. |
| MSE-02 MediaSource creation | `AUTOMATED DESKTOP PASS` | `closed` → `sourceopen` → `open`. SourceBuffers in `segments` mode. Object URL revoked after `sourceopen`. |
| MSE-03 Initialization append | `AUTOMATED DESKTOP PASS` | Init 1,325 B (muxed) or 756 + 725 B (separate) accepted. `loadedmetadata` 1.1 ms after `updateend`. 1280×720. |
| MSE-04 Incremental append | `AUTOMATED DESKTOP PASS` (15/15, muxed and separate) | 8 segments released one by one. One range after each, end growing, within 0.022 s of the plan end. 0 append-while-updating. |
| MSE-05 Early playback | `AUTOMATED DESKTOP PASS` (10/10 × 3 variants) | See [Progressive Playback Evidence](#progressive-playback-evidence). |
| MSE-06 Ahead buffering | `AUTOMATED DESKTOP PASS` (8/8) | 8.7 s ahead → 63.7 s ahead by 8 s wall, then held at the 60 s cap. |
| MSE-07 Buffer underrun | `AUTOMATED DESKTOP PASS` (7/7, SLOW); BURSTY `OBSERVED` | 4 underruns (2.0–8.9 s), each resumed 0.5–9.2 ms after the next append. |
| MSE-08 Seek inside buffer | `AUTOMATED DESKTOP PASS` (11/11) | Forward +15 s and backward seeks: `seeked` in 11.2 / 14.4 ms, then playback advanced. |
| MSE-09 Seek outside buffer | `AUTOMATED DESKTOP PASS` (22/22 on MP-02 and MP-03, in both runs and both reruns) | Mechanism established, no SourceBuffer reset needed; negative controls included. |
| MSE-10 End of stream | `AUTOMATED DESKTOP PASS` (10/10 playthrough, 9/9 after a seek near the end) | One `endOfStream()` after the last `updateend`, `sourceended`, `ended`, `currentTime` = duration. |
| MSE-11 Cleanup / reset | `AUTOMATED DESKTOP PASS` (12/12) + unload probe | Mid-stream reset, restart, replace, MSE failure, and parser failure all clean. `pagehide` teardown clean. |
| MSE-12 Unsupported media | `AUTOMATED DESKTOP PASS` (3/3) | 10 files refused before any MediaSource or object URL was created. |
| MSE-13 Physical Android | `DEFERRED PHYSICAL` | No device. `DEFERRED-PHYSICAL-006`. |
| S1 Buffer layout / edit lists | `AUTOMATED DESKTOP PASS` (5/5, rerun after an accounting fix) | Both layouts play. Chrome applies the source edit list in MSE. |
| S2 Timestamp continuity | `AUTOMATED DESKTOP PASS` (6/6, MP-02 and MP-05) | 152 appends, one contiguous range, final [0, 300.000]. |
| S3 Quota (no caps, paused) | `OBSERVED` | `QuotaExceededError` after 190 s / 159.5 MB. Recovered once playback advanced. |
| S4 Long run (MP-03, 4×, trim, far seek) | `AUTOMATED DESKTOP PASS` (7/7) | 355.5 MB through MSE. Buffered media ≤ 100 s. JS heap flat at about 71 MB. |
| S5 Background tab | `OBSERVED` | A playing session keeps playing and appending while hidden. A never-shown tab defers `sourceopen` until it is shown. |

## Browser Playback Evidence

Playback is claimed from HTMLVideoElement behavior, not from append acceptance.

- **`playing` and `play()`.** `playing` fired in every playback experiment. `play()` resolved (for example 0.9 ms after the call, with `userActivation.hasBeenActive: true`).
- **`currentTime` advanced in real time.** In MSE-05 on MP-02, 1-second samples read 0.012 → 1.223 → 2.223 → 3.473 → … → 15.974 s.
- **`readyState`.** It was 4 (`HAVE_ENOUGH_DATA`) while playing and 2 while waiting.
- **Frames were presented.** `requestVideoFrameCallback` counted 502 presented frames over 16.76 s of MSE playback (about 30 fps, the source rate). The MP-03 run counted 361 frames over 12.05 s.
- **Displayed frames changed.** 64×36 canvas digests of the displayed frame differed at 0, 1.54, and 16.76 s: `1d96036b`, `08e08c12`, `16759049`.
- **Normal completion.** MSE-10 reached `ended` with `currentTime` equal to `duration`.
- **Autoplay negative control.** On a fresh page with no user activation, `play()` was rejected with `NotAllowedError` ("play() failed because the user didn't interact with the document first"). The autoplay policy was in force. Every playback run started from a trusted click on **Run experiment**.
- **`droppedVideoFrames` is not interpreted.** `getVideoPlaybackQuality()` reported about 98 % of frames "dropped" in every run (for example 500 of 507), while about 30 fps were presented. A native-playback control, the same file through a plain `File` object URL with no MSE, reported the same (236 of 242 dropped, 238 presented over 7.9 s), and so did the headed run. The counter is therefore a property of this automated environment, not of MSE or of the pipeline. Smoothness and A/V sync need manual observation: `MANUAL TEST REQUIRED`.

## Progressive Playback Evidence

The central requirement is met: **playback began when only an initial subset of the media had been supplied, and more media kept arriving afterwards.**

| Run | Supplied when playback began | Source read when playback began | Playback began | After release |
| --- | --- | --- | --- | --- |
| MP-02 muxed | 2 of 76 segments (0–8.733 s), 3,217,346 B appended | 6,611,303 of 110,544,641 B (5.98 %) | 113.9 ms after load (C: 121.8 ms) | 5 more segments appended after playback began. Played to 16.76 s with 0 stalls. |
| MP-02 separate SourceBuffers | same | same | 110.0 ms | same, to 16.80 s |
| MP-03 4.53 GB, `moov` last | 2 of 2,700 segments (0–4 s), 3,501,591 B | 13,920,626 of 4,525,650,413 B (0.31 %) | 186.3 ms (C: 190.2 ms) | 8 more segments. Played to 12.05 s with 0 stalls. |

Procedure (MSE-05):

1. Load with delivery set to MANUAL and 2 initial segments.
2. Call `play()` from the trusted click.
3. **Withhold** all later segments. `currentTime` advanced to 1.54 s with exactly 2 segments appended and 2 delivered.
4. When less than 1.5 s remained buffered (at `currentTime` 7.23 s), switch to NORMAL (1.5×) and release progressively.
5. Playback continued past the end of the initial supply (8.73 s) to 16.76 s.

The source bytes read at start include the metadata read (`moov` last: first block plus `moov`) and the 2 segments prepared ahead.

## MSE State Findings

- **MediaSource.** It was `closed` at attach, then `sourceopen` fired and it became `open` 0.4–2.1 ms after `video.src` was set in these runs. It went to `ended` after `endOfStream()` (`sourceended` fired once) and to `closed` after detach (`sourceclose` observed). Revoking the object URL right after `sourceopen` did not affect playback.
- **Init segment ordering (Chrome).** The init segment's `updateend` fires **before** Chrome updates the element. At `updateend`, `readyState` was 0, `videoWidth` was 0, and `duration` was `Infinity`. `loadedmetadata` followed 0.9–1.1 ms later. Consumers must wait for `loadedmetadata`, not infer metadata from `updateend`.
- **Init duration.** MP4Box.js writes the init with `mvhd.duration = 0` and no `mehd` for a non-fragmented source, so MSE reports `duration = Infinity` until it is set. The pipeline set `duration` to the plan end (300.023 s). After `endOfStream()`, Chrome reset it to the highest buffered end (299.999999 s for MP-02; 10.000 s for MP-01).
- **First frame latency.** `readyState` reached ≥ 2 about 44 ms after the first media segment's `updateend` (muxed; the separate-mode run had already reached it by its first poll). The first `requestVideoFrameCallback` fired 48–149 ms after load.
- **Element events.**
  - `waiting` fired at every underrun. Chrome **never** fired `stalled` for MSE: 0 in every run.
  - `canplay` and `canplaythrough` fired on each recovery.
  - `timeupdate` and `progress` were counted but not logged.
- **Background tab (S5).**
  - A playing session in a tab that becomes hidden kept playing (`currentTime` 2.40 → 12.74 s over 10 s hidden) and kept delivering and appending (2 → 6 segments). `readyState` stayed 4. `requestVideoFrameCallback` paused while hidden (73 frames throughout) and resumed on return.
  - A load started while hidden, in a tab that had been shown before, succeeded (15/15).
  - In a tab that had **never been shown**, the MediaSource stayed `closed` for 4 s (`sourceopen` did not fire). It opened immediately once the tab was shown, and the load completed. This was reproduced in 2/2 attempts plus runs B and C.
  - These were short, desktop-only observations. Long-duration background throttling was not tested.

## SourceBuffer Findings

- **Appends were serialised.** `appendBuffer()` was never called while `updating`. `invalidStateThrows` = 0 and `foreignUpdating` = 0 in every run, and every append completed with `updateend`.
- **Muxed layout works with single-track fragments.** One SourceBuffer, `video/mp4; codecs="avc1.64001f, mp4a.40.2"`, took the combined init, then Spike 0.5's per-track fragments (one `traf` per `moof`) appended as separate `appendBuffer()` calls. The fragments needed no re-muxing.
- **Separate layout works too.** Two SourceBuffers took MP4Box.js per-track inits (756 B video, 725 B audio) and the same fragments. The element's buffered range is the intersection of the two.
- **Duplicate `moof` sequence numbers are harmless.** The video and audio fragments of a segment share `mfhd` sequence number *k*+1. Chrome ignored this.
- **Spike 0.5 outputs need nothing extra.** Either layout works. The muxed layout needs one `timestampOffset` for both tracks; the separate layout would allow per-track offsets if a later design needs them. No single-buffer design was forced.
- **A muxed buffer reports the intersection.** A muxed SourceBuffer's `buffered` stays **empty** after segment 0's video fragment, until its audio fragment is appended. Segment *k* becomes playable only once both fragments are in.
- **Edit lists are applied (S1).** Chrome 153 applies each track's source edit-list `media_time` in MSE. Video buffered end 11.000 s = sample-table 11.0667 − 0.0667. Audio end 10.983 s = 11.0063 − 0.0232. The audio lead-in that would fall before 0 is trimmed by the default `appendWindowStart` of 0. The MSE timeline therefore starts at 0 for both tracks, as native playback of the file would.
- **abort() (MSE-09 B2).** `abort()` during an in-flight 1.19 MB video append:
  - set `updating` to false at once;
  - fired `abort` then `updateend`;
  - left **nothing** buffered from the aborted append.

  The same segment then appended normally **without** re-appending the init segment.
- **Append errors (MSE-11).** An invalid media segment (a `moof` whose child box overruns it) fired SourceBuffer `error` then `updateend`. The MediaSource went to `ended` and the element reported `MEDIA_ERR_DECODE` (3): "PipelineStatus::CHUNK_DEMUXER_ERROR_APPEND_FAILED: RunSegmentParserLoop: stream parsing failed". The queue failed closed and issued nothing further.
- **Quota (S3).** On MP-03 at FAST, paused at 0, with no lookahead cap and no trimming, appends succeeded to 95 segments: [0, 190 s], 159,462,083 B.
  - The next append threw `QuotaExceededError`: "The SourceBuffer is full, and cannot free space to append additional buffers."
  - Chrome evicted nothing ahead of the playhead. The queue went `blocked` (deferred retries) and delivery paused on backpressure.
  - After `play()`, appends resumed about 6.9 s later with the range at [6, 196]. Chrome's own eviction had freed media behind the playhead; the pipeline issued 0 `remove()` calls. There were no stalls.
  - The limit is an observation for this headless desktop profile and 720p media, not a planning value.

## Buffer Growth Evidence

MSE-06 (MP-02, FAST 8×, lookahead cap 60 s). Values are `currentTime` → buffered end (ahead), sampled once per wall-clock second:

```text
wall 0 s   0.014 →  8.731 (+8.7)
wall 2 s   1.981 → 20.178 (+18.2)
wall 4 s   3.986 → 38.522 (+34.5)
wall 6 s   5.991 → 51.780 (+45.8)
wall 8 s   7.993 → 71.657 (+63.7)   cap reached; 27 gated releases follow
wall 16 s 16.006 → 76.858 (+60.9)   one range throughout
```

Run C gave the same series (maximum 63.66 s ahead). The cap held within one segment. MP-02 segments are up to 7.3 s, and the 60 s cap counts in-flight media.

## Underrun / Recovery Evidence

MSE-07 (MP-02, SLOW 0.5×, 1 initial segment, 40 s observed):

| Stall at `currentTime` | Waiting (ms) | Buffered ahead at `waiting` | `readyState` while waiting | Appends during the stall | `playing` after the next append's `updateend` |
| --- | --- | --- | --- | --- | --- |
| 1.946 s | 2,048.7 | 0.074 s | 2 | 1 | 4.1 ms |
| 8.657 s | 6,685.2 | 0.074 s | 2 | 1 | 6.5 ms |
| 10.906 s | 2,285.7 | 0.077 s | 2 | 1 | 9.2 ms |
| 13.882 s | 8,882.4 | 0.073 s | 2 | 2 | 1.1 ms |

- **Sequence.** Each stall followed the same order: playback reached the buffered end, `waiting` fired, `readyState` dropped to 2, a segment arrived, `canplay`/`canplaythrough`/`playing` fired, and playback resumed. Playback reached 20.04 s.
- **Counts.** `waiting` 5 (one was a 7 ms start-up wait before the first frame, excluded above), `playing` 5, `stalled` 0.
- **Run C.** The same four stalls, of 2,025, 6,703, 2,285, and 8,879 ms.
- **BURSTY (observational).** 4 segments at 6×, then a pause of 3 segment durations. 0 underruns in 40 s, reaching 39.97 s.

## Seek Findings

### Buffered Seek (MSE-08, Case A)

- **Forward.** A +15 s seek (to 18.248 s, inside [0, 34.017]) produced `seeked` in 11.2 ms (C: 14.2 ms).
- **Backward.** A seek to 1.248 s (inside [0, 38.522]) produced `seeked` in 14.4 ms (C: 16.6 ms).
- Both were classified as buffered, and nothing was reprioritised. Playback advanced ≥ 1 s from each target.

### Non-Buffered Seek (MSE-09, Case B)

Mechanism established, with back-buffer trimming off so that the ranges left behind by each seek stay visible:

1. On `seeking`, check whether `currentTime` is inside the element's buffered ranges.
2. If not:
   1. map the target to its planned segment *k* with the Spike 0.5 `planIndexForTime` (the segment start is the preceding keyframe);
   2. drop queued appends and stale prepared segments;
   3. release segment *k* at once, and continue delivery from the playhead.
3. **No SourceBuffer reset is needed.** Not `abort()`, not `remove()`, not a new init segment, not `changeType()`, not a `timestampOffset` change. Out-of-order appends in `segments` mode simply create further buffered ranges.

| File | Seek | Target | Planned segment (keyframe start) | Segment cut | Delivered / appended / `seeked` after `seeking` | Ranges after |
| --- | --- | --- | --- | --- | --- | --- |
| MP-02 | forward from 3 s | 180.014 s | #45 [179.667, 184.367) | 1 read, 1,741,395 B, 9.6 ms | 10.2 / 10.9 / 15.2 ms | [0, 8.731], [179.667, 184.366] |
| MP-02 | backward | 90.007 s | #24 [89.900, 93.567) | 1 read, 1,412,047 B, 11.9 ms | 12.5 / 14.4 / 22.3 ms | 3 disjoint ranges |
| MP-03 4.53 GB | forward | 2701 s (45:01) | #1350 [2700, 2702) | 1 read, 1,727,972 B, 51 ms (C: 23 ms) | 51.7 / 52.3 / 68.7 ms (C: 41.3) | [0, 8], [2700, 2704] |
| MP-03 | backward | 1350.5 s | #675 [1350, 1352) | 1 read, 1,523,100 B, 10.3 ms | 11.1 / 12.7 / 22.9 ms | 3 disjoint ranges |

- The table shows the original run B execution. Across all four final executions (runs B and C and their MSE-09 reruns), `seeked` followed `seeking` by **15–82 ms** for these unbuffered seeks. The target segment, window size (1 read, same bytes), resulting ranges, and control outcomes were identical in every execution.
- `seeked` reported `currentTime` equal to the target, for example 180.014 and 2701.001.
- Chrome decoded from the segment's keyframe and presented from the target. At least 46 frames were presented after each seek, and playback advanced.
- The init segment was appended exactly once per session.
- S4 repeated the far seek on MP-03 during a trimmed 4× run: `seeked` in 34.3 ms (C: 37.0 ms).

Controls:

- **B0, naive sequential cursor.** Without reprioritisation, the seek to 180 s did not complete in 8 s: `seeking` stayed true, `readyState` was 1, and the sequential frontier had only reached 20.2 s. On MP-03, the frontier reached 20 s against a 2701 s target. A production buffer manager must reprioritise to the seek target.
- **B2, `abort()`.** See [SourceBuffer Findings](#sourcebuffer-findings). It can safely discard an in-flight append without re-initialization, but the Case B mechanism above did not need it: the in-flight append was simply allowed to finish.
- **B3, non-keyframe fragments** (separate video SourceBuffer, MP-02 GOP at samples 786–845). None of these produced an error; misalignment fails silently. This confirms the Spike 0.5 decision to use keyframe-aligned planned segments rather than MP4Box.js built-in segments.

  | Fragment | Samples | Expected buffered start (first keyframe − edit shift) | Observed |
  | --- | --- | --- | --- |
  | no keyframe | 796–845 | none | **nothing buffered**, no error, queue idle |
  | mid-GOP, later keyframe at 846 | 796–1020 | 28.200 s | [28.200, 34.033]: frames before the keyframe **silently dropped** |
  | keyframe-aligned | 786–1020 | 26.200 s | [26.200, 34.033] |

  MP-03 behaved the same: nothing buffered, [22, 24), [20, 24).

## End-of-Stream Evidence

- **MP-01 playthrough** (NORMAL, 2 initial segments of 5). Playback began with 2 of 5 appended.
  - `endOfStream()` was called once, 0.5 ms after the last segment's `updateend` (4,040.7 → 4,041.2 ms), with all 5 appended and `currentTime` 3.93 s. It was not premature.
  - `duration` went from 10.0213 to 10.000 s, and `sourceended` fired once.
  - No append followed. Playback reached `currentTime` 10.000 = `duration`, `ended` fired once, and `video.ended` was true. MediaSource `readyState` was `ended` and element `readyState` 4.
- **MP-05, near-end seek.** All 76 segments were delivered at FAST while paused. `endOfStream()` was called once, 0.3 ms after the last `updateend`, and `duration` went from 300.023 to 299.999999 s. A seek to 295 s followed by `play()` reached `ended` at `currentTime` 300.
- Run C gave the same values (EOS 0.1–0.2 ms after the last `updateend`).

## Cleanup Evidence

A teardown report is **clean** only when all of the following hold:

- 0 live object URLs, timeouts, intervals, frame callbacks, and listener groups;
- no prepared segments, and every queue closed with 0 operations and 0 bytes;
- MediaSource `closed` with 0 SourceBuffers;
- `video.readyState` 0 with no `src` attribute.

| Path | Result |
| --- | --- |
| Reset mid-stream (MP-02 playing, 1 timeout, 1 interval, 1 frame callback, 2 prepared segments = 1.92 MB live) | clean; `sourceclose` observed; 29 listeners added and all removed via one `AbortController` |
| Another session afterwards | loaded and played (≥ 1.5 s) |
| Replace media while playing (MP-02 → MP-01) | previous session torn down with reason `replaced`, clean; replacement played |
| MSE / playback failure (invalid media segment) | `sb-error` 1, `media-error` 1 (`MEDIA_ERR_DECODE`), `sourceended` 1; pipeline failed at stage `append`; queue failed closed; reset clean |
| Parser / preparation failure (`mp08a`, truncated at 60 %) | playback began, 2 of 5 segments appended, then `SOURCE_TRUNCATED` for segment 2 ("needs bytes up to 727170; the source ends at 707282"). Delivery stopped, 0 prepared and 0 queued bytes, and the buffered [0, 3.989] kept playing. Reset clean. |
| Page unload (`pagehide`, bfcache `persisted: true`) | the observer tab received a report: clean, MediaSource `closed`, 0 SourceBuffers, 0 live resources, queues closed, preparer closed |
| Video-element listeners after each experiment (CDP `DOMDebugger.getEventListeners`) | 0 (22 while a session was live) |

`video.currentSrc` keeps the string of the revoked `blob:` URL after `removeAttribute("src")` + `load()`. It holds no resource.

## Memory Findings

- **Bounded pipeline memory.** JavaScript retains at most:
  - the MP4Box.js sample tables (the known Spike 0.5 cost);
  - ≤ 2 prepared segments (max 3.50 MB on MP-03);
  - queued appends (max 1.68 MB);
  - the segment being cut (one window ≤ 1.77 MB here).

  Each fragment's bytes are dropped once it is handed to `appendBuffer()`, which copies them. There is never an entire source, sample set, or fragment set in memory.
- **Long run (S4, MP-03).**
  - 212 segments (355,547,111 B) passed through MSE at 4× playback, including a seek to 45:00 and 20 back-buffer `remove()` calls.
  - Buffered media stayed ≤ 100 s, in one range except during the seek transition.
  - The CDP-sampled JS heap was flat at 70.6–72.5 MB for 76 s, peaked at 127.8 MB during the `moov` parse, and fell to 2.28 MB after reset and GC.
  - 368.8 MB were read from the source in 223 reads, max 1.77 MB each.
- **Small files.** MP-02 sessions peaked at 5.9–9.1 MB of heap.
- **Sample-table cost.** The about 71 MB steady state on MP-03 is dominated by the Spike 0.5 sample-table cost (415,260 samples). It scales with duration × sample rate and remains the main mobile memory risk.
- **Not measured.** Browser-side MSE memory (demuxed buffers inside Chrome) was not measured; only buffered duration and bytes are known. No exact process memory is claimed.

## Unsupported Media Findings

All 10 non-target or malformed files were refused **before** any MediaSource or object URL was created (`urlsCreated` 0), each with a stage and a code:

| File | Refusal | `isTypeSupported` for its codecs (diagnostic only) |
| --- | --- | --- |
| `mp04a` HEVC + AAC | `NON_TARGET` @ classify: video not H.264/AVC | `hvc1.1.6.L63.90` **true**, `mp4a.40.2` true |
| `mp04b` AVC + MP3 | `NON_TARGET`: audio `mp4a.6b` not AAC | `mp4a.6b` false |
| `mp04c` AVC + Opus | `NON_TARGET`: audio not AAC | `Opus` true |
| `mp04e` video only | `NON_TARGET`: no audio track | — |
| `mp04f` two AAC tracks | `NON_TARGET`: 2 audio tracks | — |
| `mp07` fragmented source | `NON_TARGET`: already fragmented | — |
| `mp04d` WebM, `mp08c` random | `NOT_ISO_BMFF` @ precheck | — |
| `mp08b`, `mp08d` | `MOOV_TRUNCATED` @ precheck | — |

- `isTypeSupported()` returned true for HEVC, AV1, VP9/WebM, and Opus-in-MP4 on this Mac. Refusal is by Driftless target policy, and a positive capability answer does not make a file a target.
- The MSE-type capability refusal (`MSE_TYPE_UNSUPPORTED`) is implemented but was not triggered, because every target codec was supported.
- The truncated-`mdat` file (`mp08a`) passes classification and fails at cut time (MSE-11).

## Physical Android Evidence

None. `adb devices` listed no device, and no emulator was used. MSE-13 is `DEFERRED PHYSICAL` and is tracked as `DEFERRED-PHYSICAL-006`.

## Security / Privacy Verification

| Check | Result |
| --- | --- |
| Selected media stays local | Files are reached only through `File.slice()`. CSP `connect-src 'none'`. |
| No network media transfer | In both runs, the CDP requests were only: same-origin `GET`s for the page's static files (Spike 0.6 and imported Spike 0.5 modules, and MP4Box.js); Chrome's internal `data:` icons for the native controls; and one `blob:` media request from the native-playback control. There were 0 non-`GET` requests and 0 request bodies. No WebRTC or storage API is referenced in the Spike 0.6 code. |
| No analytics or telemetry | None present. 0 console messages and 0 exceptions in runs B and C. |
| No remote media URLs | `media-src blob:` only. The page accepts only locally selected `File`s. |
| Untrusted parser input | The Spike 0.5 pre-check and budget run before MP4Box.js, and every fragment is verified and refused on failure. Malformed and truncated inputs failed cleanly (MSE-11, MSE-12). |
| MSE errors | `error`, `abort`, `QuotaExceededError`, `InvalidStateError`, and media-element errors are all handled. The queue fails closed. |
| Safe DOM rendering | `textContent` and CSSOM only. There is no `innerHTML`. File names are sanitised and bounded. |
| No persistent media data | No OPFS, IndexedDB, Cache Storage, or web storage. The `pagehide` report uses an in-memory `BroadcastChannel`. The Chrome profile was deleted after each run. |
| Local test media ignored | `spikes/phase0/test-media/` is Git-ignored, and no media file is tracked. |
| Lab hooks | `window.__spike06`, a `BroadcastChannel` observer (`?observe-unload`), and experiment/fault-injection methods exist for evidence collection only. They are not production patterns. |

## Risks / Issues

1. **Real-world media is untested.** Rotation, variable frame rate, open GOPs, multiple sample descriptions, and QuickTime brands may behave differently.
2. **Mobile memory.** The sample-table heap (about 71 MB for 90 minutes at 30 fps in this browser) plus MSE memory is an Android risk. This is carried over from Spike 0.5.
3. **Silent failure on misaligned segments.** Appending a segment that does not start on a keyframe raises no error: frames up to the next keyframe are dropped and a gap appears. The planned keyframe alignment and the independent verifier are therefore essential.
4. **Background tabs.** A tab that has never been shown defers MSE setup until it is shown. Hidden tabs throttle timers, and long-duration throttling was not tested. Progressive Watch UX and delivery scheduling must account for both.
5. **Quota is environment-specific.** Here it was about 160 MB of 720p media, and appends block until playback frees space. A buffer manager must cap lookahead and treat `QuotaExceededError` as backpressure.
6. **Edit lists.** Chrome applies the source edit lists in MSE. Other browsers were not tested and may not.
7. **Metrics.** `droppedVideoFrames` was unusable under automation, and A/V sync and smoothness were not measured.
8. **Environment.** Everything ran on one headless desktop Chrome (plus one headed smoke run), with same-host timings. Latency figures such as 15–82 ms unbuffered seeks are lab observations, not planning values.
9. **Semi-internal MP4Box.js fields.** This is inherited from Spike 0.5: the planned cut sets `sample.data` / `alreadyRead` / `samplesDataSize` / `nextMoofNumber`.

## Deferred Physical Tests

- `DEFERRED-PHYSICAL-001` to `DEFERRED-PHYSICAL-005` are retained unchanged in `PROJECT_STATE.md`.
- `DEFERRED-PHYSICAL-006 — Spike 0.6 Android Chrome MSE progressive-playback qualification` is new. On physical Android Chrome, repeat MSE-01 to MSE-12 with MP-01, MP-02, and MP-03. Cover:
  - early start, ahead buffering, underrun and recovery;
  - seeks inside and outside the buffer, including 45:00 on the 4.53 GB file;
  - end of stream, reset, replace, and failure cleanup;
  - `QuotaExceededError` behavior and limit;
  - backgrounding, screen-off, and a never-shown tab.

  Record device model, OS, Chrome version, free RAM, heap after the `moov` parse, `isTypeSupported` answers, audible A/V sync, and visible smoothness.

## Architecture Impact

`No architecture change required`

- **Assumptions hold.** The accepted Progressive Watch assumptions hold for non-fragmented target media in controlled desktop Chrome:
  - receiver playback through MSE of keyframe-aligned fMP4 segments;
  - playback starting from an initial buffer while later segments arrive;
  - buffer-state-driven delivery;
  - seek prioritisation.
- **Spike 0.5 output is consumable directly.** Its planned segments work in either SourceBuffer layout, without re-muxing.
- **Design refinements, recorded as observations in `docs/MEDIA_PIPELINE.md`:**
  - an unbuffered seek needs a reprioritised keyframe-aligned segment, but no SourceBuffer reset;
  - the buffer manager must cap lookahead and handle quota as backpressure;
  - Chrome's MSE timeline applies edit lists;
  - receivers must expect deferred MSE setup in never-shown tabs.

  None changes an ADR.

## Follow-up

- Completed: independent re-review of Spike 0.6 passed, and the spike was committed at `7bbb10f`. The uncommitted Spike 0.7 work builds on that commit.
- Open: `DEFERRED-PHYSICAL-006` (physical Android Chrome MSE qualification) and real-world media coverage (`MANUAL TEST REQUIRED`).
