# Roadmap

## Roadmap Rules

- Work proceeds through explicit phases and exit gates.
- A phase is not complete because its code exists; its exit evidence must be recorded.
- Real-device and real-network requirements cannot be replaced by simulation.
- Thresholds and compatibility claims must come from measurements.
- Later phases may be replanned when an earlier feasibility gate fails.

The current state is **Phase 0 — Architecture & Feasibility: SOFTWARE FEASIBILITY CLOSED / PASS**. **Phase 1 — Application Foundation: CLOSED / PASS** (exit gate PASS). **Phase 2 — Internet P2P Foundation: IN PROGRESS** — Phases 2A, 2B, and 2C implemented and reviewed, Phase 2D implemented with its qualification NOT CLOSED (no physical Android device or public TURN server was available); the Phase 2 exit gate has not passed.

- Spikes 0.1–0.7 completed their software-feasibility questions in controlled testing. Their individual results remain provisional where physical Android or external-network validation was deferred. Spike 0.6 passed independent re-review and was committed at `7bbb10f`.
- Spike 0.7's first independent review returned `REQUEST CHANGES — DO NOT COMMIT` for host scheduling and stale closure documentation. The fixes and regressions passed final independent review: `PASS — SAFE TO COMMIT AND CLOSE PHASE 0 SOFTWARE FEASIBILITY`. The reviewed implementation was committed at `e1ea11b`, and [PR #1](https://github.com/arunachaleswaranms/Driftless/pull/1) merged into `main` at `17eea6a`.
- No architecture change was required. Physical Android and external-network qualification debts `DEFERRED-PHYSICAL-001` through `DEFERRED-PHYSICAL-007` remain open. This software gate does not establish product readiness or browser support.

## Phase 0 — Architecture & Feasibility

Technical spikes:

- Large local browser media playback.
- WebRTC connection.
- RTCDataChannel.
- Binary transfer.
- Real Android Chrome participant.
- Browser storage investigation.
- MP4 parsing/segmentation.
- MSE playback of received fragments.

**Software-feasibility gate — CLOSED / PASS:** Controlled desktop results for Spikes 0.1–0.7 made the Progressive Watch architecture plausible. Final independent review passed, and no architecture change was required.

**Original physical/device exit criterion — OPEN / DEFERRED:** The original master plan and this roadmap call for a real Android Chrome participant, real-network evidence, resource observations, and browser-limit qualification. The software closure did not satisfy that physical criterion. It remains tracked as `DEFERRED-PHYSICAL-001` through `007` and must be resolved at the applicable later device/network gates before any corresponding support or readiness claim. The master plan's full Phase 0 gate wording is retained as the baseline; this split records the actual software-only closure and deferred qualification without changing future phase scope.

## Phase 1 — Application Foundation

- Web/PWA skeleton.
- Local player.
- File selection.
- Playback controls.
- Media metadata.
- Capability detection.
- Automated test baseline.

**Status — CLOSED / PASS:** The following exist in `apps/web/`:

- Phase 1A: the web/PWA skeleton and automated test baseline.
- Phase 1B: the local player, with file selection, native playback controls, media metadata, and error and lifecycle handling.
- Phase 1C: capability detection, as a local report of runtime API observations that makes no browser support claim and enables or disables no mode.

Phase 1D qualification evaluated the exit gate at revision `4bf6e311723ff3c59dc47d9b3b108c9006f0d7a3`, as five criteria: installable foundation, selection, playback, capability reporting, and automated baseline. All five passed, with synthetic VP8/WebM and MP4/H.264/AAC local media, in the repository's development browsers, Playwright Chromium 153 and Google Chrome 154. See [PHASE1_QUALIFICATION.md](PHASE1_QUALIFICATION.md).

The pass is a development gate. It changes no [compatibility](COMPATIBILITY.md) status and closes no `DEFERRED-PHYSICAL` debt. It includes no Edge, Firefox, Safari, Android, or real-network result.

**Exit gate:** The installable web foundation can select and play representative local media on target development browsers, reports capabilities accurately, and has an automated test baseline. No synchronized or progressive behavior is implied.

## Phase 2 — Internet P2P Foundation

- Signaling.
- Rooms.
- WebRTC negotiation.
- STUN.
- RTCDataChannel.
- Disconnect/reconnect.
- Diagnostics.

**Status — IN PROGRESS.** Phase 2 is delivered in four parts:

| Part     | Scope                              | Status                                 |
| -------- | ---------------------------------- | -------------------------------------- |
| Phase 2A | Protocol & signaling foundation    | Implemented — review pass              |
| Phase 2B | Room join & WebRTC negotiation     | Implemented — review pass              |
| Phase 2C | Connection lifecycle & reconnect   | Implemented — review pass              |
| Phase 2D | Diagnostics / real-network closure | Implemented — qualification not closed |

Phase 2A added the shared protocol package (versioned envelope, room messages, strict validation), an ephemeral in-memory signaling service with two-person rooms, separate room IDs and 256-bit invite secrets, expiry, and bounded, origin-checked WebSocket traffic, and a root npm workspace. It has only Node unit and loopback integration evidence, and passed independent review.

Phase 2B added the browser room UI and signaling client, WebRTC negotiation relayed by the service with fixed roles, a negotiation ID, and explicit SDP and ICE bounds, trickle ICE, a STUN configuration boundary (no server by default), and one ordered, reliable data channel confirmed by a handshake in both directions. Its browser evidence is automated, with two browser contexts on one development machine. It passed independent review.

Phase 2C added authenticated signaling resume — a separate per-participant resume secret answered by challenge and proof, never resent — with stable participant identity, a bounded reconnect grace period, a bounded browser retry schedule, snapshot reconciliation with no replay, a working data channel kept through signaling loss, and recovery of a failed peer transport by a fresh peer connection and negotiation (no `restartIce()`), bounded to four negotiations per guest membership. Its evidence is automated: Node, loopback, jsdom, and two browser contexts on one development machine. It passed independent review.

Phase 2D added browser-local connection diagnostics — states, the selected ICE path classified as direct, TURN relay, or unknown from `getStats()`, candidate types, and counts, with no address exposed and nothing sent anywhere — and short-lived TURN credentials issued by the signaling service to authenticated room members with the provider-neutral TURN REST scheme ([ADR-0007](adr/0007-ephemeral-turn-credentials.md)), a qualification-only relay policy, and a deployment boundary ([DEPLOYMENT.md](DEPLOYMENT.md)). Its automated evidence is Node, loopback, jsdom, and two browser contexts on one development machine. Its qualification at `aeb7f96` on 2026-10-02 is **NOT CLOSED** ([PHASE2_QUALIFICATION.md](PHASE2_QUALIFICATION.md)): a public HTTPS/WSS smoke test passed from one device, but no physical Android device was available for the two-device, different-network session and its recovery, and no publicly reachable TURN server exists for the forced-relay criteria. **The Phase 2 exit gate has not passed.**

**Exit gate:** Two real devices on different networks establish and recover an authenticated WebRTC data-channel session. Evidence records whether the selected path is direct P2P or TURN relay.

## Phase 3 — Local Sync Mode

- Authoritative clock.
- Play.
- Pause.
- Seek.
- Heartbeat.
- Drift detection.
- Drift correction.
- Readiness.
- Media fingerprinting.

**Exit gate:** Two real devices with matching local media complete defined long-duration and network-condition tests with acceptable synchronization and no media transfer. Acceptance thresholds must be documented before the gate is evaluated.

## Phase 4 — Room Reliability & UX

- Secure invites.
- Reconnect.
- Host disconnect handling.
- Error UX.
- Chat.
- Reactions.
- Validation.
- Diagnostics.

**Exit gate:** Two-person rooms handle the documented disconnect, malformed-input, expired-invite, and user-error scenarios without losing authority or leaking sensitive information, and diagnostics support field triage.

## Phase 5 — Progressive Watch Technical Spike

- MP4.
- Fragmentation.
- MSE.
- Binary transport.
- Backpressure.
- Cache.
- OPFS.
- Seeking.

**Exit gate:** An integrated two-device spike progressively plays representative target media, demonstrates bounded transport backpressure and seek reprioritization, records storage/MSE behavior, and identifies unsupported cases. A go/no-go decision for productionization is documented.

Phase 0 tests architectural plausibility early; Phase 5 tests the integrated product-shaped pipeline after the foundational phases. Neither is a compatibility claim by itself.

## Phase 6 — Progressive Watch Productionization

- Resumable transfer.
- Adaptive buffering.
- Seek prioritization.
- Missing-chunk recovery.
- Integrity verification.
- Progress reporting.
- Storage handling.
- Network interruption recovery.

**Exit gate:** Progressive Watch meets documented reliability, integrity, memory/storage, reconnect, and network-matrix criteria on approved target platforms, with direct-versus-TURN evidence and clear unsupported-media behavior.

## Phase 7 — Cross-Browser Hardening

- Execute the compatibility matrix across target browser tiers.
- Resolve or document browser-specific playback, WebRTC, storage, and lifecycle behavior.
- Harden capability detection and fallbacks.
- Validate upgrade, PWA, accessibility, and responsive behavior.

**Exit gate:** Support claims in [COMPATIBILITY.md](COMPATIBILITY.md) are backed by versioned evidence, known limitations are documented, and unsupported combinations fail clearly.

## Phase 8 — Three-Person Rooms

This is a conditional future phase after two-person stability, not part of the initial MVP.

- Select topology based on measured sender, relay, and device constraints.
- Define authority, readiness, and reconnect semantics for a third participant.
- Enforce a maximum of three active participants.
- Repeat network, load, synchronization, and privacy testing.

**Exit gate:** Three real participants complete the defined cross-network reliability matrix without regressing two-person rooms, and topology/cost evidence is documented.

## Phase 9 — v1.0 Hardening

- Resolve release-blocking defects and security findings.
- Freeze supported protocol and migration policy for v1.0.
- Complete accessibility, privacy, operational, recovery, and release documentation.
- Validate production signaling and STUN/TURN operations.
- Re-run supported-platform, long-duration, and adverse-network gates.

**Exit gate:** All v1.0 support claims have current evidence, release security and operational reviews are complete, no unresolved release blockers remain, and the project state records the exact releasable revision.

## Future and Post-v1 Candidates

These are not committed v1.0 features: capabilities beyond three participants, voice/video calling, broader container/codec support, native applications, advanced moderation, and optional media-processing services. Public media hosting, public room discovery, DRM bypass, protected-service rebroadcasting, and routine permanent backend media storage remain out of scope rather than roadmap promises.
