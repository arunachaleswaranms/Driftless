# Phase 2 Qualification — Internet P2P Foundation

## Status

**NOT YET EVALUATED.** This record was created with the Phase 2D software candidate. Its results, and the Phase 2 gate decision, are entered only after the real-device, real-network qualification of an exact committed revision, in a separate documentation commit. Until then nothing below is a result.

## Scope

Phase 2 — Internet P2P Foundation only: signaling, rooms, WebRTC negotiation, STUN, TURN, the control `RTCDataChannel`, disconnect and reconnect, and diagnostics. No Local Sync, playback synchronization, media transfer, or Progressive Watch behavior exists or is evaluated. No [compatibility](COMPATIBILITY.md) status is changed by this record.

## Exit gate

From [ROADMAP.md](ROADMAP.md):

> Two real devices on different networks establish and recover an authenticated WebRTC data-channel session. Evidence records whether the selected path is direct P2P or TURN relay.

## Procedure

The revision under test is one committed SHA (`QUALIFICATION_SHA`), built with `DRIFTLESS_BUILD_REVISION=<QUALIFICATION_SHA>` and deployed as described in [DEPLOYMENT.md](DEPLOYMENT.md). Each device's **Connection diagnostics → Build** must show it. No source changes during a run; any fix produces a new commit and a new run.

1. **Deployment smoke test** ([DEPLOYMENT.md](DEPLOYMENT.md#deployment-smoke-test)) from an outside network: HTTPS, CSP, `/healthz`, WSS, room creation and join, no mixed content, nothing secret in a URL.
2. **Devices.** Device A: the development Mac in desktop Chrome. Device B: a physical OnePlus Nord 5 in Chrome. Model, OS version, and browser version are read from each device (`chrome://version`, system settings), never inferred. No emulator, device emulation, second profile, or second tab substitutes for Device B.
3. **Networks.** Device A on Wi-Fi or fixed broadband, Device B on cellular data, or two unrelated Internet connections. Not the same Wi-Fi, and not a hotspot from the other device. Distinct public egress may be confirmed privately; no address is recorded.
4. **Establishment, ICE policy `all`.** A creates a room; B joins; both reach "Peer data channel is connected." (handshake both ways); both diagnostics are copied. Selected path: `DIRECT`, `TURN_RELAY`, or `UNKNOWN`, as reported.
5. **Forced relay** (if TURN exists): the same with a relay-only qualification build; both diagnostics must report `TURN_RELAY` with relay candidates.
6. **Recovery.** A genuine network disruption on a real path (for example Device B's mobile data off and on, or a network switch), not a programmatic close. Observe signaling resume or loss, peer-connection survival or fresh negotiation, a new handshake, and the post-recovery path from fresh diagnostics.
7. **Heartbeat horizon.** Whether a silently dead path is detected by the service (protocol pings every 15 s; up to two intervals) before the browser's resume schedule (about 16 s of delays, 8 attempts, each bounded at 5 s) is exhausted.

## Evidence hygiene

This record never contains an invite secret, resume secret, TURN username or credential, TURN shared secret, API key, public or private IP address, SDP, candidate string, ICE username fragment, or DTLS fingerprint. Only diagnostic classifications, candidate types, states, counts, versions, and network categories are recorded.

## Gate matrix

| Criterion | Requirement                                                          | Result        |
| --------- | -------------------------------------------------------------------- | ------------- |
| G1        | Public HTTPS/WSS signaling reachable by both real devices            | NOT EVALUATED |
| G2        | Authenticated room create and join across different networks         | NOT EVALUATED |
| G3        | Ordered, reliable `RTCDataChannel` opens; bidirectional handshake    | NOT EVALUATED |
| G4        | Diagnostics prove `DIRECT` or `TURN_RELAY`                           | NOT EVALUATED |
| G5        | Genuine real-network disruption, then recovery per Phase 2 semantics | NOT EVALUATED |

## TURN matrix

| Criterion | Requirement                                   | Result        |
| --------- | --------------------------------------------- | ------------- |
| T1        | Secure short-lived credential issuance exists | NOT EVALUATED |
| T2        | No long-lived browser secret exists           | NOT EVALUATED |
| T3        | Forced relay establishes a real data channel  | NOT EVALUATED |
| T4        | Diagnostics confirm `TURN_RELAY`              | NOT EVALUATED |

## Conclusion

Not yet evaluated. Phase 2 remains **IN PROGRESS**.
