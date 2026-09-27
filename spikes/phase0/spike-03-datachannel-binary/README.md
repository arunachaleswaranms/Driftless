# Spike 0.3 RTCDataChannel Binary Transfer Experiment

This dependency-free page moves **generated synthetic bytes** between two browser peers over one ordered, reliable `RTCDataChannel`. It measures bounded chunking, `bufferedAmount` backpressure, per-chunk integrity, diagnostics, and cleanup. It does not read, send, or store media or files, and it does not implement MP4 parsing, MSE, OPFS, synchronization, production signaling, resumable transfer, or Progressive Watch.

## Layout

| File | Responsibility |
| --- | --- |
| `src/framing.mjs` | Experimental frame header, bounds, deterministic byte pattern, control-message validation. |
| `src/sender.mjs` | Event-driven backpressure (`bufferedAmount` / `bufferedamountlow`), explicit fault schedule, chunk-frame construction. |
| `src/receiver.mjs` | Bounded, chunk-aware verification state machine; retains no payload after verification. |
| `src/metrics.mjs` | Byte, duration, and lab-throughput formatting. |
| `src/app.mjs` | Peer lifecycle, development signaling adapted from Spike 0.2, UI, lab matrix, resource accounting. |
| `src/transfer.test.mjs` | Node unit and fake-channel end-to-end tests. |

`src/app.mjs` imports the unit-tested selected-pair helpers from `../../spike-02-webrtc-connectivity/src/diagnostics.mjs` instead of duplicating them, so the server must serve `spikes/phase0/`, not only this directory.

## Run

From the repository root:

```sh
python3 -m http.server 4174 --bind 127.0.0.1 --directory spikes/phase0
```

Open two pages in the browser under test:

- `http://127.0.0.1:4174/spike-03-datachannel-binary/?role=responder&room=bt-local`
- `http://127.0.0.1:4174/spike-03-datachannel-binary/?role=initiator&room=bt-local`

Click **Start peer** in both. When the channel is `open`, use **Start transfer** on the sender for one configuration or **Run lab matrix** for BT-01 to BT-06. Use **Abort transfer** or **Close peer** during a transfer to exercise cleanup. Raw per-run evidence is available under **Raw JSON evidence**.

Headless Chrome hides host candidates behind mDNS names; in the recorded headless runs those names did not resolve and ICE failed. The recorded evidence therefore used `--disable-features=WebRtcHideLocalIpsWithMdns` for the throwaway headless profile. This is a lab-only browser flag, not a product configuration.

## Automated Checks

```sh
node --test src/transfer.test.mjs
node --check src/app.mjs src/framing.mjs src/receiver.mjs src/sender.mjs src/metrics.mjs
```

The fake-channel tests drive the real sender and receiver with Web Crypto SHA-256 and verify: bounds, the pattern generator, header decoding and rejection, control-message schemas, deterministic fault schedules, listener removal in the backpressure waiter, the `bufferedAmount <= highWater + frameBytes` bound, detection of every fault mode, and the receiver verification-backlog bound.

## Experimental Framing (not a protocol decision)

Each binary frame is a 56-byte big-endian header followed by the payload:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | Magic `DLT3` |
| 4 | 1 | Version `1` |
| 5 | 1 | Kind `1` (chunk) |
| 6 | 2 | Header length `56` |
| 8 | 4 | Transfer identifier |
| 12 | 4 | Sequence index |
| 16 | 4 | Total chunks |
| 20 | 4 | Payload length |
| 24 | 32 | SHA-256 of the payload |

Control messages are bounded JSON text (`begin`, `accept`, `reject`, `end`, `result`, `abort`) on the same ordered channel, so `end` arrives after all chunk frames. The receiver accepts a transfer only after validating `begin` against the bounds below.

## Backpressure

- The sender sets `bufferedAmountLowThreshold` to the low-water mark before sending.
- Before each frame, if `bufferedAmount` is above the high-water mark, the sender **pauses** and awaits the `bufferedamountlow` event. It never polls.
- It **resumes** when that event fires, meaning `bufferedAmount` has fallen to the low-water mark or below.
- The waiter rejects and removes its listeners if the channel closes or the transfer is aborted.
- The sender enqueues at most one frame past the high-water mark, so the browser send queue is bounded by `highWater + frameBytes`.
- Default marks are 1 MiB high / 256 KiB low. The lab matrix also exercises 256 KiB / 64 KiB and 4 MiB / 1 MiB. These values are experimental, not production defaults.

## Integrity

- Payload bytes come from a seeded, offset-addressable 32-bit mixer. Either side can regenerate any range without building the whole payload.
- The receiver checks each chunk against the deterministic pattern synchronously, then asynchronously checks its Web Crypto SHA-256 against the header digest.
- The receiver keeps a seen-bitmap and one 32-byte digest per chunk. At `end` it verifies exact byte and chunk counts, missing chunks, and SHA-256 over the concatenated per-chunk digests (a "manifest" compared with the sender's).
- The manifest depends on the chunk size and is **not** the SHA-256 of the whole payload. A whole-payload Web Crypto digest would require assembling the full payload in memory, because `crypto.subtle.digest` is not incremental.
- Fault modes (`corrupt-byte`, `drop-chunk`, `duplicate-chunk`, `reorder-chunks`, `malformed-frame`) are explicit, deterministic, and target the middle chunk. There is no random corruption.

## Bounds and Robustness

| Bound | Value |
| --- | --- |
| Maximum experimental transfer | 256 MiB |
| Chunk payload | 4 KiB – 1 MiB, and frame ≤ negotiated SCTP `maxMessageSize` |
| Maximum chunks per transfer | 65,536 |
| Control message | ≤ 8,192 characters, schema-checked JSON object |
| Receiver pending verification | ≤ 64 MiB, otherwise the transfer is aborted |
| Reasons per result | ≤ 20, each ≤ 200 characters |

Frames with a bad magic, version, kind, header length, length mismatch, oversized payload, wrong transfer, inconsistent total, out-of-range sequence, or wrong payload length are rejected and fail the active transfer. Binary data outside an active transfer, unknown or oversized control messages, and messages unexpected for the role are rejected and counted. Nothing is persisted, and there is no analytics or telemetry.

## Test Cases

| ID | Procedure | Expected |
| --- | --- | --- |
| BT-01 | 1 MiB transfer. | Byte-for-byte integrity. |
| BT-02 | 16 MiB transfer. | Integrity passes. |
| BT-03 | 64 MiB and 128 MiB transfers. | Integrity passes with the send queue bounded. |
| BT-04 | 16, 64, 128, 256 KiB chunk payloads. | Supported values pass; unsupported values fail clearly before sending. |
| BT-05 | Varied high-/low-water marks. | Pauses/resumes observed; `bufferedAmount` stays ≤ high-water + one frame. |
| BT-06 | Each explicit fault mode. | Receiver reports integrity failure with a specific reason. |
| BT-07 | Close during and after a transfer. | Peers, channels, timers, and waiters are released. |
| BT-08 | Diagnostics. | Transfer metrics and selected pair recorded. |
| BT-09 | Real external networks / Android. | `DEFERRED-PHYSICAL / EXTERNAL-NETWORK VALIDATION`. |

## Evidence Classification

Browser automation on desktop is `AUTOMATED DESKTOP`. Same-host throughput is a laboratory observation, not Internet throughput. Physical Android and separate-network runs remain deferred until genuine evidence exists.
