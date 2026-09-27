# Spike 0.3 Result — RTCDataChannel Binary Transfer

## Spike

`0.3 — RTCDataChannel Binary Transfer`

## Result

`PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED`

Software feasibility passed in controlled desktop testing:

- Synthetic payloads of 1, 16, 64, and 128 MiB crossed one ordered `RTCDataChannel` in bounded transport chunks with byte-for-byte integrity verified.
- `bufferedAmount` backpressure paused and resumed the sender in every sustained transfer, and the send queue never exceeded the high-water mark plus one frame.
- Every explicit corruption, loss, duplication, reordering, and malformed-frame mode was detected.
- Cleanup released all owned resources during and after transfers.

The evidence comes from two headless Chrome pages on one macOS host. It is not separate-network or physical Android evidence, and its throughput is a laboratory observation only.

## Experiment Scope

The experiment tests the transport primitive only. It excludes media files and bytes, file transfer, MP4 parsing, MSE, OPFS, synchronization, resumable transfer, production signaling or protocol, and Progressive Watch. Payloads are generated deterministically on demand. Neither peer ever materializes the whole payload.

Development signaling is the same-origin `BroadcastChannel` approach from Spike 0.2. `stun:stun.l.google.com:19302` remains a non-production feasibility STUN server.

## Environment

- Date: 2026-09-26. Repository revision `4edc074` plus uncommitted Spike 0.3 files.
- Host: macOS 26.6.2 (25G83), 10 logical CPUs reported by the browser. Node.js v26.3.0.
- Browser: Google Chrome 153.0.8010.53, `--headless=new`, throwaway temporary profile, driven over the Chrome DevTools Protocol by a scratchpad script that is not committed.
- Browser flags: `--enable-precise-memory-info` (heap observations) and `--disable-features=WebRtcHideLocalIpsWithMdns`. Without the latter, headless host candidates are mDNS-obfuscated; they did not resolve and ICE reached `failed`. This is a lab-only browser configuration.
- Topology: two pages in one headless browser on one host, served from `http://127.0.0.1:4174/`. The sender page reported `visibilityState: visible` and the receiver page `hidden`.
- Negotiated SCTP `maxMessageSize`: 262,144 bytes.
- Selected pair: succeeded host → host over UDP on both peers; RTT snapshots 0–31 ms.
- The Chrome-extension browser session could not reach any loopback URL (`ERR_CONNECTION_REFUSED`, with no request reaching the listening server). With the user's approval, headless Chrome replaced it. That extension-session problem was not diagnosed further.

## AUTOMATED PASS

```text
node --test spikes/phase0/spike-01-local-media/src/formatters.test.mjs \
  spikes/phase0/spike-02-webrtc-connectivity/src/diagnostics.test.mjs \
  spikes/phase0/spike-03-datachannel-binary/src/transfer.test.mjs
PASS — 20 tests, 0 failed; 10 belong to Spike 0.3.

node --check on every Spike 0.3 module — PASS.
```

The Spike 0.3 tests include a real sender → fake channel → real receiver transfer using Web Crypto SHA-256. That run asserts integrity, `maxBufferedAmount <= highWater + frameBytes`, equal pause/resume counts, detection of all five fault modes, listener removal on low/close/abort, and the receiver verification-backlog abort.

## AUTOMATED DESKTOP Browser Evidence

The lab matrix (23 runs) was executed twice (run A 07:33 UTC, run B 07:34 UTC). Both runs reported `23 runs recorded, 0 unexpected`. Default marks were 1 MiB high / 256 KiB low unless stated otherwise.

### Transfer Matrix

Throughput is payload bytes divided by the time from the receiver's `accept` to the receiver's verified `result`. It is a **same-host laboratory value only**. The max `bufferedAmount` and backpressure columns are from run A; run B was equivalent.

| Run | Test | Total | Chunk | HW / LW | Elapsed A / B | Throughput A / B (lab) | Max `bufferedAmount` | Pauses = resumes | Integrity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | BT-01/04 | 1 MiB | 16 KiB | 1 MiB / 256 KiB | 58 / 56 ms | 17.2 / 17.9 MiB/s | 1,052,160 | 0 | PASS |
| 2 | BT-01/04 | 1 MiB | 64 KiB | 1 MiB / 256 KiB | 31 / 31 ms | 32.7 / 32.2 MiB/s | 1,049,472 | 0 | PASS |
| 3 | BT-01/04 | 1 MiB | 128 KiB | 1 MiB / 256 KiB | 32 / 31 ms | 31.4 / 32.5 MiB/s | 1,049,024 | 0 | PASS |
| 4 | BT-01/04 | 1 MiB | 256 KiB | — | not sent | — | — | — | Rejected before send: 262,200-byte frame > 262,144 `maxMessageSize` |
| 5 | BT-02/04 | 16 MiB | 16 KiB | 1 MiB / 256 KiB | 3,838 / 4,630 ms | 4.2 / 3.5 MiB/s | 1,064,536 | 19 | PASS (first sustained transfer; see warm-up finding) |
| 6 | BT-02/04 | 16 MiB | 64 KiB | 1 MiB / 256 KiB | 460 / 455 ms | 34.8 / 35.1 MiB/s | 1,110,508 | 19 | PASS |
| 7 | BT-02/04 | 16 MiB | 128 KiB | 1 MiB / 256 KiB | 464 / 455 ms | 34.5 / 35.2 MiB/s | 1,176,112 | 18 | PASS |
| 8 | BT-02/04 | 16 MiB | 256 KiB | — | not sent | — | — | — | Rejected before send (same reason) |
| 9 | BT-03/04 | 64 MiB | 16 KiB | 1 MiB / 256 KiB | 1,861 / 1,824 ms | 34.4 / 35.1 MiB/s | 1,064,880 | 77 | PASS |
| 10 | BT-03/04 | 64 MiB | 64 KiB | 1 MiB / 256 KiB | 1,831 / 1,804 ms | 35.0 / 35.5 MiB/s | 1,113,372 | 77 | PASS |
| 11 | BT-03/04 | 64 MiB | 128 KiB | 1 MiB / 256 KiB | 1,879 / 1,817 ms | 34.1 / 35.2 MiB/s | 1,179,384 | 72 | PASS |
| 12 | BT-03/04 | 64 MiB | 256 KiB | — | not sent | — | — | — | Rejected before send (same reason) |
| 13 | BT-03/04 | 128 MiB | 16 KiB | 1 MiB / 256 KiB | 3,675 / 3,646 ms | 34.8 / 35.1 MiB/s | 1,064,996 | 155 | PASS |
| 14 | BT-03/04 | 128 MiB | 64 KiB | 1 MiB / 256 KiB | 3,709 / 3,580 ms | 34.5 / 35.8 MiB/s | 1,113,316 | 156 | PASS |
| 15 | BT-03/04 | 128 MiB | 128 KiB | 1 MiB / 256 KiB | 3,695 / 3,621 ms | 34.6 / 35.4 MiB/s | 1,179,024 | 146 | PASS |
| 16 | BT-03/04 | 128 MiB | 256 KiB | — | not sent | — | — | — | Rejected before send (same reason) |
| 17 | BT-05 | 64 MiB | 64 KiB | 256 KiB / 64 KiB | 1,968 / 1,973 ms | 32.5 / 32.4 MiB/s | 325,824 | 255 | PASS |
| 18 | BT-05 | 64 MiB | 64 KiB | 4 MiB / 1 MiB | 1,828 / 1,796 ms | 35.0 / 35.6 MiB/s | 4,252,768 | 20 | PASS |
| 19 | BT-06 | 16 MiB | 64 KiB | 1 MiB / 256 KiB | 492 / 446 ms | lab only | 1,109,856 | 19 | FAIL detected — `corrupt-byte` |
| 20 | BT-06 | 16 MiB | 64 KiB | 1 MiB / 256 KiB | 462 / 460 ms | lab only | 1,109,584 | 19 | FAIL detected — `drop-chunk` |
| 21 | BT-06 | 16 MiB | 64 KiB | 1 MiB / 256 KiB | 458 / 448 ms | lab only | 1,110,532 | 19 | FAIL detected — `duplicate-chunk` |
| 22 | BT-06 | 16 MiB | 64 KiB | 1 MiB / 256 KiB | 451 / 455 ms | lab only | 1,109,696 | 19 | FAIL detected — `reorder-chunks` |
| 23 | BT-06 | 16 MiB | 64 KiB | 1 MiB / 256 KiB | 450 / 442 ms | lab only | 1,110,884 | 19 | FAIL detected — `malformed-frame` |

The receiver reported exact byte and chunk counts for every passing run; for example, run 15 received 134,217,728 bytes in 1,024 chunks with matching sender/receiver manifests `96106b82f15fc3a7…`. The final data-channel `getStats()` counters after run A reported 21,759 messages / 876,783,054 bytes sent by the sender.

### Test Status

| Test | Status | Evidence / notes |
| --- | --- | --- |
| BT-01 Small payload | `AUTOMATED DESKTOP PASS` | 1 MiB at 16/64/128 KiB, integrity PASS twice. |
| BT-02 Medium payload | `AUTOMATED DESKTOP PASS` | 16 MiB at 16/64/128 KiB, integrity PASS twice. |
| BT-03 Larger payload | `AUTOMATED DESKTOP PASS` | 64 MiB and 128 MiB at 16/64/128 KiB, integrity PASS twice with a bounded queue. |
| BT-04 Chunk variation | `AUTOMATED DESKTOP PASS` | 16/64/128 KiB succeed. 256 KiB payload + 56-byte header exceeds Chrome's negotiated 262,144-byte `maxMessageSize` and is rejected cleanly before any send. |
| BT-05 Backpressure | `AUTOMATED DESKTOP PASS` | Natural same-host pressure; no artificial throttling was needed. See below. |
| BT-06 Integrity failure detection | `AUTOMATED DESKTOP PASS` | All five explicit modes produced receiver FAIL with specific reasons. |
| BT-07 Cleanup | `AUTOMATED DESKTOP PASS` | Mid-transfer and post-transfer close released every owned resource. See below. |
| BT-08 Diagnostics | `AUTOMATED DESKTOP PASS` | readyState, totals, sent/received bytes, chunks, `bufferedAmount`, max, pauses, timing, throughput, integrity, heap, selected pair, and data-channel stats recorded per run. |
| BT-09 Real external network | `DEFERRED-PHYSICAL / EXTERNAL-NETWORK VALIDATION` | Not executed. Tracked as `DEFERRED-PHYSICAL-003`. |

## Backpressure Evidence

- Mechanism: `bufferedAmountLowThreshold` = low-water mark. Before every frame, the sender pauses if `bufferedAmount > highWater` and awaits `bufferedamountlow` (event-driven, no polling). It resumes when the event fires.
- Every sustained transfer paused: 19 pauses for 16 MiB, about 72–77 for 64 MiB, 146–156 for 128 MiB, 255 at 256 KiB high-water, and 20 at 4 MiB high-water. Pauses equalled resumes in every completed run.
- Pause points matched the high-water mark and resume points were at or below the low-water mark. For example, run A row 13 last paused at 1,060,652 bytes and resumed at 201,332; row 17 paused at 262,368 and resumed at 46,016; row 18 paused at 4,248,920 and resumed at 1,040,512.
- Across all 38 sent runs in A and B, max `bufferedAmount` ≤ high-water + one frame (verified programmatically). The sender queue therefore did not grow with payload size: 128 MiB transfers peaked at about 1.06–1.18 MB of browser send buffer.
- 1 MiB transfers never paused because the whole payload fits under the 1 MiB high-water mark plus one frame. That is correct behaviour, not a missing mechanism.
- Most transfer time was spent paused (for example 3.5 s of 3.7 s at 128 MiB). Frame generation plus SHA-256 took about 0.1 s per 128 MiB, so on this host the SCTP drain rate, not sender CPU, limited throughput.

## Integrity Evidence

| Mode | Receiver reasons (run A) |
| --- | --- |
| `corrupt-byte` | pattern mismatch at byte 8,388,608 (sequence 128); sequence 128 SHA-256 does not match its header; manifest mismatch |
| `drop-chunk` | unexpected sequence: expected 128, received 129; 1 chunk missing; received 16,711,680 of 16,777,216 bytes; manifest mismatch |
| `duplicate-chunk` | duplicate sequence 128 (duplicate rejected; bytes not double-counted) |
| `reorder-chunks` | unexpected sequence: expected 128 received 129; expected 130 received 128 |
| `malformed-frame` | rejected frame: frame magic is invalid |

Run B produced the same detections. No passing run reported a false integrity failure.

## Cleanup Evidence (BT-07)

- **Close during transfer:** a 128 MiB / 16 KiB transfer was started and the sender peer was closed after about 10 MiB had been sent.
  - The run was recorded as `aborted — peer closed during transfer` (19,103,744 payload bytes sent; 22 pauses / 21 resumes, because the pending pause wait was rejected by the close as designed).
  - The sender then reported peer, data channel, and signaling channel `released`, 0 timers, 0 backpressure waiters, 0 control waiters, and no active transfer.
  - The receiver reported data channel `closed`, transfer `aborted — data channel closed`, and 0 pending verifications. After closing, it also reported everything released with 0 timers.
- **Close after transfer:** a fresh pair completed a 1 MiB / 64 KiB transfer (integrity PASS). Both peers were closed and reported every owned resource released with 0 timers and waiters.
- Browser console: no warnings, errors, or exceptions on any page in run B. Run A's only entry was a favicon 404, since fixed with an inline empty icon.
- The receiver's `RTCPeerConnection` does not close itself when the remote closes; it remained `connected` until explicitly closed. Production lifecycle handling must treat remote channel closure explicitly.

## Warm-up Finding

The first sustained transfer on each fresh association was markedly slower. Targeted fresh-pair sequences:

| Sequence | Runs (throughput, lab) |
| --- | --- |
| 16 KiB first | 16 MiB/16 KiB **3.4**, 16 MiB/16 KiB 34.9, 16 MiB/64 KiB 35.2, 16 MiB/16 KiB 34.1 MiB/s |
| 64 KiB first | 16 MiB/64 KiB **6.1**, 16 MiB/16 KiB 35.1, 16 MiB/16 KiB 35.5 MiB/s |
| 64 MiB first | 64 MiB/16 KiB **10.5**, 16 MiB/16 KiB 34.5 MiB/s |

The slowdown follows association age, not chunk size: roughly the first 2–4 s of sustained sending on a new connection is slow, and later transfers of any size reach about 35 MiB/s. This is consistent with transport congestion-control or pacing ramp-up, although the exact cause was not isolated. Integrity and backpressure were unaffected. Later startup-latency work for Progressive Watch must account for connection warm-up and must not use warmed same-host throughput as a planning value.

## External-Network Evidence

`DEFERRED-PHYSICAL / EXTERNAL-NETWORK VALIDATION`.

No transfer crossed separate NATs, carrier networks, a TURN relay, or a physical Android device. Real-network throughput, loss and latency effects on SCTP, relay cost, and mobile memory/CPU remain unqualified. This is tracked as `DEFERRED-PHYSICAL-003` in `PROJECT_STATE.md`.

## Memory Findings

- **Sender:** one frame (≤ 128 KiB + 56 bytes) is generated at a time. The browser send queue is bounded by high-water + one frame (≤ about 4.26 MB even at the 4 MiB mark). The per-chunk digest list is 32 bytes per chunk (256 KiB at 8,192 chunks).
- **Receiver:** payloads are verified and released. Retained state is a 1-byte-per-chunk seen-bitmap plus 32 bytes per chunk of digests. Maximum pending-verification bytes equalled one chunk in every run (16/64/128 KiB), so Web Crypto kept pace on this host.
- **Heap (coarse, Chrome `performance.memory`, precise mode):** the sender's JS heap peaked at 42–57 MiB for 128 MiB transfers and at most 59.8 MiB across the matrix. It fell back between runs (for example 57 → 35 MiB, 43 → 7 MiB) and did not scale with payload size. The receiver heap was 2.7–4.7 MiB after the matrix. The residual sender heap is transient garbage from short-lived frame buffers.
- **Tradeoff:** there is no whole-payload SHA-256, because `crypto.subtle.digest` is not incremental and would require a full-size assembled copy. The chunk-digest manifest plus deterministic pattern comparison gives strong end-to-end verification without such a copy, but the manifest depends on chunk size and differs from a file hash. The later production integrity design remains open.
- **Receiver-side flow control:** `RTCDataChannel` offers the application no receive-side backpressure. Messages are delivered to JavaScript regardless of processing speed. Here the backlog stayed at one chunk only because verification was fast. The spike bounds it at 64 MiB and aborts beyond that. A production transfer engine that writes to storage or appends to MSE will need application-level flow control (acknowledgements or credits), not just sender `bufferedAmount`.

## Security / Robustness Findings

- Frames are validated before any use: payload type (`ArrayBuffer` via `binaryType = "arraybuffer"`), magic, version, kind, header length, declared length, payload bounds, transfer identifier, total chunks, sequence range, and per-sequence payload length.
- Control messages are length-bounded (8,192 characters), parsed defensively, and schema-checked. Unknown types, oversized totals (> 256 MiB), inconsistent chunk counts, unknown fault modes, and unexpected per-role messages are rejected. Zero rejections occurred in the matrix apart from the deliberate malformed frame.
- Transfers above 256 MiB, chunks outside 4 KiB–1 MiB, more than 65,536 chunks, and frames above the negotiated `maxMessageSize` are refused before sending.
- The sender queue and the receiver verification backlog are both bounded; no queue is unbounded.
- Nothing is persisted. There is no analytics or telemetry, no media, and no file input. Candidate addresses and raw SDP are not displayed.
- These are laboratory controls. No production security claim is made. In particular, the SHA-256 digests authenticate nothing: a malicious peer can send consistent wrong data with matching digests.

## Risks / Issues

- The 256 KiB chunk candidate is infeasible with any header under Chrome's negotiated 262,144-byte `maxMessageSize`. Other browsers may negotiate different limits, so chunk sizing must be derived from the negotiated value at runtime.
- Warm-up on a fresh association sharply reduces early throughput. It is untested on real networks.
- Same-host throughput plateaued at about 35 MiB/s (about 290 Mbit/s) regardless of chunk size above 16 KiB. That is a Chrome/SCTP same-host characteristic, not a network capacity estimate.
- Headless Chrome with mDNS obfuscation disabled differs from a default user browser. The Chrome-extension session's loopback failure was not diagnosed.
- The receiver page was `hidden` during the runs; this did not affect event-driven delivery here, but background throttling on mobile is untested.
- Only one browser engine was tested. Firefox and Safari behaviour and physical Android memory/CPU remain unknown.

## Decision

Record `PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED`. BT-01 through BT-08 pass in the controlled desktop environment with genuine automated evidence. Full `PASS` is withheld because BT-09 has no real external-network or physical Android evidence.

## Architecture Impact

No architecture change required. `RTCDataChannel` behaved suitably as a bounded, ordered binary transport primitive, which is consistent with ADR-0002. The findings about negotiated message size, association warm-up, and the absence of receive-side flow control are inputs to later transfer-engine design, not ADR challenges. No ADR was modified.

## Follow-up

Independent review of Spike 0.3 before beginning Spike 0.4.
