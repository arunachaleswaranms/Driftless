# Test Plan

## Status and Purpose

This is the planned product verification strategy. No production application test framework or suite has been initialized. Phase 0 has separate passing spike tests and controlled desktop browser evidence in [the result records](../spikes/phase0/), but those results do not satisfy physical-device or real-network gates. Each future product result must record application revision, browser/device versions, network conditions, media characteristics, and whether WebRTC used direct P2P or TURN relay.

## Test Levels

### Unit Tests

Planned unit coverage includes:

- Protocol envelope and per-message validation.
- Authorization, sequencing, duplicate, stale, and illegal-transition handling.
- Host-authoritative state reduction and clock/drift calculations.
- Media fingerprint inputs and deterministic behavior.
- Segment/chunk mapping, scheduling, acknowledgement, and resume state.
- Buffer prioritization, backpressure, and cache eviction policy.
- Bounds, overflow checks, integrity verification, and sanitized errors.

Timing tests should use controllable clocks; correctness must not depend on arbitrary sleeps.

### Integration Tests

Planned integration coverage includes signaling-to-WebRTC negotiation, reconnect reconciliation, protocol compatibility, two-client synchronization, transfer reassembly, storage adapters, MSE append behavior, and cleanup. Tests must keep signaling, sync, and transfer failures independently observable.

### Browser Automation

Playwright is the planned browser-automation tool, subject to Phase 1 tooling decisions. It should exercise room flows, file selection using controlled fixtures, readiness, playback controls, reconnect UI, capability fallbacks, chat/reactions, and error states across supported desktop engines.

Browser automation is evidence for automated flows, not a substitute for real mobile devices, carrier networks, or codec/platform validation.

### Real-Device Testing

Required devices include a physical Android device running Chrome and, before any relevant support claim, physical devices for other target mobile browsers. Record device model, OS, browser version, battery/background state, storage availability, and network type.

**Emulators and desktop browser simulation do not satisfy real Android test gates.** They may supplement failure reproduction and automation only.

Phase 0 software feasibility closed with `DEFERRED-PHYSICAL-001` through `DEFERRED-PHYSICAL-007` still open in [PROJECT_STATE.md](../PROJECT_STATE.md). Future device and network qualification must account for each debt before making the corresponding support claim; the Phase 0 desktop runs cannot substitute for physical Android, real cross-network, or TURN evidence.

## Functional Coverage

### Local Sync

- Matching and mismatching local media.
- Ready/not-ready transitions and media changes.
- Host play, pause, repeated seek, and rapid command sequences.
- Guest attempt to issue unauthorized authoritative actions.
- Clock skew, jitter, foreground/background transitions, and sleep/wake.
- Long-duration synchronization with measured drift and correction events.
- Host and guest disconnect/reconnect and stale-message rejection.
- Verification that media bytes are not transferred.

### Progressive Watch

- Target-compatible and deliberately unsupported media.
- Initialization, startup buffer, continuous buffering, and end-of-media.
- Multi-GB media with memory, storage, and queue observations.
- Backpressure under slow receivers and senders.
- Missing, duplicated, reordered, corrupted, and conflicting chunks.
- Seek within buffered data and seek to unavailable data.
- Cancellation, cache cleanup, quota pressure, and browser eviction.
- Temporary outage and resumable transfer reconciliation.
- Integrity mismatch and wrong-media cache rejection.

### Rooms and Social Features

- Invite creation, expiry, guessing resistance, reuse, and invalidation.
- Maximum-participant enforcement.
- Simultaneous join and reconnect races.
- Chat/reaction length, encoding, rate, and rendering safety.
- Host disconnect and terminal room behavior.

## Network Matrix

Every phase gate that depends on networking must cover applicable combinations and record directionality:

| Sender network | Receiver network | Required observation |
| --- | --- | --- |
| Wi-Fi | Wi-Fi | Connectivity, selected ICE path, latency, stability |
| Wi-Fi | Mobile data | Sender/receiver asymmetry, carrier NAT, selected ICE path |
| Mobile data | Wi-Fi | Sender uplink behavior, carrier NAT, selected ICE path |
| Mobile data | Mobile data | Carrier-to-carrier connectivity, relay likelihood, stability |

Each applicable pair must also be exercised with controlled variants:

- Added latency.
- Packet loss.
- Reduced sender bandwidth.
- Reduced receiver bandwidth.
- Temporary outage followed by recovery.

For every run, record whether WebRTC uses **direct P2P** or **TURN relay**. A test that does not capture the path cannot establish direct-connectivity behavior or TURN cost exposure.

The exact impairment values and pass thresholds will be defined from Phase 0 evidence and documented before the corresponding gate is evaluated.

## Long-Duration and Resource Tests

- Run sessions long enough to expose accumulated drift, timer throttling, resource leakage, and cache growth.
- Test representative short, long, and multi-GB files without loading the entire file into memory.
- Observe heap, queued data, storage use, MSE ranges, CPU, battery impact, and sender uplink.
- Repeat play/pause/seek/reconnect cycles to expose retained listeners, object URLs, workers, and temporary data.
- Test browser restart or tab discard only where the product claims recovery.

Durations and resource budgets require evidence and must be set before release gates.

## Reconnect and Failure Injection

Inject signaling loss, peer connection loss, ICE restart, TURN transition where available, host disappearance, guest disappearance, browser backgrounding, data-channel closure, storage eviction, quota failure, parser rejection, and MSE append errors. Verify explicit state reconciliation and safe cleanup rather than assuming transport reconnection restores application state.

## Security Tests

- Unknown protocol versions/types and extra or missing fields.
- Oversized JSON, binary messages, chunks, collections, chat, and reactions.
- Invalid encodings, non-finite numbers, overflow-prone offsets, and inconsistent totals.
- Sequence replay, cross-room identifiers, stale authority, forged role, and reconnect races.
- Room enumeration, invite guessing, expired credentials, participant-limit bypass, and rate limits.
- Allocation, memory, storage, acknowledgement, retry, and seek-amplification exhaustion.
- Crafted filenames, metadata, MP4 structures, fingerprints, and integrity failures.
- Cache isolation and cleanup across rooms, media changes, cancellation, logout/clear, and expiry.
- CSP, WSS/HTTPS enforcement, secret leakage, logging redaction, and dependency vulnerabilities.

## Compatibility Evidence

The status vocabulary and target tiers live in [COMPATIBILITY.md](COMPATIBILITY.md). A combination moves to `SUPPORTED` only when its defined functional, network, device, security, and regression gates pass on recorded versions. `SPIKE ONLY` and `PARTIAL` must identify limitations and must not be marketed as support.

## Test Artifacts

Future test reports should include the exact Git revision, configuration without secrets, browser/OS/device versions, media fixture provenance and characteristics, network topology and impairments, ICE path type, raw measurements, failures, and reviewer conclusion. Test media must be lawful, non-sensitive, minimal where possible, and excluded from Git when large or local-only.

