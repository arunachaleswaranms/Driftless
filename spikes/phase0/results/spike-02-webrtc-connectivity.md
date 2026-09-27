# Spike 0.2 Result — WebRTC Peer Connectivity

## Spike

`0.2 — WebRTC Peer Connectivity`

## Result

`PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED`

Controlled desktop software feasibility passed: offer/answer exchange succeeded, ICE completed, both `RTCPeerConnection` objects reached `connected`, the text-only `RTCDataChannel` opened, `PING`/`PONG` succeeded, selected-pair diagnostics were captured through `getStats()`, and both peers released their resources. This run used two tabs in one Chrome profile on one desktop host. It does not prove connectivity across separate NATs or real Internet networks and is not physical Android evidence.

## Experiment Scope

Prove the smallest browser peer connection suitable for later control and transfer traffic. The experiment excludes media files and bytes, binary transfer, throughput measurement, chunking, synchronization, production signaling, authentication, databases, cloud infrastructure, and Progressive Watch.

SDP and ICE candidates use a same-origin, in-memory `BroadcastChannel` only for development signaling. The peer configuration references `stun:stun.l.google.com:19302` as a public non-production feasibility STUN server. No production STUN/TURN provider or architecture was selected.

## AUTOMATED PASS

Environment: macOS 26.6.2 (25G83), Node.js v26.3.0.

```text
node --test spikes/phase0/spike-01-local-media/src/formatters.test.mjs \
  spikes/phase0/spike-02-webrtc-connectivity/src/diagnostics.test.mjs
PASS — 10 tests passed, 0 failed; 5 tests belong to Spike 0.2.

node --check spikes/phase0/spike-02-webrtc-connectivity/src/app.mjs
node --check spikes/phase0/spike-02-webrtc-connectivity/src/diagnostics.mjs
PASS — both exit 0.
```

Spike 0.2 unit coverage includes ICE candidate-type parsing, browser `RTCStatsReport` selected-pair lookup, nominated-pair fallback, evidence-bounded host/srflx/relay classification, RTT formatting, and observed-candidate formatting.

## AUTOMATED DESKTOP Browser Evidence

Date: 2026-09-25.

Environment:

- Host: macOS 26.6.2 (25G83).
- Browser User-Agent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36`.
- Topology: two tabs in one Chrome profile on one desktop host, loaded from `http://127.0.0.1:4174/`.
- Development signaling: same-origin `BroadcastChannel` with room label `wc-auto-20260925`.
- Browser console: no warning or error entries in either tab during the final run.

| Test | Status | Evidence / notes |
| --- | --- | --- |
| WC-01 Create two peers | `AUTOMATED PASS` | Initiator and responder each initialized an `RTCPeerConnection`. |
| WC-02 Offer/answer exchange | `AUTOMATED PASS` | Both signaling states became `stable`; initiator showed local offer/remote answer and responder showed local answer/remote offer. |
| WC-03 ICE gathering | `AUTOMATED PASS` | Both peers reported `iceGatheringState: complete` and `iceConnectionState: connected`. |
| WC-04 Connection establishment | `AUTOMATED PASS` | Both peers reported `connectionState: connected`. |
| WC-05 RTCDataChannel opens | `AUTOMATED PASS` | Both peers reported the `control` channel as `open`. |
| WC-06 Tiny text message | `AUTOMATED PASS` | Initiator sent `PING` and received `PONG`; responder received `PING` and sent `PONG`. |
| WC-07 Disconnect/close | `AUTOMATED PASS` | Explicit close returned both peers to `closed`; peer connection, data channel, signaling channel, and owned timers were released. Final browser console checks contained no warning/error entries. |
| WC-08 Connection diagnostics | `AUTOMATED PASS` | Both peers reported a succeeded selected candidate pair with local/remote candidate type, UDP protocol, RTT, and an evidence-based path classification. |
| WC-09 Different real Internet networks | `DEFERRED PHYSICAL / EXTERNAL-NETWORK VALIDATION` | Not executed. Same-host tabs do not reproduce separate NATs, carrier networks, or independent physical devices. |

The two tabs were separate browser peers but not independent browser profiles or isolated browser contexts. This limitation is material to the evidence label.

## ICE / Candidate Findings

Final connected snapshot:

| Peer | Local types observed | Remote types observed | Selected local | Selected remote | Protocol | RTT |
| --- | --- | --- | --- | --- | --- | --- |
| Initiator | `host` | `host` | `host` | `host` | `udp` | `1.00 ms` |
| Responder | `host` | `host` | `host` | `host` | `udp` | `1.00 ms` |

The final stable snapshot reported a succeeded host/host selected pair on both peers. Therefore the tested connection is classified as a host path based on selected-candidate evidence. Earlier repeated runs in the same controlled environment also observed server-reflexive candidates, but they were not selected in the recorded stable pair. No relay candidate or relayed selected path was observed. TURN was not required for this controlled same-host run and was not implemented or tested.

These findings must not be generalized to direct connectivity across separate Internet networks.

## RTCDataChannel Evidence

- One channel named `control` was created by the initiator.
- Only string messages `PING` and `PONG` were sent.
- Both sides reported `open` before the exchange.
- No binary values, media bytes, chunks, files, or throughput traffic were sent.
- The channel was explicitly closed during cleanup.

This evidence verifies minimal control connectivity only and does not implement or satisfy Spike 0.3 binary transfer.

## EMULATOR Evidence

`NOT TESTED`.

No Android emulator run was performed. No emulator evidence is claimed or promoted to physical-device evidence.

## External-Network Evidence

`DEFERRED-PHYSICAL / EXTERNAL-NETWORK VALIDATION`.

No peers on genuinely separate Internet networks were tested. Different NATs, Wi-Fi/mobile-data combinations, carrier behavior, firewall constraints, and TURN fallback remain unqualified. This work is tracked as `DEFERRED-PHYSICAL-002` in `PROJECT_STATE.md`.

## Security and Privacy Verification

- No media files, media elements, media bytes, file inputs, or upload paths exist in the experiment.
- No analytics or telemetry code exists.
- No production credentials, tokens, authentication, databases, room services, cloud resources, or persistent identifiers exist.
- Development signaling carries only the SDP and ICE candidates needed for the experiment and remains same-origin, in-memory, and non-persistent.
- Candidate addresses and raw SDP are not rendered or written to the bounded event log; the UI displays candidate types and selected-pair fields.
- Room labels are length/character bounded and are explicitly not authentication secrets.
- Closing releases the `RTCPeerConnection`, `RTCDataChannel`, `BroadcastChannel`, pending candidate queue, and owned intervals.
- WebRTC negotiation necessarily exposes network-related information to the other peer. The experiment and its documentation state this privacy property.

## Findings

- The accepted browser WebRTC assumption remains plausible in a controlled Chrome environment.
- Browser `getStats()` exposed enough selected-pair information in this run to distinguish the chosen host path from merely observed srflx candidates.
- The development signaling mechanism is sufficient for local repeatability but cannot exercise the external-network question.

## Risks / Issues

- Separate-NAT and mobile-carrier reachability remain unknown.
- TURN fallback, relay diagnostics, provider behavior, bandwidth, privacy, and cost remain untested and undecided.
- The final automated run used two tabs in one browser profile, not independent browser contexts or devices.
- Snapshot RTT values on a same-host path are diagnostic observations, not performance baselines or acceptance thresholds.

No stop condition was triggered: controlled connectivity succeeded, accepted WebRTC assumptions were not contradicted, no ADR change was required, and no production TURN adoption was necessary.

## Decision

Record `PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED`. The software feasibility criteria WC-01 through WC-08 pass in the controlled desktop environment. Full `PASS` is withheld because WC-09 has no genuine separate-network evidence.

## Architecture Impact

No architecture change required. ADR-0002 remains plausible but is not validated for real Internet or physical Android conditions by this result.

## Follow-up

Independent review of Spike 0.2 before beginning Spike 0.3.
