# Spike 0.7 Result — End-to-End P2P Progressive Watch Proof

## Spike

`0.7 — End-to-End P2P Progressive Watch Proof`

## Status

`PROVISIONAL PASS — PHYSICAL / EXTERNAL NETWORK VALIDATION DEFERRED`

The first independent review returned `REQUEST CHANGES — DO NOT COMMIT`. Its blockers, B1 (host scheduling) and B2 (stale Phase 0 closure documentation), were fixed and re-validated; see [Independent Review History](#independent-review-history). Final independent review passed and closed **Phase 0 software feasibility**; see [Final Independent Review](#final-independent-review). All numerical evidence below is `AUTOMATED DESKTOP / CONTROLLED NETWORK` from two same-origin Chrome tabs on one macOS host, using an ignored synthetic FFmpeg MP4. It is not physical Android, separate-NAT, STUN, TURN, or real Internet evidence.

## Final Independent Review

**Verdict:** `PASS — SAFE TO COMMIT AND CLOSE PHASE 0 SOFTWARE FEASIBILITY`.

The exact reviewed Spike 0.7 implementation and regression fixes were committed at `e1ea11b`, and [Phase 0 PR #1](https://github.com/arunachaleswaranms/Driftless/pull/1) merged into `main` at `17eea6a`. Phase 0 software feasibility is closed. No architecture change was required. Physical Android and real external-network qualification remain deferred under `DEFERRED-PHYSICAL-001` through `007`; this review did not establish production readiness or broad browser support.

## Independent Review History

### Initial independent review — `REQUEST CHANGES — DO NOT COMMIT`

The first independent review reproduced the transport, early-playback, backpressure, hold/underrun/recovery, remote-seek, malformed-input, cleanup, and second-run evidence below. It returned `REQUEST CHANGES — DO NOT COMMIT` for two blockers:

- **B1 — host scheduling went stale after buffered/local seeks or rapid mixed seeks.** The host kept a persistent read cursor that moved only on `SEEK_REQUEST`. A seek the receiver could satisfy locally sent the host nothing. After `remote seek → ~43 s` then `local buffered seek → ~24 s`, the host kept streaming sequentially from ~44 s. Playback reached the end of the 0–34 s run and stalled **permanently**. `BUFFER_STATUS` counted received segments as `nextNeededSegment`, so it never named the gap, and the far-future MSE range kept growing. The same class of failure followed `remote seek → 250 s` then, 20 ms later, `local seek → 10 s`.
- **B2 — Phase 0 closure documentation was stale.** Records still showed Spike 0.6 as `READY FOR INDEPENDENT RE-REVIEW` after it had passed re-review and been committed at `7bbb10f`, and `docs/ROADMAP.md` still said Spike 0.3 and later had not started.

This record keeps the original evidence below. Where the fix changed behavior, the change is noted; E2E-12 is one example, because a buffered seek now starts a new generation.

### Reproduction of B1 before the fix

The pre-fix experiment was copied unchanged to a scratch location and served by itself on loopback, then driven in the same Chrome harness as the fixed build (FAST profile, MP-02, two same-origin tabs):

| Scenario (pre-fix build, fresh session) | Outcome |
| --- | --- |
| **A:** playhead 12.02 s, buffered 0–34.017 s; remote seek → 43 s (resolved), then local seek → 24 s | **Permanent stall.** `currentTime` stuck at 33.946 s for over 15 s at the old buffer end. The host sent segments 14 → 57 sequentially from its cursor and never segment 9 (34.03 s). Final ranges were 14.0–34.0, 43.0–55.0, and 57.8–228.2 s, with up to 182.3 s of disjoint far-future media retained (202.4 s total buffered) and 80.8 MB sent. |
| **B:** playhead 12.0 s, buffered 0–34.017 s; remote seek → 250 s, then 20 ms later local seek → 10 s | **Permanent stall** at 33.941 s. The host kept serving the obsolete remote target: segments 62 → 75 (250–300 s), which the receiver trimmed. Segment 9 was never requested. |

The same scenarios were repeated in a second session in the same tabs. They did not reproduce B1 there, but only because a separate pre-existing defect (stale `initReady`, below) left `MediaSource.duration` unset in second sessions, so the 43 s and 250 s seek targets clamped to about 34 s. Those runs are not valid reproductions and are not counted as passes of the old code.

### B1 fix — scheduling follows the receiver's playback need

Only the host transfer scheduling and the receiver's need reporting and MSE window changed. The transport framing, reassembly, integrity checks, append queues, signaling, and single-reader cut ownership are unchanged. The decision logic is in [`src/scheduling.mjs`](../spike-07-p2p-progressive/src/scheduling.mjs):

- **Playback need.** The receiver reports the segment at the **contiguous frontier**: the end of the buffered range that contains `currentTime`, or `currentTime` itself when it is unbuffered. It maps that time to a segment index using the plan start/end times learned from validated `PART_INFO` declarations. A segment whose tail is missing is the need even when most of it is buffered. A segment on a disjoint range is never counted. `BUFFER_STATUS` now carries `generation`, a session-monotonic `seq`, `currentTime`, `playheadBuffered`, `contiguousBufferedEnd`, `contiguousAhead`, `firstMissingSegment` (or `null`, which lets the host map `needTime` through its own index), `needTime`, and a `reason`. The received-segment count is gone.
- **Generation ownership.** Every seek, local or remote, increments the receiver's intent generation, because a buffered seek also changes what should be sent next. The host rejects any need or seek whose generation is older than its current one or whose `seq` is not newer, even though the channel is ordered. A newer generation aborts the old loop, joins its cut, and starts scheduling from the new need. Old-generation chunks are still dropped on receipt, so a buffered seek can discard at most one in-flight part. The latest valid intent wins.
- **Host retargeting.** The host no longer keeps a read position of its own. Each loop iteration asks the scheduler, which rebases its cursor on every accepted need, moving forward or back. Inside one generation, the in-flight segment finishes and the cursor then follows the newest need. The cursor advances optimistically past a delivered segment only if no newer need rebased it during delivery.
- **Local buffered seek.** The media element seeks immediately. The receiver recomputes the need, sends it with the new generation, and the host retargets. Stale far-ahead work stops.
- **Waiting recovery.** A `waiting` event immediately sends a forced need, and the window may trim. A forced need identical to one sent in the last 100 ms is suppressed. Unchanged needs are otherwise sent at most every 200 ms, and a changed need is sent at once.
- **Ahead cap.** The 20 s cap counts only `contiguousAhead`, the buffered run in front of the playhead, so a disjoint far range cannot satisfy it. As a separate bound, the host never sends a segment that starts more than 20 s past the playhead it was last told about. It also stops re-sending a segment after three deliveries in one generation, so a gap that cannot be filled never turns into a transfer loop.
- **MSE window.** The playhead-movement precondition is gone, so trimming also works while playback is stalled. It keeps `[floor(t − 30), max(ceil(t + 30), contiguousBufferedEnd)]` and never removes the playable run. It does nothing while `seeking`, which protects a pending seek target. Back trims wait for 10 s of hysteresis; future trims fire once media extends more than 1 s past the window.

Four further defects surfaced while validating the fix in Chrome. Each was fixed and has a regression:

1. **Trimmed-tail segment (first-pass need model).** The first version counted a recorded segment as available while MSE still buffered its midpoint. A future trim at `ceil(t + 30) = 279 s` cut the tail (279.0–279.667 s) off segment 70 while it was disjoint. Later the contiguous run reached 279.0 s. The need named segment 71, which cannot fill that gap, and the host redelivered 71 repeatedly: 1 of 21 gap-crossing checks in the first Chrome stress run stalled at 278.946 s, with 33 redeliveries. The contiguous-frontier definition and the per-segment delivery limit replaced it.
2. **Seek just before a segment boundary.** A remote seek to 107.32 s, 0.08 s before a boundary at 107.40 s, fell inside the 0.1 s tolerance. The need treated the preceding segment as complete and asked for the next one, and the tolerance then reported the target as buffered, so the host held at the ahead cap. Chrome does not resolve a seek whose target is before the buffered start, so the element stayed `seeking` (1 hang in the second Chrome stress run). While seeking, both the local/remote decision and the need now require strict containment. The start tolerance stays only for normal playback.
3. **Segment-end tolerance too wide.** In the post-fix regression pass, a lab eviction of [157, 162) s cut only the last 67 ms of segment 39 (153.267–157.067 s), exactly two 30 fps video frames. The frontier at 157.000 s was within 0.1 s of 39's end, so 39 was treated as complete and the need named 40. The host re-sent 40 three times, the delivery limit then stopped it (so the limit bounded the transfer, as designed), and playback stalled at 156.938 s. The need now has its own 40 ms segment-end tolerance. That is larger than Chrome's audio/video intersection shortfall (6–16 ms here, e.g. a 34.017 s run end against a 34.033 s segment end) and smaller than two video frames. The 0.1 s tolerance remains only for locating the playhead in a range.
4. **Stale `initReady` across sessions (pre-existing).** `initReady` was never reset between sessions, so the second session in the same tabs never set `MediaSource.duration`. Every seek in that session clamped to the buffered end of about 34 s; a "seek to 250 s" became 34.017 s. It is now reset in `start()`. The earlier E2E-17 evidence did not seek in its second run.

### New and updated tests

The Phase 0 Node suite now has **120 tests, 0 failures** (5 + 5 + 10 + 9 + 18 + 42 + 31 for Spikes 0.1–0.7). Spike 0.7 adds 28 scheduling tests:

- `scheduling.test.mjs` (10 unit tests):
  - the reviewer's disjoint example (14–34 s plus 58–300 s at 24 s gives 10 s ahead, not 276 s, and a need of about 34 s);
  - eviction, completion, and the no-record fallback;
  - the trimmed-tail, seek-edge, and 67 ms-tail/16 ms-shortfall geometries from Chrome;
  - stale generation and sequence rejection, and invalid need fields;
  - the contiguous ahead cap and the send-window bound;
  - cursor rebasing and the delivery limit;
  - MSE trimming while stalled, playable-run protection, and seeking;
  - reporter rate limiting and sequence numbering.
- `scheduling-sim.test.mjs` (18 tests) is a deterministic discrete-event host/receiver model with ordered channels, append latency, pacing, a strict Chrome-style seek resolution, and the host's asynchronous restart after a generation change. The fixed policy runs the real `scheduling.mjs`. The legacy policy reproduces the pre-fix cursor, remote-only generations, count-based need, and movement-gated trim. It covers:
  - Regression A, Regression B, and a no-seek waiting gap (browser-style eviction, with periodic status disabled so only `waiting` can report it). Each must pass with the fix and **must fail with the legacy policy**: the legacy runs assert a permanent stall, and for A a disjoint range above 100 s.
  - Mixed `remote→local`, `local→remote`, `remote→local→remote`, and `remote→remote→local` patterns, each rapid (20 ms) and spaced (3 s).
  - The trimmed-tail case and the seek just before a boundary.
  - A seeded 300-seek mixed stress (0 hangs; host send-ahead ≤ 20 s).
  - Steady playback: cap waits, total transfer tracking the playhead, 0 redeliveries, and hold → real underrun → recovery.
- The development defects are discriminated as well. Against the first-pass midpoint need model, the trimmed-tail and seek-edge simulations fail. Against the tolerant model, the seek-edge unit test, the seek-edge simulation, and the seeded stress fail.

### Chrome reproduction and stress after the fix

All runs used the final build: Chrome 153, MP-02, FAST profile, two same-origin tabs, host/host UDP. Each reproduction ran four times, run 0 in fresh tabs and runs 1–3 as close/restart cycles in the same tabs.

| Check | Result |
| --- | --- |
| **Reproduction A** (4/4 pass) | Initial buffer 0–34.017 s at 12.0 s; remote seek → 43 s resolved; local seek → 24 s. The host retargeted at once (`retarget` to segment 9, reason `local-seek`, generation 2). Its first cuts after the local seek were segments 9 and 10 (34.03–42.97 s). The need then jumped to 14, because 11–13 were already buffered from the remote seek. Playback crossed the old 34.017 s stall point about 11.15 s after the local seek and reached 49.1 s. There was no permanent `waiting`; disjoint retained media peaked at 8.81 s (182.3 s before the fix) and total buffered at 57.7 s. |
| **Reproduction B** (4/4 pass) | Remote seek → 250 s, then 20 ms later local seek → 10 s. The host had just started segment 62 (generation 1); the generation-2 need (segment 9, `local-seek`) aborted it. Every later cut was 9, 10, 11, … and 5–9 stale chunks were dropped. Playback crossed 34.017 s at about 35.1 s and reached 49.1 s. Nothing from the 250 s target was retained, and the final range was 11.0–71.7 s. |
| **Mixed-seek stress** (3 seeds, **783 seeks**) | 260 + 260 + 263 seeks in 114 + 114 + 115 bursts: 396 buffered and 387 unbuffered targets. Burst shapes were single, rapid pairs, triples, and mixed buffered/unbuffered bursts, spaced 0/5/20/60 ms. 334 bursts were issued with the host inside an open `bufferedamountlow` wait (backpressure), 76 right after a SourceBuffer `updating` was observed, and 94 during an in-progress reassembly (transport active). Every fifth burst was followed by a local seek to 2 s before the contiguous end, which had to be crossed. |
| Permanent hangs | **0** (0/343 bursts unconverged; 63/63 gap crossings succeeded). |
| Pipeline failures | **0**; both peers stayed `connected`/`open`, queues `idle`, and 0 rejected frames. |
| Stale chunks dropped | 779 / 763 / 776 per seed. |
| Stale need messages ignored | 0 in stress: the ordered channel never delivered one. In the E2E pass, 3 injected older-generation or older-sequence needs were ignored and 3 invalid needs rejected, with the host generation and cursor unchanged. |
| Host retargets | 269 / 269 / 270, with 260 / 260 / 263 generation changes. |
| Redeliveries / delivery-limit waits | 0 / 0 in every seed. |
| Max transport queue | 1 part. |
| Max RTC `bufferedAmount` | 589,856 B, exactly the 512 KiB high-water mark plus one 65,568 B frame. |
| Max host send-ahead | ≤ 20.0 s past the last reported playhead. The send-window bound engaged 2 / 0 / 0 times. |
| Max contiguous ahead | 36.2–52.6 s sampled (receiver max 53.2 s). This is only after backward buffered seeks turned retained history into ahead coverage; the host itself never added media beyond the 20 s cap. |
| Max disjoint retained | 19.8–24.7 s sampled; receiver maximum 56.3–60.9 s, briefly during unbuffered seeks while the old run sits behind the new target. Max total buffered 60.4–62.9 s. |
| Runaway transfer | **None.** About 575–585 MB were sent per seed (source 110.5 MB): about 20 s of refill per unbuffered seek, never beyond the cap. |
| Console | One pre-existing CSP error per page (inline `<style>` blocked by `style-src 'self'`). No exceptions and no other errors. |
| Cleanup after stress | Both peers `clean: true`. |

The first Chrome stress run of the first-pass fix exposed the trimmed-tail defect (1 crossing failure). The second exposed the seek-boundary hang (1 hang). The first full regression pass exposed the segment-end tolerance defect. All three were fixed before the runs above; the seeds that triggered the first two (20260927, 424242) are included.

**Post-fix E2E regression pass** (one session plus a second run in the same tabs; all checks pass):

- **Peer and handshake.** Peers connected over host/host UDP, and the receiver had no file selected. `MEDIA_INFO` matched: 300.023 s, 110,544,641 B, AVC/AAC 1280×720, 76 segments. Video init (756 B) and audio init (725 B) appended before segment 0.
- **Early playback.** `playing` fired at 2/76 segments, 3,218,827 B (**2.911789%** of the source), with 8.730701 s buffered.
- **Concurrent transfer.** Frames rose from 4 to 63 in 2 s. Over 5 s, time went from 1.95 to 6.95 s while transferred bytes rose from 3,218,827 to 5,137,871 B and segments from 2 to 4.
- **Ahead cap.** Contiguous ahead reached 20.3 s; the host recorded cap waits and a maximum send-ahead of 19.93 s.
- **Backpressure.** Peak `bufferedAmount` was 589,384 B, with 83/83 pauses/resumes and a maximum transport queue of 1.
- **Hold, underrun, recovery.** During hold, host bytes stayed constant and non-seeking `waiting` occurred at 65.754 s (buffer end 65.829 s, `readyState` 2). The waiting need was an exact repeat of the host's current need, so it was suppressed as designed. Resume → `playing`, `readyState` 4, time advancing.
- **Constrained pacing.** Further real `waiting`/recovery occurred; a waiting-triggered need was sent at 76.778 s (`firstMissingSegment` 21).
- **Buffered seek.** A seek to 80.7 s completed locally with no `SEEK_REQUEST`, moved to generation 1, and the host cursor followed the new need.
- **Remote seek.** A seek to 150 s used generation 2 and host segment 38, and resumed at 151.4 s.
- **Waiting gap without a seek.** A lab removal of [157, 162) s from both SourceBuffers, simulating browser eviction, left 147.17–157.0 s and 162.6–169.3 s. The receiver's need moved back to segment 39, the host retargeted in the same generation, and playback crossed the former gap to 164.06 s.
- **Malformed input.** 13 malformed control/binary inputs were rejected (oversize declaration, impossible chunk count, wrong transfer, invalid segment, future generation, invalid JSON, oversized control, oversize frame, duplicate chunk, out-of-range and mismatched chunk identity, wrong length, and a digest-valid non-fMP4 part). Reassembly was left empty and the session `connected`. Valid segments continued afterwards.
- **Cleanup.** Both peers reported `clean: true`. Receiver state was cleared: MediaSource, buffers, URL, `src`, scheduler, segment-time map. Host state was cleared: parser, peer, scheduler; loop aborted; 0 active parts.
- **Second run.** It used a new transfer ID and played at 2 segments / 2.911789%. `MediaSource.duration` was 300.023 s, fixing the second-session defect, and an unbuffered seek to 250 s resolved at 250.01 s and advanced. It closed clean.

### B2 documentation corrections at the pre-final-review checkpoint

- Spike 0.6's result record, tracker entry, and `PROJECT_STATE.md` now record `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`: passed independent re-review and committed at `7bbb10f`. The B1/B2/B3 review failures remain in its history.
- At that checkpoint, `docs/ROADMAP.md` recorded Spikes 0.1–0.6 as complete and checkpointed, Spike 0.7 as `READY FOR INDEPENDENT RE-REVIEW`, and Phase 0 software closure as pending. The deferred debt was open.
- At that checkpoint, `spikes/phase0/README.md` gained a Phase 0 status table, and `PROJECT_STATE.md` named Spike 0.7's final independent re-review as the current activity. The current status has since been updated after the final PASS and PR merge.

## Architecture

The experiment is isolated under `spikes/phase0/spike-07-p2p-progressive/` and keeps the planes separate:

1. **Development signaling — EXPERIMENT ONLY:** `BroadcastChannel` carries offer/answer and ICE for exactly one host and one receiver. It carries no media.
2. **Host preparation and transfer:** the host owns the local `File`. Spike 0.6's preparer reuses the Spike 0.5 guarded incremental parse, deterministic keyframe-aligned plan, bounded `File.slice()` reads, and independent fMP4 verification. The host sends `MEDIA_INFO`, per-track init, then on-demand video/audio fragments as 64 KiB binary payload chunks over one ordered RTCDataChannel. It waits for a receiver append acknowledgement per part and uses Spike 0.3's event-driven `bufferedamountlow` backpressure waiter.
3. **Receiver reassembly and playback:** the receiver has no source file. It validates one declared part at a time (transfer, generation, segment, track, chunk count, byte count, sequence, SHA-256, fMP4 structure). It then appends to two MSE SourceBuffers through Spike 0.6 append queues. Startup is after two complete segments, with a trusted click for playback. `BUFFER_STATUS` reports the receiver's current playback need: generation, sequence, playhead, the contiguous buffered run ahead of it, and the first segment missing at that run's end. The host schedules only from that need, under a 20 s cap on *contiguous* coverage. MSE removes ranges outside an approximate ±30 s playhead window, never the playable run, including while stalled.

Seek generation is owned by the receiver, and every seek (local or remote) starts a new one. For an unbuffered seek the host maps the requested time to the Spike 0.5 index; for any newer generation it aborts old transport work, **joins the old source read**, and schedules from the new need. Stale chunks cannot enter the new generation's reassembly, and older-generation or older-sequence needs are ignored. The frame/control format and all thresholds are lab-only.

## Test Results

After the B1 fix the full Phase 0 Node suite passes **120 tests, 0 failures**, including 28 new Spike 0.7 scheduling tests (see [New and updated tests](#new-and-updated-tests)). At the initial review it was 92 tests (5 + 5 + 10 + 9 + 18 + 42 + 3). Spike 0.7's three original unit tests cover bounded frame/part reassembly, missing and duplicate chunks, declared sizes, transfer/generation identity, frame corruption, SHA-256 mismatch, and duplicate offer/channel ownership. `node --check` passed for every Spike 0.7 module. Actual Chrome MSE/WebRTC validation, not Node fakes alone, supplies the integration evidence below.

| Case | Controlled-desktop result | Evidence |
| --- | --- | --- |
| E2E-01 Peer connection | PASS | Both `RTCPeerConnection`s and data channels reached `connected` / `open`. |
| E2E-02 Media handshake | PASS | Receiver received the 300.023 s, 110,544,641 B, AVC/AAC, 1280×720, 76-segment metadata with matching transfer ID. |
| E2E-03 Init transfer | PASS | Video 756 B and audio 725 B arrived, passed validation, and appended before media; MSE duration became 300.023 s. |
| E2E-04 First fragments | PASS | Segment 0/1 binary parts reassembled, SHA-256 verified, structurally checked, and appended; `video.buffered` reached 8.730701 s. |
| E2E-05 Early playback | PASS | `playing`, 30–55 presented frames, and advancing `currentTime` after only 2/76 segments and 2.91% source-equivalent payload. |
| E2E-06 Concurrent transfer/playback | PASS | One run advanced `currentTime` to 12.499501 s and 383 frames while received segments grew from 6 to 9 and transport bytes continued rising. |
| E2E-07 Ahead buffer | PASS | Buffered ahead grew from 8.73 s at start to >20 s under continued delivery; the host recorded ahead-cap waits (38 in a longer run). |
| E2E-08 Backpressure | PASS | 64 KiB payload + 32 B header; peak `bufferedAmount` 589,416 B in the longer run, below the 512 KiB high-water mark plus one 65,568 B frame (589,856 B). 103 pauses / 91 resumptions were counted; superseded waits explain the difference. The host schedules one part at a time. |
| E2E-09 Slowdown | PASS | Changing NORMAL 1.5× to CONSTRAINED 0.4× preserved state/integrity and led to repeated real waiting/recovery. These factors are simulations only. |
| E2E-10 Underrun | PASS | During host hold, `currentTime` stopped at 8.645085 s with buffer end 8.730701 s, `readyState` 2, `waiting`, 0.085616 s ahead, and `seeking: false`. |
| E2E-11 Recovery | PASS | Host resume delivered segment 2, buffer end grew to 10.983037 s, `playing` fired, `readyState` returned to 4, and time later advanced to 13.324663 s with 407 frames. |
| E2E-12 Buffered seek | PASS | Seek inside 0–42.956915 s to 5 s completed with `seeking: false` and no generation change (pre-fix build). After the B1 fix a buffered seek still completes locally with no `SEEK_REQUEST`, but it deliberately starts a new generation so the host retargets; see the post-fix regression pass. |
| E2E-13 Remote future seek | PASS | Seek to 150 s requested generation 1; host mapped it to segment 38, receiver buffered 147.166666–153.251699 s, cleared `seeking`, and resumed at 150 s. |
| E2E-14 Rapid seek stress | PASS | Overlapping seeks reproduced and fixed a concurrent source-read race. In the final one-shot channel build, a 25 ms-spaced six-target burst requested 260, 20, 180, 60, 240, then 85 s (generations 14–19); 50 stale chunks were dropped, `seeking` cleared, and playback advanced past 88 s at the final target. The only rejection in that run was the deliberately injected invalid frame. |
| E2E-15 Pause with buffer | PASS | With transfer held at 3,218,827 B and 2 segments, playback advanced from 2.551468 s to 8.645085 s and 260 frames before starvation; host bytes stayed constant. |
| E2E-16 Cleanup | PASS | Both peers reported `closed`; receiver MSE `closed`, both append queues `closed`, URL revoked, file/parser/reassembly/queues released. |
| E2E-17 Second run | PASS | Both same tabs restarted without refresh. Fresh transfer ID 2,917,573,360, metadata, init, 2-segment early playback, advancing frames, hold/underrun/recovery, and clean second teardown were observed. |
| E2E-18 Invalid message | PASS | Host injected a 4 B invalid binary frame. Receiver recorded `rejected: 1`, reason `frame size`; subsequent segments continued arriving and an unbuffered seek still played. Unit negatives cover metadata/sequence/digest. |
| E2E-19 Physical/external | DEFERRED PHYSICAL / EXTERNAL NETWORK | No device attached; no separate-network, STUN, or TURN run. |
| E2E-20 Mixed-seek scheduling (B1) | FAIL at initial review → PASS after fix | Regressions A/B, mixed-seek patterns, waiting-gap recovery, and 780+ Chrome stress seeks; see [Chrome reproduction and stress after the fix](#chrome-reproduction-and-stress-after-the-fix). |

## Browser Integration Evidence

Chrome 153 on macOS 26.6.2, two tabs in one ordinary Chrome profile, served from `http://127.0.0.1:4178`; same-origin static files only. The ignored synthetic source was `mp02-typical-720p-moov-last.mp4` (MP4/H.264 High + AAC, `moov` last). The receiver selected no file. Browser autoplay policy remained enabled; **Play receiver** was clicked. Development runs exposed an undefined local in the seek handler, concurrent host source reads, and duplicate receiver channel binding. Each was fixed and retested in Chrome. The final run had exactly one `channel-open` event and zero unsolicited rejects before malformed-frame injection.

### Peer connection and media handshake

Both peers reached `connected` and opened the ordered `media` channel. The selected pair reported **host/host over UDP**, with 0–1 ms reported RTT in these local runs. The negotiated message limit was checked before sending frames. `MEDIA_INFO` carried transfer ID, 300.02321995464854 s duration, 110,544,641 B source size, `avc1.64001f`, `mp4a.40.2`, 1280×720, plan version 1, and 76 segments. Fresh runs used different transfer IDs.

### Init, chunking, reassembly, and playback

Receiver events showed video init appended at 756 B, audio init at 725 B, then `init-ready`; only afterward did segment 0 arrive. The receiver accepted no media append before both init parts. The host's validated fragments were split into 65,536 B payload chunks with 32 B headers; each part declaration included expected bytes/chunks and SHA-256. Receiver promoted a part only after exact chunk count, exact bytes, and hash matched. The largest observed held reassembly part was 2,382,977 B. A final-run host snapshot showed 383 chunks, 23,952,194 B sent, peak RTC buffered amount 589,084 B, 39 backpressure pauses and 38 resumes; the one open wait at sampling accounts for the difference. No full-file transport queue was created.

### Early playback and concurrent delivery

The strongest early-playback capture was:

| Measure | Actual |
| --- | ---: |
| Source size | 110,544,641 B |
| Source duration | 300.02321995464854 s |
| Planned segment count | 76 |
| Complete segments when `playing` fired | 2 |
| Receiver payload bytes including init | 3,218,827 B |
| Payload bytes / source size | 2.911789% |
| Buffered seconds at start | 8.730701 s |
| `currentTime` at first `playing` | 0 s |

The receiver then showed 30–55 presented frames and advancing time. In a longer run, time advanced to 12.499501 s and 383 frames while the receiver went from 6 to 9 segments and the host continued sending. Actual decoded-frame evidence is from Chrome's `totalVideoFrames`; audible A/V sync and smoothness were not measured.

### Buffer growth, slowdown, underrun, recovery, and pause

The receiver reported growing buffered ranges; the host used feedback and recorded 38 ahead-cap waits in a longer run. Under CONSTRAINED 0.4× pacing, non-seeking `waiting` occurred at 162.521806 s with `readyState` 2, buffer end 162.586121 s, and 0.064315 s ahead. New media appended; `playing` recurred at 162.581787 s and `readyState` 4 (10,561 ms measured from waiting, including the deliberately slow delivery). Another constrained stall at 166.149122 s recovered after 5,516 ms. These are simulation outcomes, not network performance estimates.

The separate hold test showed the value of existing buffer directly: host payload bytes remained at 3,218,827 while receiver time advanced from 2.551468 to 8.645085 s. It then fired non-seeking `waiting` at buffer end. After **Resume**, the buffer expanded, `playing` fired, and current time advanced beyond 13 s. The recorded 14,967 ms waiting-to-playing interval includes the intentional hold before Resume, so it is not network recovery latency.

### Buffered and remote seek; stress

A seek to 5 s inside a buffered range completed locally. A future seek to 150 s raised generation 1, caused the host to select segment 38 from its index, and resumed at 150 s after that segment arrived. The initial stress run exposed the host's concurrent-reader race (`Reader allows one read in flight`); the fixed host now joins the prior cut before another generation reads. In the final build, six 25 ms-spaced distinct future seeks reached generation 19, discarded 50 stale chunks, and left `state: connected`, `seeking: false`, with time progressing from the latest 85 s target. A separate peer-ownership test verifies duplicate offers and data-channel events do not bind twice.

### Memory, buffer window, and cleanup

The host prepares one segment/part at a time: observed largest prepared segment 2,495,134 B, largest source read 2,526,143 B, parser stream/sample payload 0 B at a sampled point, and no whole-file read. The MP4Box.js sample tables remain in host heap for indexing; exact heap size was **not measured** in Spike 0.7. The RTC send queue has a 512 KiB high-water mark plus at most one frame. Receiver reassembly owns one part and releases it after MSE append. It retains no full-file JavaScript copy. MSE maintains approximately 30 s behind and 30 s ahead of the playhead; a final run showed old 0–8.73 s media removed after seeking to 180 s, then isolated 179.67–187.85 s future media removed after seeking back to 110 s. Browser internal MSE/decoder memory was not measured.

The receiver and host each closed the RTCDataChannel and `RTCPeerConnection`; receiver SourceBuffers/queues and MediaSource closed, object URL was revoked, parser/sample buffers and reassembly state were dropped. Both reported `clean: true`. A fresh run in the same tabs used a new transfer ID, played from two segments, and closed cleanly again. In that second run, host hold froze sent payload at 5,137,871 B while playback advanced to non-seeking `waiting` at 13.871602 s, buffer end 13.955191 s, and `readyState` 2; host resume appended segment 4, `playing` recurred, and time advanced past 20 s with 618 frames. The measured 19,259 ms waiting-to-playing interval includes the intentional hold.

`Spike 0.7 demonstrates bounded streaming pipeline; durable cache integration remains productionization work.` OPFS was deliberately not integrated because the one-part receive window and bounded MSE window suffice for this feasibility proof. Long-run and mobile memory measurements remain open.

## Security / Robustness Findings

- No server-side media storage, upload endpoint, analytics, telemetry, cloud cache, or arbitrary filesystem write exists in the experiment. The local filename is never sent in `MEDIA_INFO`; diagnostics use text rendering.
- `connect-src 'none'` prevents page-origin network fetches; media uses only the page's MSE `blob:` URL. BroadcastChannel is development signaling only.
- Transfer/segment/track/generation identifiers, declared sizes and counts, sequence bounds, duplicate chunks, exact bytes, SHA-256, and fMP4 structure are checked. A 4 B invalid frame was rejected during a live transfer without stopping valid subsequent delivery. Unexpected binary/control data cannot request an unbounded allocation through the one-part cap.
- The remote peer is treated as untrusted despite WebRTC encryption. This laboratory schema is not a production protocol review; malicious-peer fuzzing and authentication remain future work.

## Physical / External-Network Evidence and Debt

`adb devices` listed **no attached devices**. The test used only host/host UDP on one machine. No real external network, independent NAT, physical Android, STUN traversal, or TURN relay was validated.

- `DEFERRED-PHYSICAL-001` — Spike 0.1 Android local media.
- `DEFERRED-PHYSICAL-002` — Spike 0.2 Android/external-network WebRTC.
- `DEFERRED-PHYSICAL-003` — Spike 0.3 Android/external-network binary transfer.
- `DEFERRED-PHYSICAL-004` — Spike 0.4 Android OPFS/storage.
- `DEFERRED-PHYSICAL-005` — Spike 0.5 Android MP4 parsing/segmentation.
- `DEFERRED-PHYSICAL-006` — Spike 0.6 Android MSE playback.
- `DEFERRED-PHYSICAL-007` — Spike 0.7 end-to-end Progressive Watch on physical Android / real external networks.

## Risks / Issues

- Only one synthetic compatible source and desktop Chrome were used in this integrated run. Real-world MP4s, other browsers, Android, real networks, and relay paths remain unqualified.
- The host retains the MP4 sample index. Previous Spike 0.5 sample-table heap cost remains a mobile risk; Spike 0.7 did not remeasure it.
- Browser-managed MSE/decoder memory and CPU were not directly measured. The receive/transport application working sets and buffer window are bounded by design and observed state, but that is not a device memory guarantee.
- The experimental one-part acknowledgement loop sacrifices throughput to bound receive state. Production transfer scheduling, persistence, reconnect, and authentication need later design; this spike does not approve them.
- During development, the seek event handler, concurrent-read generation handoff, and duplicate receiver channel binding failed in real Chrome. All were fixed and retested before final independent review.
- The B1 fix changed scheduling semantics. The trimmed-tail, seek-boundary, and segment-end tolerance defects found while validating it show that the need model is sensitive to segment boundaries, MSE trim edges, and time tolerances. The deterministic simulation uses uniform 4 s segments; Chrome covered only one synthetic source's real boundaries.
- Receiver generations now advance on every seek, so a buffered seek can discard one in-flight part (up to about 2.5 MB here) that is then re-sent. This trades throughput for unambiguous intent ownership, which suits a feasibility proof but is not a production choice.
- Heavy seek stress transfers far more than the source size (about 580 MB in 260 seeks on a 110.5 MB file), because each unbuffered seek refills about 20 s ahead. Per-seek transfer stays bounded by the ahead cap; a production cache would avoid re-sending media the receiver already holds.
- Pre-existing and unchanged: each page logs one CSP console error, because the inline `<style>` in `index.html` is blocked by `style-src 'self'`. Layout falls back to browser defaults. No other console errors or exceptions occurred.

## Architecture Impact

`No architecture change required` from the controlled software proof. The B1 fix changes only experimental scheduling inside the accepted separation of signaling, transfer, and playback. It confirms, as an input to later buffer-manager design, that transfer priority must be driven by the receiver's contiguous playback need, not by a sender-side position. The accepted P2P-first, separate signaling/transfer/playback, compatible-MP4 architecture remains plausible. Phase 0 software feasibility is closed; remote Internet and physical Android behavior remain unqualified.

## Git Status

Historical milestone: the reviewed Spike 0.7 implementation, B1 scheduling fix, tests, and B2 documentation corrections were committed at `e1ea11b` on `phase/0-feasibility`, then merged to `main` through PR #1 at `17eea6a`. Ignored test media was not tracked. No production directory was modified by the milestone.

## Next Step

`Phase 1 — Application Foundation: NEXT — NOT STARTED.` Physical and real-network qualification debt remains open.
