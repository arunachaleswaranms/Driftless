# Phase 0 Experiment Framework

Phase 0 exists to prove or disprove Driftless's riskiest architectural assumptions before production application work begins. All code and evidence here are experimental. A successful spike is not a product support claim, and Phase 0 does not authorize Phase 1.

## Phase 0 Status

Phase 0 is **IN PROGRESS**; software-feasibility closure has not been granted.

| Spike | Software feasibility | Git | Open debt |
| --- | --- | --- | --- |
| 0.1 Local media playback | `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED` | `4edc074` | `DEFERRED-PHYSICAL-001` |
| 0.2 WebRTC connectivity | `PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED` | `4edc074` | `DEFERRED-PHYSICAL-002` |
| 0.3 RTCDataChannel binary transfer | `PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED` | `0664735` | `DEFERRED-PHYSICAL-003` |
| 0.4 Browser storage / OPFS | `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED` | `72c8629` | `DEFERRED-PHYSICAL-004` |
| 0.5 MP4 parsing / segmentation | `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED` | `9d802b6` | `DEFERRED-PHYSICAL-005` |
| 0.6 MSE progressive playback | `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`; passed independent re-review | `7bbb10f` | `DEFERRED-PHYSICAL-006` |
| 0.7 P2P progressive watch proof | `READY FOR INDEPENDENT RE-REVIEW` after a `REQUEST CHANGES` review (scheduling blocker B1, stale closure docs B2) | uncommitted | `DEFERRED-PHYSICAL-007` |

Spikes 0.1–0.6 have completed software feasibility. Spike 0.7 is implemented and awaits final independent re-review. Physical Android, real external-network, STUN/TURN, and real-world media qualification remain deferred for every spike and are not validated by any desktop result.

## Evidence Rules

- Record actual browser, operating-system, device, media, and network details.
- Use `AUTOMATED PASS`, `DESKTOP MANUAL PASS`, `EMULATOR PASS`, `PHYSICAL DEVICE PASS`, and `DEFERRED PHYSICAL` labels so evidence cannot be mistaken for a stronger result.
- Never promote automation, emulation, or desktop device simulation to physical-device evidence.
- Do not mark a spike `PASS` until every acceptance criterion has current evidence.
- Maintain the physical qualification debt list in `PROJECT_STATE.md` until each item is physically validated.
- Store local test media only under `spikes/phase0/test-media/`; the directory is ignored by Git.
- Keep experiment implementations under `spikes/phase0/`, separate from future production code.
- If evidence invalidates an accepted ADR, stop and request architecture review instead of silently changing the ADR.

## Spike 0.1 — Large Local Browser Media Playback

- **Objective:** Determine whether target browsers can reliably play large user-selected local media without uploading it.
- **Architectural question:** Can Local Sync bind multi-GB local MP4/H.264/AAC media through browser-native file and media APIs without an application-level full-file memory copy?
- **Status:** `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`
- **Environment:** Automated smoke: macOS 26.6.2 / Chrome 153.0.8010.48. User evidence: desktop Chrome; exact manual browser version and media characteristics were not recorded. Physical Android Chrome remains deferred.
- **Procedure:** The user selected and played compatible local video in desktop Chrome, then exercised pause/resume and seeking. Detailed replacement, incompatible-media, representative multi-GB memory, and physical Android qualification remain future evidence items.
- **Acceptance criteria:** The desktop core path is accepted from actual manual evidence. No full compatibility or Android support claim is made without the deferred physical and detailed resource evidence.
- **Evidence:** [Spike 0.1 result record](results/spike-01-local-media.md). Desktop local-file selection, compatible playback, pause/resume, and seeking worked; overall behavior was good and no architecture-changing issue was observed. Exact memory measurements were not recorded.
- **Result:** `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`.
- **Issues discovered:** No architecture blocker. Android architecture risk and representative large-file browser/decoder memory behavior remain unqualified.
- **Decision:** Close Spike 0.1 software work provisionally. Reopen only if later findings require it. Track `DEFERRED-PHYSICAL-001` in `PROJECT_STATE.md` until physical Android validation is complete.
- **Follow-up:** Accumulate the physical Android gate for the later project-wide physical qualification stage.

## Spike 0.2 — WebRTC Peer Connectivity

- **Objective:** Prove basic browser WebRTC peer connectivity suitable for later control and transfer traffic, without implementing binary transfer, synchronization, production signaling, or Progressive Watch.
- **Architectural question:** Can two Driftless peers establish a WebRTC peer connection suitable for later control and transfer traffic?
- **Status:** `PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED`
- **Environment:** `AUTOMATED DESKTOP` on macOS 26.6.2 with two Chrome 153 tabs in one browser profile and same-origin in-memory development signaling. Physical Android and separate Internet networks were not tested.
- **Procedure:** The isolated experiment in `spike-02-webrtc-connectivity/` created initiator and responder peers, exchanged SDP/ICE over `BroadcastChannel`, opened a text-only `RTCDataChannel`, exchanged `PING`/`PONG`, captured `getStats()` selected-pair diagnostics, and closed owned resources.
- **Acceptance criteria:** WC-01 through WC-08 pass in the controlled desktop environment. WC-09 remains `DEFERRED-PHYSICAL / EXTERNAL-NETWORK VALIDATION`; therefore the result is provisional rather than full `PASS`.
- **Evidence:** [Spike 0.2 result record](results/spike-02-webrtc-connectivity.md). Both peers reached `connected`; ICE gathering completed; the control channel opened; diagnostics reported a selected host/host UDP pair and RTT; cleanup returned both peers to `closed`.
- **Result:** `PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED`.
- **Issues discovered:** Same-host tabs do not reproduce separate NATs, carrier networks, or TURN fallback. The selected host path cannot be generalized to real Internet reachability.
- **Decision:** The accepted WebRTC assumption remains plausible in controlled browser testing. No architecture change or production TURN adoption is required from current evidence.
- **Follow-up:** Independent review of Spike 0.2 before beginning Spike 0.3.

## Spike 0.3 — RTCDataChannel Binary Transfer

- **Objective:** Measure bounded binary transfer behavior and backpressure over RTCDataChannel using synthetic bytes only, without media, file transfer, storage, MSE, synchronization, or Progressive Watch.
- **Architectural question:** Can target browsers move binary chunks reliably without unbounded sender or receiver memory growth?
- **Status:** `PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED`
- **Environment:** `AUTOMATED DESKTOP` on macOS 26.6.2 with two headless Chrome 153.0.8010.53 pages in one throwaway profile on one host, same-origin development signaling, and a host/host UDP selected pair. Physical Android and separate Internet networks were not tested.
- **Procedure:** The isolated experiment in `spike-03-datachannel-binary/` generates deterministic payloads on demand and sends them in framed chunks with event-driven `bufferedAmount`/`bufferedamountlow` backpressure. The receiver verifies each chunk against the deterministic pattern and Web Crypto SHA-256, then releases the payload. A lab matrix covered 1/16/64/128 MiB × 16/64/128/256 KiB, three water-mark settings, and five explicit fault modes, and was executed twice. Cleanup was exercised during and after transfers.
- **Acceptance criteria:** BT-01 through BT-08 pass in the controlled desktop environment. BT-09 remains `DEFERRED-PHYSICAL / EXTERNAL-NETWORK VALIDATION`; therefore the result is provisional rather than full `PASS`.
- **Evidence:** [Spike 0.3 result record](results/spike-03-datachannel-binary.md).
  - Every non-fault transfer up to 128 MiB passed byte-count, sequence, per-chunk SHA-256, pattern, and manifest checks.
  - Max `bufferedAmount` never exceeded the high-water mark plus one frame (about 1.06–1.18 MB for 128 MiB at the 1 MiB mark).
  - All five fault modes were detected.
  - All owned resources were released on close.
- **Result:** `PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED`.
- **Issues discovered:**
  - A 256 KiB payload plus header exceeds Chrome's negotiated 262,144-byte `maxMessageSize` and is rejected before sending.
  - The first 2–4 s of sustained sending on a fresh association is markedly slower (3.4–10.5 MiB/s against about 35 MiB/s warmed).
  - RTCDataChannel gives the receiving application no flow control, so production will need application-level acknowledgements or credits.
  - Same-host throughput is a lab observation only. Headless Chrome required mDNS host-candidate obfuscation to be disabled for the lab run.
- **Decision:** RTCDataChannel remains plausible as the bounded binary transport primitive. No architecture change or ADR modification is required from current evidence.
- **Follow-up:** Independent review of Spike 0.3 before beginning Spike 0.4. Track `DEFERRED-PHYSICAL-003` for real external-network and physical Android validation.

## Spike 0.4 — Browser Storage and OPFS Feasibility

- **Objective:** Determine whether browser storage, primarily OPFS, can receive and temporarily cache large progressively written data without the application holding the whole payload in JavaScript memory. Synthetic bytes only; no media, MP4 parsing, MSE, peer transfer, or Progressive Watch.
- **Architectural question:** Is OPFS, or a justified alternative, usable with large sequential/random-access workloads, resume, and explicit cleanup on target devices?
- **Status:** `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`
- **Environment:** `AUTOMATED DESKTOP` on macOS 26.6.2 with headless Chrome 153.0.8010.53 and a throwaway profile, served from `http://127.0.0.1:4175`. Physical Android and other browsers were not tested.
- **Procedure:** The isolated experiment in `spike-04-browser-storage/` generates deterministic bytes one reused block at a time and writes them to OPFS through `createWritable()`. Separately, it writes through `FileSystemSyncAccessHandle` in a worker. A lab matrix covered:
  - 1 MiB to 1 GiB entries;
  - range and streamed full-file verification;
  - aligned and unaligned resume;
  - write-API visibility and lock semantics;
  - a corruption negative control;
  - simulated-headroom refusal;
  - deletion and **Clear Spike Storage**.

  A reload-persistence entry was verified after `Page.reload`, and `persist()` was requested once. The matrix was run twice.
- **Acceptance criteria:** ST-01 to ST-11 have current controlled-desktop evidence. ST-12 remains `DEFERRED PHYSICAL`, so the result is provisional rather than full `PASS`.
- **Evidence:** [Spike 0.4 result record](results/spike-04-browser-storage.md).
  - 1 MiB, 64 MiB (at 64 KiB, 1 MiB, and 4 MiB blocks), 256 MiB, 512 MiB, and 1 GiB entries passed range and every-byte verification.
  - Resume boundaries at 64 MiB and at 16 MiB + 4,099 bytes were intact.
  - A 64 MiB entry survived a page reload.
  - `estimate()` usage tracked writes to the byte and returned to baseline after deletion.
  - V8 heap stayed ≤ 2.8 MB; transient ArrayBuffer garbage from verification reads was reclaimed by GC.
  - Final OPFS root was empty.
- **Result:** `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`.
- **Issues discovered:**
  - `createWritable()` data is invisible until `close()`, and `abort()` discards it.
  - A `keepExistingData` resume copies the whole existing file: about 1.24 s and +1 GiB usage while open for 1 GiB.
  - `FileSystemSyncAccessHandle` writes in place and lets the main thread read flushed data, but holds an exclusive write lock.
  - 64 KiB writes were about 10× slower than 1 MiB writes.
  - Headless-profile quota was 10 GiB (`usage + 10 GiB`), which is environment-specific.
  - `persist()` resolved `false`.
- **Decision:** OPFS appears viable for later architecture work. It is not selected as the final cache design. No architecture change or ADR modification is required.
- **Follow-up:** Independent review of Spike 0.4 before beginning Spike 0.5. Track `DEFERRED-PHYSICAL-004` for physical Android Chrome storage qualification.

## Spike 0.5 — MP4 Parsing and Segmentation

- **Objective:** Determine whether target MP4/H.264/AAC files can be inspected and segmented for progressive playback. Media preparation only: no MSE, WebRTC, storage, or Progressive Watch.
- **Architectural question:** Can a browser-side parser produce or identify bounded, valid initialization and media segments without unsafe resource use?
- **Status:** `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`
- **Environment:** `AUTOMATED DESKTOP` on macOS 26.6.2 with headless Chrome 153.0.8010.53 and a throwaway profile, served from `http://127.0.0.1:4176`, with MP4Box.js 2.4.1 pinned. Node.js v26.3.0 was used for unit tests and heap measurement. Physical Android, other browsers, and real-world (non-synthetic) media were not tested.
- **Procedure:** The isolated experiment in `spike-05-mp4-segmentation/` reads a locally selected file in bounded `File.slice()` blocks with one read in flight. It runs a header-only box scan and a `moov` budget check before MP4Box.js sees any bytes. It then compares two segmentation strategies:
  - MP4Box.js built-in `onSegment` segmentation;
  - a deterministic time plan derived from the sample tables, cut with `createFragment()`.

  An independent fMP4 verifier checks every init and media segment. The spike also covers `seek()` with and without RAP, planned random access with SHA-256 comparison, unselected-track draining, and non-target and malformed inputs. Synthetic media (1.2 MB to 4.53 GB, `moov` first and last, fragmented, non-target, and malformed) was generated by `tools/make-test-media.sh`. The matrix ran twice.
- **Acceptance criteria:** MP-01 to MP-11 have current controlled-desktop evidence. MP-12 remains `DEFERRED PHYSICAL`, and real-world media coverage is `MANUAL TEST REQUIRED`, so the result is provisional rather than full `PASS`.
- **Evidence:** [Spike 0.5 result record](results/spike-05-mp4-segmentation.md).
  - Every target file parsed and was classified `TARGET COMPATIBLE`. Each produced a verified init segment (1,314–1,325 B) and complete, contiguous, monotonic media segments, with 0 verification problems.
  - A 4.53 GB, 90-minute `moov`-last file had metadata after 7 reads and 7.0 MB. Full passes held at most 6.3 MB of source data in the parser.
  - The planned segment at 45:01 needed 8 reads and 8.7 MB, and it was byte-identical to its sequential cut.
  - Non-target and malformed inputs were classified or refused before parsing.
  - 0 console messages were recorded, and the only network requests were same-origin static files.
- **Result:** `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`.
- **Issues discovered:**
  - MP4Box.js 2.4.1 built-in segmentation with `rapAlignement` ends each video segment on the keyframe, so later segments start one sample after it. Its boundaries also differ after `seek()`.
  - All tracks must share one `nbSamples`.
  - Passing `appendBuffer(buf, true)` produces one-sample segments.
  - Sample-table expansion costs about 343 B of JS heap per sample (142 MB for 90 minutes).
  - An unselected track that is not drained pins the whole file in parser buffers.
  - Already fragmented sources were retained at 2× their size and had only a partial index at `onReady`, so they are classified `NON-TARGET`.
  - MP4Box.js stalls on non-BMFF input and logs some errors to `console.error`.
- **Decision:** MP4Box.js remains a viable candidate through deterministic, index-derived segmentation (`createFragment()`), not its built-in segmenter as-is. No architecture change or ADR modification is required. Observations are recorded in `docs/MEDIA_PIPELINE.md`, separate from planned behavior.
- **Follow-up:** Independent review of Spike 0.5 before beginning Spike 0.6. Track `DEFERRED-PHYSICAL-005` for physical Android Chrome qualification. Real-world media coverage remains `MANUAL TEST REQUIRED`.

## Spike 0.6 — MSE Progressive Playback

- **Objective:** Determine whether compatible MP4 media can play progressively through Media Source Extensions, with initialization and media segments appended over time from a local source. Local media only; no WebRTC, peer transfer, storage, synchronization, or Progressive Watch.
- **Architectural question:** Can target browsers sustain Media Source Extensions playback, buffer growth, and seek-related append transitions for the initial media target, starting before all media is supplied?
- **Status:** `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`. Passed independent re-review after fixes for the B1 and B2 blockers from the first independent review and the B3 blocker from the second; committed at `7bbb10f`. Physical Android remains deferred.
- **Environment:** `AUTOMATED DESKTOP` on macOS 26.6.2 with Chrome 153.0.8010.53 and a throwaway profile, served from `http://127.0.0.1:4177`.
  - Headless for the main matrix, plus one headed smoke run.
  - `--mute-audio`; the autoplay policy was left in force, and playback started from trusted CDP clicks.
  - MP4Box.js 2.4.1 and the Spike 0.5 modules were imported unchanged.
  - Physical Android, other browsers, and real-world media were not tested.
- **Procedure:** The isolated experiment in `spike-06-mse-progressive/` does the following:
  - cuts Spike 0.5 planned, keyframe-aligned fMP4 segments on demand from bounded `File.slice()` windows, and verifies each one;
  - releases them with deterministic arrival profiles (FAST 8×, NORMAL 1.5×, SLOW 0.5×, BURSTY, MANUAL);
  - appends them through a per-SourceBuffer queue that never appends while `updating`;
  - plays through one muxed or two separate SourceBuffers.

  Scripted experiments MSE-01 to MSE-12, plus supplementary S1 to S5 (buffer layout and edit lists, continuity, quota, long run, background tab), were executed by a CDP driver. A development run was followed by two identical final runs.
- **Acceptance criteria:** MSE-01 to MSE-12 have current controlled-desktop evidence. MSE-13 remains `DEFERRED PHYSICAL`, and real-world media is `MANUAL TEST REQUIRED`, so the result is provisional rather than full `PASS`.
- **Evidence:** [Spike 0.6 result record](results/spike-06-mse-progressive.md).
  - **Early start.** Playback began after 2 of 76 segments (MP-02), and after 2 of 2,700 segments on a 4.53 GB, 90-minute file when 0.31 % of it had been read. It continued as withheld segments were released. Presented frames (about 30 fps), advancing `currentTime`, and changing frame digests confirm real playback.
  - **Buffering.** Buffer ahead grew from 8.7 s to the 60 s cap under FAST delivery. SLOW delivery produced 4 `waiting` underruns, each recovering within 10 ms of the next append.
  - **Seeks.** Buffered seeks completed in 11–17 ms. Unbuffered seeks to 180 s, 90 s, 45:01, and 22:30 completed in 15–82 ms after reprioritising one keyframe-aligned segment, with no SourceBuffer reset.
  - **End of stream.** `endOfStream()` after the last `updateend` led to a normal `ended`.
  - **Cleanup.** Reset, replace, MSE-failure, parser-failure, and `pagehide` teardown were all clean.
  - **Unsupported media.** 10 non-target or malformed files were refused before any MediaSource was created.
  - **Health.** 0 console messages and exceptions. Only same-origin static requests.
- **Result:** Controlled-desktop software feasibility passed and was accepted on independent re-review after the B1, B2, and B3 fixes (history retained in the result record). B3: a preparation superseded by a later unbuffered seek was reported as a fatal pipeline failure, leaving the element seeking until reset. Superseded preparation is now cancellation tied to the session, the seek generation, and the dropped slot; genuine preparation errors remain fatal.
- **Issues discovered:**
  - A segment that does not start on a keyframe is accepted **silently**: Chrome drops frames until the next keyframe, and a fragment with no keyframe buffers nothing.
  - Chrome applies source edit lists in MSE.
  - The init segment's `updateend` precedes `loadedmetadata`, and MP4Box.js init segments carry no duration (`Infinity` until set).
  - A muxed SourceBuffer's buffered range is the intersection of its tracks.
  - `QuotaExceededError` occurred at about 159 MB of 720p media when appending ahead with no cap; it clears only after the playhead moves.
  - Chrome fired no `stalled` event for MSE underruns.
  - A never-shown background tab defers `sourceopen` until it is shown, while a hidden playing session keeps playing and appending.
  - `droppedVideoFrames` is unusable under this automation, for native playback too. A/V sync and smoothness were not measured.
- **Decision:** MSE progressive playback of Spike 0.5 planned segments is viable in controlled desktop Chrome. No architecture change or ADR modification is required. Observations are recorded in `docs/MEDIA_PIPELINE.md`, separate from planned behavior.
- **Follow-up:** Independent re-review completed; committed at `7bbb10f`. Track `DEFERRED-PHYSICAL-006` for physical Android Chrome qualification. Real-world media coverage remains `MANUAL TEST REQUIRED`.

## Spike 0.7 — P2P Progressive Media Proof

- **Objective:** Integrate the proven Phase 0 pieces into a minimal peer-to-peer progressive media proof.
- **Architectural question:** Can a receiver begin and continue playback before the complete compatible file arrives while transport, storage, and playback remain bounded and independently observable?
- **Status:** `READY FOR INDEPENDENT RE-REVIEW`. The first independent review returned `REQUEST CHANGES — DO NOT COMMIT` (B1 host scheduling, B2 stale closure docs); both are fixed and re-validated. Software feasibility supports a provisional result; physical Android and external-network validation remain deferred.
- **Environment:** `AUTOMATED DESKTOP / CONTROLLED NETWORK`, macOS 26.6.2, Chrome 153, two same-origin tabs, ignored synthetic MP4/H.264/AAC source. Selected path: host/host UDP. `adb devices` found no attached device.
- **Procedure:** The isolated [experiment](spike-07-p2p-progressive/README.md) combines guarded incremental parse and planned keyframe-aligned cuts, bounded RTCDataChannel chunks with event-driven backpressure, receiver SHA-256 reassembly, MSE appends, buffer feedback/windowing, pacing profiles, temporary hold, and seek generations. All implementation remains under `spikes/phase0/`.
- **Acceptance criteria:** E2E-01–E2E-18 have controlled-desktop evidence, including actual playback at 2 of 76 received segments (3,218,827 B; 2.911789% of source size), further transfer while frames/time advance, ahead buffering, real underrun/recovery, buffered and remote seeks, rapid-seek stress, malformed-message rejection, cleanup, and a fresh run without page reload. E2E-19 is `DEFERRED PHYSICAL / EXTERNAL NETWORK`.
- **Evidence:** [Spike 0.7 result record](results/spike-07-p2p-progressive.md). All Phase 0 Node tests: 120 pass, 0 fail (92 at the initial review; 28 scheduling tests added for B1). The final browser code also evicted isolated old and future MSE ranges outside the experimental window, rejected a malformed frame during valid transfer, and handled overlapping distinct seeks with one receiver channel binding.
- **Result:** Controlled-desktop software feasibility is ready for final independent re-review. B1 fix: host scheduling follows the receiver's current playback need — the first segment missing at the end of the playhead's contiguous run — with every seek starting a new generation, stale needs ignored, a contiguous-only ahead cap, a send-window bound, waiting-triggered need reports, and trimming while stalled. Regressions A and B hung on the pre-fix build in Chrome and pass 4/4 each after the fix. 783 mixed Chrome stress seeks produced 0 permanent hangs and 0 pipeline failures, and the full E2E regression pass succeeded. Do not issue final Phase 0 PASS or production readiness from this evidence.
- **Issues discovered:** Development runs exposed an undefined seek-handler local and concurrent source reads across overlapping seek generations. Both were fixed and retested. Independent review then found B1: a persistent host cursor ignored buffered seeks, so mixed seeks stalled playback permanently. Validating the fix exposed a trimmed-tail need defect, a seek-boundary tolerance hang, a too-wide segment-end tolerance, and a stale `initReady` across sessions; all were fixed with regressions. Sample-index heap, browser MSE/decoder memory, real-world media, Android, and Internet paths remain unqualified.
- **Decision:** No architecture change required from the controlled software proof. OPFS is not integrated; `Spike 0.7 demonstrates bounded streaming pipeline; durable cache integration remains productionization work.`
- **Follow-up:** Final independent re-review of Spike 0.7 and Phase 0 software-feasibility closure. Track `DEFERRED-PHYSICAL-007` alongside `001`–`006`.
