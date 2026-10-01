# Test Plan

## Status and Purpose

This is the planned product verification strategy. The production web client in `apps/web/` has a Phase 1 automated baseline of Vitest unit/component tests and Playwright Chromium tests covering the application foundation, the local media player, and capability reporting: local file selection, reported metadata, playback, pause, seek, replacement, clear/reset, object URL lifecycle and resource release, application-shell smoke coverage, and capability detection. Capability tests check the detector against synthetic environments with APIs present, absent, or blocked, compare the report with the test browser's own globals, and confirm that detection causes no request, prompt, WebRTC connection, or storage change. These Chromium results are development-browser evidence only; they do not satisfy physical-device, broad-browser, real-network, or product-support gates. The Phase 1 exit gate was qualified against these tests at an exact revision; see [PHASE1_QUALIFICATION.md](PHASE1_QUALIFICATION.md). Phase 2A added Vitest suites for `packages/protocol` (envelope, version, field, sequence, payload, identifier, malformed-JSON, and prototype-pollution validation) and `services/signaling` (room store with an explicit clock and injected randomness, connection state machine, sequencing, rate and violation bounds, secret and identifier leakage, configuration, and a real server on an ephemeral loopback port with real WebSocket clients covering health, origin, path and query policy, room flows, disconnects, expiry, oversized and binary messages, flooding, and resource cleanup), plus smoke tests of each built package. They are Node and loopback evidence only: not browser, device, WebRTC, or real-network evidence. Phase 2B extended both suites with negotiation (byte-accurate UTF-8 bounds, negotiation IDs, SDP and candidate bounds, role and stale-negotiation rules, candidate limits, relay size, rate limits, and the absence of SDP or candidate text from logs and errors), added web Vitest suites for the signaling client, peer session, room controller, and room UI using deterministic fake WebSocket and `RTCPeerConnection` interfaces (sequences, parsing, fail-closed handling, the bounded candidate queue, channel validation, the handshake, stale callbacks across rooms and guests, cleanup, and no reconnect), and added Playwright tests in which two or three independent browser contexts use a real local signaling service through the preview server's same-origin proxy and real `RTCPeerConnection` and `RTCDataChannel` objects with no ICE server. Those cover the happy path with handshake traffic in both directions, a wrong invite, a third participant, guest and host departure, a fresh negotiation for a new guest, the invite controls, and narrow and desktop layout, while observing media calls, requests, sockets, CSP violations, storage, and console output. They are `AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE`: not real-network, NAT-traversal, TURN, device, or compatibility evidence, and they record no selected ICE path. Phase 2C added the evidence categories listed under [Implemented Phase 2C evidence](#implemented-phase-2c-evidence). The rest of this plan is not yet implemented. Phase 0 has separate passing spike tests and controlled desktop browser evidence in [the result records](../spikes/phase0/), but those results do not satisfy physical-device or real-network gates. Each future product result must record application revision, browser/device versions, network conditions, media characteristics, and whether WebRTC used direct P2P or TURN relay.

## Implemented Phase 2C evidence

None of the following is real-network, NAT-traversal, TURN, mobile, physical-device, or compatibility evidence.

- **Protocol (Node).** Session ID, resume secret, challenge, and proof formats; a pure base64url codec checked against Node; the 76-byte resume proof input against a fixed vector computed independently in Python, reproduced by Node's crypto and by Web Crypto; every new message's exact fields, missing and extra fields, malformed identifiers, byte bounds, direction restrictions, and snapshot consistency rules; the session-bound peer handshake.
- **Signaling resume and replay security (Node, fake clock).** Stable membership independent of connections; resume by challenge and proof; one indistinguishable `SESSION_UNAVAILABLE` for a wrong proof, a fake session, a fake participant, an expired room, an ended grace period, an ended membership, and a still-connected participant; consumed and expiring challenges; captured proofs that answer no other challenge and cannot resume after a later loss; no takeover of a live connection; a powerless old connection; the sequence reset; policy closures that are terminal; the service-side proof verifier against the fixed vector.
- **Deterministic grace, timeout, and expiry.** Explicit clocks and a manually ticked scheduler — no sleeps — for exactly-at-deadline guest timeout and host room closure, simultaneous loss of both participants, room expiry overriding grace, challenge expiry, the room cap, the liveness check, and cleanup to zero retained state.
- **Loopback WebSocket integration.** Real sockets for guest and host resume, wrong proofs, fake sessions, replayed proofs, a second socket against a live participant, timeouts through the sweep, room expiry, a policy-terminated connection, a client that never answers protocol pings, and the absence of secrets, proofs, challenges, and identifiers from logs; plus a resume round trip in the built-service smoke test.
- **Browser reconnect and recovery units (jsdom, fake sockets, peer connections, and timers).** The bounded schedule, backoff, per-attempt timeout, exhaustion into a safe terminal state, and cancellation on leave, room end, resume, and shutdown with exactly one schedule; a working peer session kept through a signaling outage with no new connection or negotiation; reconciliation that closes a mismatched session and converges on the snapshot; abandonment of interrupted negotiations; peer failure during an outage; host and guest recovery with fresh sessions, the host's recovery wait, refusal of stale negotiations, and the four-negotiation bound; the Web Crypto prover against the fixed vector; status wording and no persistence.
- **Same-host browser reconnect.** Playwright with real browser contexts, the real signaling service, real WebSockets, and real `RTCPeerConnection`/`RTCDataChannel` objects: the application's real socket closed from the page (with Chromium's offline emulation holding the outage open where needed), guest and host resume, both participants at once, ten consecutive cycles in one room, identity continuity checked from the service's own messages, BEGIN → CHALLENGE → PROVE → RESUMED on every resumed socket with no frame carrying the resume secret, the same data channel kept open, one live socket, no media, and empty storage.
- **Same-host peer data-channel recovery.** The real channel closed from the page: a fresh peer connection, negotiation, channel, and handshake carrying data both ways for the same room session; recovery combined with a signaling outage; three recoveries then a safe failed state at the bound; and the recovery happy path repeated ten consecutive times with retries disabled.

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

The signaling service's room lifecycle and negotiation relay are covered by loopback integration tests (Phases 2A and 2B), and same-host signaling-to-WebRTC negotiation by browser tests (Phase 2B). Planned integration coverage includes reconnect reconciliation, protocol compatibility, two-client synchronization, transfer reassembly, storage adapters, MSE append behavior, and cleanup. Tests must keep signaling, sync, and transfer failures independently observable.

### Browser Automation

Playwright was selected in Phase 1 and currently runs Chromium tests against the production build of `apps/web/`: application-shell and PWA tests, local-player tests that choose small synthetic video fixtures (VP8/WebM, and MP4 with H.264/AAC) through the file input, and capability-report tests. Phase 2B added room and WebRTC tests that start a loopback signaling service alongside the preview server. Setting `DRIFTLESS_E2E_CHROME=1` also runs them in a locally installed Google Chrome; that is the same engine. Other desktop engines are not yet configured. It should exercise room flows, file selection using controlled fixtures, readiness, playback controls, reconnect UI, capability fallbacks, chat/reactions, and error states across supported desktop engines.

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

Phase 2C implements, in same-host automation only, injected signaling loss, peer connection and data-channel loss, and their combination; see [above](#implemented-phase-2c-evidence). Real-network injection remains required. Inject signaling loss, peer connection loss, ICE restart (not used by Phase 2C, which replaces failed sessions), TURN transition where available, host disappearance, guest disappearance, browser backgrounding, data-channel closure, storage eviction, quota failure, parser rejection, and MSE append errors. Verify explicit state reconciliation and safe cleanup rather than assuming transport reconnection restores application state.

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
