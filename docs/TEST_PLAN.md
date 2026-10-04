# Test Plan

## Status and Purpose

Phase 2 software implementation is **MERGED / COMPLETE / REVIEW PASS** at `2dd7dea8798bcfc742c8902e853cef69c053eecd`. Its implemented automated regression is separate from **DEFERRED / NOT CLOSED** physical/network qualification; the literal physical exit gate is **NOT PASSED**. Phase 3 is IN PROGRESS; Phase 3A implements identity/readiness only and its overall physical synchronization exit gate remains NOT PASSED. Later software milestones do not satisfy the deferred release-level qualification gates.

At the latest recorded qualification revision, `3a5922200ab0a77a1dd55d9d911a79a492971874` (2026-10-04), regression passed with 234 protocol, 206 signaling, and 330 web Vitest tests; 120 supplemental Phase 0 Node tests; Playwright Chromium 50/50; and the installed-Chrome opt-in 100/100 (50 Chromium plus 50 Chrome), retries 0. Both audits reported 0 vulnerabilities. These recorded counts are software evidence; see [PHASE2_QUALIFICATION.md](PHASE2_QUALIFICATION.md) for exact conditions.

This is the planned product verification strategy. The production web client in `apps/web/` has a Phase 1 automated baseline of Vitest unit/component tests and Playwright Chromium tests covering the application foundation, the local media player, and capability reporting: local file selection, reported metadata, playback, pause, seek, replacement, clear/reset, object URL lifecycle and resource release, application-shell smoke coverage, and capability detection. Capability tests check the detector against synthetic environments with APIs present, absent, or blocked, compare the report with the test browser's own globals, and confirm that detection causes no request, prompt, WebRTC connection, or storage change. These Chromium results are development-browser evidence only; they do not satisfy physical-device, broad-browser, real-network, or product-support gates. The Phase 1 exit gate was qualified against these tests at an exact revision; see [PHASE1_QUALIFICATION.md](PHASE1_QUALIFICATION.md). Phase 2A added Vitest suites for `packages/protocol` (envelope, version, field, sequence, payload, identifier, malformed-JSON, and prototype-pollution validation) and `services/signaling` (room store with an explicit clock and injected randomness, connection state machine, sequencing, rate and violation bounds, secret and identifier leakage, configuration, and a real server on an ephemeral loopback port with real WebSocket clients covering health, origin, path and query policy, room flows, disconnects, expiry, oversized and binary messages, flooding, and resource cleanup), plus smoke tests of each built package. They are Node and loopback evidence only: not browser, device, WebRTC, or real-network evidence. Phase 2B extended both suites with negotiation (byte-accurate UTF-8 bounds, negotiation IDs, SDP and candidate bounds, role and stale-negotiation rules, candidate limits, relay size, rate limits, and the absence of SDP or candidate text from logs and errors), added web Vitest suites for the signaling client, peer session, room controller, and room UI using deterministic fake WebSocket and `RTCPeerConnection` interfaces (sequences, parsing, fail-closed handling, the bounded candidate queue, channel validation, the handshake, stale callbacks across rooms and guests, cleanup, and no reconnect), and added Playwright tests in which two or three independent browser contexts use a real local signaling service through the preview server's same-origin proxy and real `RTCPeerConnection` and `RTCDataChannel` objects with no ICE server. Those cover the happy path with handshake traffic in both directions, a wrong invite, a third participant, guest and host departure, a fresh negotiation for a new guest, the invite controls, and narrow and desktop layout, while observing media calls, requests, sockets, CSP violations, storage, and console output. They are `AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE`: not real-network, NAT-traversal, TURN, device, or compatibility evidence, and they record no selected ICE path. Phase 2C added the evidence categories listed under [Implemented Phase 2C evidence](#implemented-phase-2c-evidence), and Phase 2D those under [Implemented Phase 2D evidence](#implemented-phase-2d-evidence). The rest of this plan is not yet implemented. Phase 0 has separate passing spike tests and controlled desktop browser evidence in [the result records](../spikes/phase0/), but those results do not satisfy physical-device or real-network gates. Each future product result must record application revision, browser/device versions, network conditions, media characteristics, and whether WebRTC used direct P2P or TURN relay.

## Implemented Phase 3A automated evidence

Exact commands, counts, versions, and repeated-run evidence are recorded in [PHASE3A_IMPLEMENTATION.md](PHASE3A_IMPLEMENTATION.md). All browser results are **AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE**. No Android, real-network, long-duration synchronization or physical gate is evaluated; deferred debts remain OPEN.

- Protocol: canonical selection IDs/fingerprints, all five peer messages, exact/missing/extra/prototype fields, malformed context, enum/version/length/integer/16-GiB limits, UTF-8 size and largest legal peer messages, signaling-direction exclusion.
- Fingerprinting: independent Node-crypto fixed vectors for one byte, exact chunk, chunk+1, multiple chunks, first/middle/last byte differences and different sessions; empty rejection, names/MIME independence, exact sequential coverage, one read/digest active, <=4-MiB reads, preflight oversize refusal, cancellation and fixed errors. Built-package GC smoke verifies source buffers become collectible.
- Pure state: every setup/readiness/blocking transition, metadata/error gates, explicit Ready/withdrawal, matching byte length and fingerprint, current pair binding, local/remote replacement, clear, late callbacks/stale messages, recovery reannouncement and new Ready choices.
- Browser/controller: existing File/player state shared without duplicated input, already-loaded media before room entry, progress/failure/cancellation, remote changes, fresh peer recovery and healthy-channel signaling preservation. PeerSession application/context/sequence/handshake validation and stale teardown handlers.
- Peer application abuse: deterministic receiver-clock tests for the full 32-message burst after handshake, 8/second refill, fractional/partial allowance, capacity clamp, identical timestamps, backwards clock/catch-up, and peer `sentAt` independence. All five application types share the bucket. The first excess valid message tears down once with `application_rate_limit`, with no application dispatch, outbound error response, or later stale callback action. Fresh sessions reset allowance; malformed/binary/unknown/version/context/sequence violations remain `peer_protocol`, including when the bucket is empty. Controller integration proves channel-loss readiness invalidation, retained local fingerprint, normal Phase 2C recovery, reannouncement and new Ready choices. A real browser-channel flood regression proves receiver teardown and fresh recovery without a production test hook; unit tests are authoritative for exact token timing. Legitimate setup message counts stay below half a burst per peer.
- Two independent browser contexts with real loopback signaling and real WebRTC: same bytes/different filenames, two playable differing fixtures, explicit Ready with video still paused, replacement/re-match/Ready again, clear, actual channel closure and fresh reannouncement, signaling-only reconnect without rehash/reset. Instrumentation installed before the app confirms text-only bounded JSON, no filename/private metadata, no whole-file application read, bounded slices, no upload HTTP requests, no Local Sync signaling traffic, and empty persistent storage.
- Matching and fresh recovery happy paths each repeat ten times with retries 0. The complete Chromium regression repeats three times with retries 0; installed Chrome also runs through the existing opt-in.

## Implemented Phase 2D evidence

The automated categories below are not real-network, NAT-traversal, mobile, physical-device, or compatibility evidence, and a loopback TURN server is not relay-across-networks evidence. The real-device and real-network categories are recorded, with their outcome, only in [PHASE2_QUALIFICATION.md](PHASE2_QUALIFICATION.md).

- **Stats parser and path classification (jsdom, synthetic reports).** Synthetic `RTCStatsReport`-like maps shaped like Chromium and Firefox output: the selected pair through `transport.selectedCandidatePairId`; host, srflx, and prflx pairs as `DIRECT`; a relay candidate on the local side, the remote side, or both as `TURN_RELAY`; a single pair marked `selected` when no transport names one; and `UNKNOWN` for no selected pair, ambiguous or conflicting selected pairs, a missing or non-pair selected ID, a pair that has not succeeded (including `failed`, and `in-progress` without check responses; `in-progress` with responses, Chrome's report of a working pair during a re-check, is classified), a missing or wrong-kind candidate, an unfamiliar candidate type, unknown browser fields, an empty, non-object, or throwing report. Recognizable addresses, ports, URLs, candidate strings, and username fragments in every report are checked never to reach the result.
- **Diagnostics lifecycle (jsdom, fakes).** One statistics read when a session connects and none afterwards over an hour of fake time; reads only on explicit refresh; `UNKNOWN` without any effect on the room, the session, or signaling when `getStats()` rejects or returns an unfamiliar shape; after peer recovery, the old snapshot discarded at failure, a late read of the old connection ignored, and the new connection read with its new path and negotiation count; cleared when the room ends; separate subscriptions for diagnostics and room state. Component tests of the collapsed section, its safe fields, refresh, and the copied summary, with no address, identifier, or secret.
- **ICE configuration protocol (Node).** `RTC_CONFIG_REQUEST` and `RTC_CONFIG` exact fields, direction, entry and URL bounds, accepted and refused schemes and URL forms, credentials required on TURN entries and forbidden on STUN entries, username and credential bounds, mixed or duplicate URLs, unknown and prototype fields, and no credential echoed in a parse failure.
- **TURN credential issuance (Node).** A fixed vector computed independently with Python's `hmac` and checked with `openssl dgst -sha1 -hmac`; the credential a TURN server recomputes from the username; different credentials for another participant, time, and secret; expiry in whole seconds capped at the configured lifetime and the room's expiry; STUN-only and empty configurations; no secret or participant ID in what is issued. Controller and loopback WebSocket tests: issuance to a host and a guest on their own connections only; refusal for a connection in no room, after leaving, with a pending resume challenge, and after a refused proof, without consuming the challenge; issuance after an accepted resume; the per-connection bound; and no TURN username, credential, URL, or secret in the logs. Configuration tests for the secret file and inline secret, their mutual exclusion, weak, malformed, and unreadable secrets without echo, URL schemes, and the lifetime bounds; a resume round trip with `RTC_CONFIG` in the built-service smoke test.
- **Runtime configuration in the browser (jsdom, fakes).** The request only after admission and never while opening or resuming; the host's offer and the guest's answer waiting for the configuration, with the guest's early candidates held; build-time STUN, service STUN, and TURN merged into the peer connection; the bounded wait and connection without TURN; unusable lifetimes; an unrequested `RTC_CONFIG` ignored; a fresh credential fetched before a recovery near expiry; the configuration forgotten with the membership; pending starts and timers dropped; no credential in the room state, diagnostics, or export; the relay policy passed through, and a relay-only session without TURN failing at once within the negotiation bound.
- **Same-host browser diagnostics (Playwright).** Real browser contexts and real `RTCPeerConnection`s with the local service and no ICE server: the diagnostics' path and candidate types match the browser's own selected pair; one read per side when connected and none during a wait; one more on refresh; one `RTC_CONFIG_REQUEST` per side after admission; no diagnostic content in any signaling frame; a copied summary of exactly the safe fields; the new connection described after peer recovery; and `UNKNOWN` with the room, channel, and signaling untouched when `getStats()` fails. These are same-host pairs; they are not path evidence for any real network.
### Deferred Phase 2 physical qualification

**DEFERRED / NOT CLOSED:** Two real devices on separate Internet access networks through the public HTTPS/WSS deployment: room creation and join, the data channel and the bidirectional handshake, selected-path evidence (`DIRECT` or `TURN_RELAY`) on both peers, forced-relay establishment and diagnostics through a publicly reachable TURN endpoint (T3/T4), and recovery after a genuine network disruption. Record the exact revision, devices, browser versions, and network categories in [PHASE2_QUALIFICATION.md](PHASE2_QUALIFICATION.md). T1/T2 are PASS for software only; T3/T4 remain GAP / DEFERRED because no public TURN service was available. Supplemental loopback pion/turn evidence does not satisfy them.

The physical OnePlus Nord 5 was identified (`CPH2707`, Android 16, Chrome 154.0.8037.92), but cellular / Wi-Fi-off cross-network operation was not executed. Real-device RTCDataChannel establishment, selected path, and real recovery remain unobserved (G1–G5 GAP). `DEFERRED-PHYSICAL-002` remains OPEN, as do `001` and `003`–`007`. ADB visibility, same-host tests, emulators, and desktop network emulation cannot close this debt or change compatibility. These requirements remain mandatory before final product/release qualification.

## Implemented Phase 2C evidence

None of the following is real-network, NAT-traversal, TURN, mobile, physical-device, or compatibility evidence.

- **Protocol (Node).** Session ID, resume secret, challenge, and proof formats; a pure base64url codec checked against Node; the 76-byte resume proof input against a fixed vector computed independently in Python, reproduced by Node's crypto and by Web Crypto; every new message's exact fields, missing and extra fields, malformed identifiers, byte bounds, direction restrictions, and snapshot consistency rules; the session-bound peer handshake.
- **Signaling resume and replay security (Node, fake clock).** Stable membership independent of connections; resume by challenge and proof; one indistinguishable `SESSION_UNAVAILABLE` for a wrong proof, a fake session, a fake participant, an expired room, an ended grace period, an ended membership, and a still-connected participant; consumed and expiring challenges; captured proofs that answer no other challenge and cannot resume after a later loss; no takeover of a live connection; a powerless old connection; the sequence reset; policy closures that are terminal; the service-side proof verifier against the fixed vector.
- **Deterministic grace, timeout, and expiry.** Explicit clocks and a manually ticked scheduler — no sleeps — for exactly-at-deadline guest timeout and host room closure, simultaneous loss of both participants, room expiry overriding grace, challenge expiry, the room cap, the liveness check, and cleanup to zero retained state.
- **Loopback WebSocket integration.** Real sockets for guest and host resume, wrong proofs, fake sessions, replayed proofs, a second socket against a live participant, timeouts through the sweep, room expiry, a policy-terminated connection, a client that never answers protocol pings, and the absence of secrets, proofs, challenges, and identifiers from logs; plus a resume round trip in the built-service smoke test.
- **Browser reconnect and recovery units (jsdom, fake sockets, peer connections, and timers).** The bounded schedule, backoff, per-attempt timeout, exhaustion into a safe terminal state, and cancellation on leave, room end, resume, and shutdown with exactly one schedule; a working peer session kept through a signaling outage with no new connection or negotiation; reconciliation that closes a mismatched session and converges on the snapshot; abandonment of interrupted negotiations; peer failure during an outage; host and guest recovery with fresh sessions, the host's recovery wait, refusal of stale negotiations, and the four-negotiation bound; the Web Crypto prover against the fixed vector; status wording and no persistence.
- **Same-host browser reconnect.** Playwright with real browser contexts, the real signaling service, real WebSockets, and real `RTCPeerConnection`/`RTCDataChannel` objects: the application's real socket closed from the page (with Chromium's offline emulation holding the outage open where needed), guest and host resume, both participants at once, ten consecutive cycles in one room, identity continuity checked from the service's own messages, BEGIN → CHALLENGE → PROVE → RESUMED on every resumed socket with no frame carrying the resume secret, the same data channel kept open, one live socket, no media, and empty storage.
- **Terminal leave while reconnecting.** Browser units for guest and host leave during a signaling outage (peer closed at once; resume used only for `ROOM_LEAVE`; no restoration, negotiation, or recovery; credentials discarded; no timers left), an attempt in flight, a resume accepted just before Leave, a proof still being computed, `SESSION_UNAVAILABLE`, a connection lost before `ROOM_LEFT`, a silent service, a refused leave, an unreachable service exhausting the finite schedule, duplicate Leave, shutdown, and an unchanged connected leave; mutation checks that the old local-only leave fails them. Loopback service tests in which a resumed guest's `ROOM_LEAVE` frees its slot at once and a resumed host's closes the room (with and without a guest) and invalidates the invite and the resume secret. Same-host browser tests in which a guest and a host leave during an emulated outage and the other participant immediately sees the intentional departure; a new guest then joins, or the old invite is refused.
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

The signaling service's room lifecycle and negotiation relay are covered by loopback integration tests (Phases 2A and 2B), same-host signaling-to-WebRTC negotiation by browser tests (Phase 2B), reconnect reconciliation — signaling resume, snapshot reconciliation, and peer recovery — by loopback and same-host browser tests (Phase 2C; see [above](#implemented-phase-2c-evidence)), and ICE configuration issuance and connection diagnostics by loopback and same-host browser tests (Phase 2D). Planned integration coverage includes protocol compatibility across versions, two-client synchronization, transfer reassembly, storage adapters, MSE append behavior, and cleanup. Tests must keep signaling, sync, and transfer failures independently observable.

### Browser Automation

Playwright was selected in Phase 1 and currently runs Chromium tests against the production build of `apps/web/`: application-shell and PWA tests, local-player tests that choose small synthetic video fixtures (VP8/WebM, and MP4 with H.264/AAC) through the file input, and capability-report tests. Phase 2B added room and WebRTC tests that start a loopback signaling service alongside the preview server, Phase 2C reconnect tests, and Phase 2D connection-diagnostics tests. No browser test contacts a public STUN, TURN, or other service. Setting `DRIFTLESS_E2E_CHROME=1` also runs them in a locally installed Google Chrome; that is the same engine. Other desktop engines are not yet configured. It should exercise room flows, file selection using controlled fixtures, readiness, playback controls, reconnect UI, capability fallbacks, chat/reactions, and error states across supported desktop engines.

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
