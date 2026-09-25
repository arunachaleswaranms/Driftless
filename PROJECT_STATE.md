# Project State

This file is the authoritative handoff document for human and automated development sessions. Update it whenever a meaningful implementation or architecture change is accepted. Claims here must reflect repository evidence.

## Project

Driftless

## Current Version

`0.0.0-planning`

## Current Phase

Phase 0 — Architecture & Feasibility

## Phase Status

**IN PROGRESS**

## Current Activity

Spike 0.2 — WebRTC Peer Connectivity

## Current Branch

`phase/0-feasibility`

Verified from Git on 2026-09-25 at `49497fe`. Phase 0 changes are intentionally uncommitted.

## Repository Status

The initial local repository structure exists:

- `apps/web/`
- `services/signaling/`
- `packages/protocol/`
- `packages/sync-engine/`
- `packages/transfer-engine/`
- `docs/adr/`
- `docs/planning/`
- `spikes/phase0/`

The master planning document exists at `docs/planning/Driftless_Master_Project_Plan_v0.1.docx`. The Phase 0 experiment framework and isolated Spike 0.1 and Spike 0.2 browser experiments now exist under `spikes/phase0/`. No production application, signaling service, synchronization engine, transfer engine, binary-transfer implementation, synchronization implementation, or Progressive Watch implementation has been initialized.

## Accepted Architecture

- TypeScript, React, Vite, PWA, and HTML5 video form the planned web-client baseline.
- WebRTC is peer-to-peer-first; `RTCDataChannel` is planned for synchronization data and, in Progressive Watch, media transport.
- A small signaling service coordinates sessions and WebRTC negotiation but should not normally carry or permanently store media.
- STUN supports direct connectivity. TURN is the necessary fallback when direct connectivity fails and can relay media, creating bandwidth and cost exposure.
- Initial playback synchronization is host-authoritative.
- Local Sync and Progressive Watch are independent modes.
- The synchronization plane, media transfer plane, and signaling plane remain logically independent.
- Progressive Watch initially targets MP4 containing H.264/AVC video and AAC audio.
- Progressive playback is enabled only after runtime capability detection.
- MSE, OPFS or other browser storage, and MP4Box.js remain investigation areas, not proven choices.
- Development optimizes for two-person rooms before considering a maximum of three participants.
- The project advances through explicit phase exit gates.

See [Architecture](docs/ARCHITECTURE.md), [Media Pipeline](docs/MEDIA_PIPELINE.md), and the [accepted ADRs](docs/adr/).

## Completed

- Initial directory structure is present.
- Master planning DOCX is present under `docs/planning/`.
- Repository documentation baseline and ADR-0001 through ADR-0006 are present.
- Future-facing `.gitignore` is present.
- Phase 0 experiment tracking exists for Spikes 0.1 through 0.7.
- The isolated Spike 0.1 page implements local `File` to object-URL binding, native video controls, media diagnostics, error display, and object-URL cleanup without application-level whole-file reads or upload code.
- Spike 0.1 deterministic formatter/diagnostic tests pass: 5 tests, 0 failures on Node.js v26.3.0.
- A macOS 26.6.2 / Chrome 153.0.8010.48 smoke run loaded the experiment, reported target MP4/H.264/AAC MIME support as `probably`, initialized diagnostics, and produced no browser console warning/error. It did not exercise local file selection or playback.
- User-reported desktop Chrome evidence confirms local-file selection, compatible local playback, pause/resume, and seeking worked with good overall behavior. Exact file characteristics, seek directions/distances, and memory measurements were not recorded.
- Spike 0.1 is closed at `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`. Its desktop path is accepted from the actual manual evidence, while Android architecture risk and final Android support remain unqualified.
- The isolated Spike 0.2 page establishes two browser `RTCPeerConnection` peers using same-origin, in-memory development signaling and a text-only control data channel. It exposes required connection state, candidate types, selected-pair fields, protocol, RTT, and evidence-based path classification.
- Spike 0.2 deterministic diagnostic tests pass: 5 tests, 0 failures on Node.js v26.3.0.
- `AUTOMATED DESKTOP` validation on macOS 26.6.2 with Chrome 153 established offer/answer, ICE completion, `connected` state, an open data channel, `PING`/`PONG`, selected-pair diagnostics, and clean local cleanup in two same-browser tabs.
- The final selected pair snapshot was host/host over UDP with 1.00 ms RTT reported on each peer. Repeated local runs also observed unselected server-reflexive candidates. These diagnostics do not prove separate-network connectivity or establish a performance baseline.

No product feature is complete, and Phase 0 is not complete. Spike 0.2 has a software-feasibility result of `PROVISIONAL PASS — EXTERNAL NETWORK VALIDATION DEFERRED` pending independent review.

## In Progress

- Independent review of Spike 0.2 implementation and evidence.
- Accumulated physical Android and real external-network qualification remains deferred under the debt list below.

## Not Started

- Spike 0.3 through Spike 0.7 implementation and validation.
- RTCDataChannel binary transfer validation.
- OPFS and browser storage investigation.
- MP4 parsing and segmentation investigation.
- MSE progressive playback investigation.

## Evidence Classification Policy

Use these labels without promotion between categories:

1. `AUTOMATED PASS`
2. `DESKTOP MANUAL PASS`
3. `EMULATOR PASS`
4. `PHYSICAL DEVICE PASS`
5. `DEFERRED PHYSICAL`

Automation and emulator evidence may improve confidence but never satisfy a physical-device gate. If a future spike cannot establish architectural feasibility without a real external device or network, stop and report that limitation.

## Physical Qualification Debt

- `DEFERRED-PHYSICAL-001 — Spike 0.1 Android Chrome local media qualification`: validate file selection, playback, pause/resume, seeks, lifecycle cleanup, errors, and representative large-file resource behavior on physical Android Chrome. Android architecture risk remains unqualified; final Android support cannot be claimed.
- `DEFERRED-PHYSICAL-002 — Spike 0.2 Android Chrome and external-network WebRTC qualification`: validate two real peers on genuinely separate Internet networks, including at least one physical Android participant where applicable, and record selected direct or relay path. Current same-host desktop evidence is not a real-network result.

The project intentionally accumulates these physical Android gates for the later project-wide physical qualification stage. ADB inspection on 2026-09-21 found only `emulator-5554`; no emulator result has been promoted to physical-device evidence.

## Current Blockers

No architecture blocker has been observed. Spike 0.1 has no exact desktop memory measurements and retains physical Android debt. Spike 0.2 proves controlled same-host browser connectivity only; different-NAT, carrier-network, physical Android, and TURN behavior remain unqualified. The selected host/host pair must not be generalized to Internet reachability.

## Open Questions

- Where will production signaling be hosted?
- Will STUN/TURN be self-hosted or provided by a third party?
- What TURN bandwidth, reliability, and cost are practical for progressive media?
- What exact MP4 fragmentation strategy is interoperable across target browsers?
- What transport chunk size and data-channel settings perform reliably?
- How do target browsers behave when storing multi-GB media?
- Is Progressive Watch feasible on Safari macOS and Safari/iOS?
- How does Firefox behave with the proposed progressive playback pipeline?
- What cache persistence and eviction strategy best balances resume behavior and privacy?
- What exact media fingerprint format provides useful matching without excessive cost?
- What topology is appropriate for a third participant?

These questions must be resolved by evidence, not by assumptions or undocumented defaults.

## Next Exact Step

Independent review of Spike 0.2 before beginning Spike 0.3.

Do not begin Spike 0.3, Phase 1, or full product implementation before the applicable review and phase gates.

## Decisions That Must Not Be Accidentally Reverted

- Use a web-first architecture.
- Develop and stabilize two-person rooms first.
- Use host-authoritative synchronization for initial versions.
- Keep Local Sync and Progressive Watch as independent modes.
- Keep playback synchronization and file transfer as separate subsystems.
- Keep permanent server-side media storage outside the normal architecture.
- Prefer peer-to-peer media transfer.
- Initially target MP4 with H.264/AVC video and AAC audio for Progressive Watch.
- Feature-detect progressive capability at runtime.
- Add three-person support only after two-person stability.
- Require real-device Android testing; emulation is not sufficient for the relevant gates.
- Require an explicit exit gate for every phase.

Changes to these decisions require a superseding ADR and corresponding documentation updates.

## Last Updated

2026-09-25
