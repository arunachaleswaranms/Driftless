# Phase 0 Experiment Framework

Phase 0 exists to prove or disprove Driftless's riskiest architectural assumptions before production application work begins. All code and evidence here are experimental. A successful spike is not a product support claim, and Phase 0 does not authorize Phase 1.

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

- **Objective:** Evaluate browser-local storage for large received media data.
- **Architectural question:** Is OPFS, or a justified alternative, usable with multi-GB sequential/random-access workloads and explicit cleanup on target devices?
- **Status:** `NOT STARTED`
- **Environment:** Planned Tier 1 desktop and physical Android Chrome with recorded quota, available storage, persistence, and lifecycle conditions.
- **Procedure:** Not executed. A later spike must measure bounded writes/reads, quota estimation, errors, cleanup, restart behavior, and eviction risk without assuming reported capacity is guaranteed.
- **Acceptance criteria:** Storage behavior, resource use, cleanup, and failure handling are reproducible and sufficient to make an architecture decision.
- **Evidence:** None.
- **Result:** `NOT TESTED`.
- **Issues discovered:** None; investigation has not begun.
- **Decision:** Pending; OPFS remains a candidate, not a selection.
- **Follow-up:** Define representative data sizes and device conditions before execution.

## Spike 0.5 — MP4 Parsing and Segmentation

- **Objective:** Determine whether target MP4/H.264/AAC files can be inspected and segmented for progressive playback.
- **Architectural question:** Can a browser-side parser produce or identify bounded, valid initialization and media segments without unsafe resource use?
- **Status:** `NOT STARTED`
- **Environment:** Planned Tier 1 browsers with representative compatible, malformed, and unsupported media.
- **Procedure:** Not executed. A later spike must evaluate parser maintenance/security, track and codec inspection, fragmentation, segment mapping, malformed input, and memory behavior.
- **Acceptance criteria:** Representative target media yields verifiably usable segment metadata; unsupported/malformed inputs fail safely; parser and resource risks are recorded.
- **Evidence:** None.
- **Result:** `NOT TESTED`.
- **Issues discovered:** None; investigation has not begun.
- **Decision:** Pending; MP4Box.js remains an investigation candidate only.
- **Follow-up:** Select lawful, non-sensitive media cases without committing large fixtures.

## Spike 0.6 — MSE Progressive Playback

- **Objective:** Test playback from incrementally appended MP4 initialization and media segments.
- **Architectural question:** Can target browsers sustain Media Source Extensions playback, buffer growth, and seek-related append transitions for the initial media target?
- **Status:** `NOT STARTED`
- **Environment:** Planned Tier 1 desktop and physical Android Chrome with exact codec strings and browser/device versions recorded.
- **Procedure:** Not executed. A later spike must append valid fragments incrementally, observe SourceBuffer state and quota behavior, continue playback as data arrives, and exercise defined errors.
- **Acceptance criteria:** Progressive append and playback work under recorded target conditions with bounded resource use and clear unsupported/error behavior.
- **Evidence:** None.
- **Result:** `NOT TESTED`.
- **Issues discovered:** None; investigation has not begun.
- **Decision:** Pending; API presence alone is insufficient.
- **Follow-up:** Execute only after Spike 0.5 produces validated segment inputs.

## Spike 0.7 — P2P Progressive Media Proof

- **Objective:** Integrate the proven Phase 0 pieces into a minimal peer-to-peer progressive media proof.
- **Architectural question:** Can a receiver begin and continue playback before the complete compatible file arrives while transport, storage, and playback remain bounded and independently observable?
- **Status:** `NOT STARTED`
- **Environment:** Planned real desktop-to-physical-Android test across different networks, with direct/TURN path recorded.
- **Procedure:** Not executed. A later spike must combine only evidence-backed mechanisms from Spikes 0.2–0.6 and test startup, continued delivery, interruption, and a not-yet-buffered seek.
- **Acceptance criteria:** Initial playback begins before complete transfer; delivery continues with backpressure; seek prioritization and failure behavior are demonstrated; real-device/network/resource evidence is recorded.
- **Evidence:** None.
- **Result:** `NOT TESTED`.
- **Issues discovered:** None; investigation has not begun.
- **Decision:** Pending complete prerequisite evidence.
- **Follow-up:** Use the combined evidence for the Phase 0 architecture review; do not interpret it as production readiness.
