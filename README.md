# Driftless

Driftless is an experimental, private, peer-to-peer application for synchronized video watching across different locations. It is web-first, initially optimized for two participants, and intended to support at most three participants after the two-person experience is stable.

> **Status: Phase 1 — Application Foundation in progress.** Phase 0 software feasibility closed after Spikes 0.1–0.7 and final independent review validated the architecture in controlled software testing; no architecture change was required. The production web client under `apps/web/` currently provides only an application shell, PWA foundation, and automated test baseline. It cannot yet select, play, or synchronize media. Physical Android and real external-network qualification remain deferred.

## Goals

- Keep private media on participant devices wherever the network path permits.
- Synchronize playback reliably across real-world networks.
- Support a no-transfer workflow when every participant already has the media.
- Investigate progressive peer-to-peer delivery when only the host has the media.
- Provide clear capability detection and honest fallbacks across supported browsers.
- Establish two-person reliability before extending rooms to a third participant.

## Media modes

### Mode A - Local Sync

Each participant selects the same local video file. Driftless exchanges control and state data only: play, pause, seek, playback timestamps, synchronization heartbeats, drift correction, readiness, chat, and reactions. No media file is transferred. Initial synchronization is host-authoritative.

**Planned:** media matching, room readiness, synchronized controls, drift correction, chat, and reactions.

**Implemented:** none.

### Mode B - Progressive Watch

Only the host has the media file. Supported media is planned to transfer over a WebRTC data channel so the guest can begin playback after an initial buffer is available while the remainder continues transferring. Planned later behavior includes resumable transfer, seek-aware segment prioritization, browser-local caching, interruption recovery, and integrity verification.

The initial compatibility target is **MP4 with H.264/AVC video and AAC audio**. This is a target, not a claim of tested support. Arbitrary containers and codecs are not supported goals.

**Planned:** product-shaped progressive buffering and later production hardening, subject to the remaining device, network, and phase gates.

**Implemented:** none.

## Planned architecture

The accepted baseline is TypeScript, React, Vite, a Progressive Web App, and the HTML5 video element. WebRTC and `RTCDataChannel` are planned for peer communication. Phase 0 provided controlled desktop evidence for MSE, OPFS, and MP4Box.js, but their production use remains subject to later design and qualification.

A small signaling service will coordinate room entry and WebRTC negotiation. STUN will help establish direct connections. TURN will relay traffic when direct connectivity is impossible; this may include media traffic and therefore has bandwidth and cost implications. Signaling should not normally carry or permanently store media.

The [architecture](docs/ARCHITECTURE.md) keeps signaling, synchronization, and media transfer logically independent.

## Privacy principles

- Prefer direct peer-to-peer media paths.
- Do not permanently store user media on the application backend during normal operation.
- Exchange no media in Local Sync mode.
- Minimize signaling metadata and log sensitive data only when explicitly justified.
- Treat peers as untrusted even though WebRTC transport is encrypted.
- Remove local cached media through explicit lifecycle and cleanup rules.

## Platform and media targets

Initial Tier 1 targets are Chrome desktop, Edge desktop, and Chrome on Android. Firefox desktop and Android are Tier 2 investigation targets. Safari on macOS and iOS, and other browsers, are Tier 3. Product compatibility remains **NOT TESTED**; controlled Phase 0 Chrome results are spike evidence, not support claims. See the [compatibility policy](docs/COMPATIBILITY.md).

Progressive Watch is a runtime-detected capability. A browser or device that can run the application may still be unable to use Progressive Watch.

## Development status

The project version is `0.0.0-planning`. Phase 0 software feasibility closed after final independent review and the merge of [PR #1](https://github.com/arunachaleswaranms/Driftless/pull/1) into `main`. Isolated Spikes 0.1–0.7 and their evidence remain under `spikes/phase0/`. Physical Android and real external-network qualification remain open as `DEFERRED-PHYSICAL-001` through `007`. No production signaling service, synchronization engine, binary transfer engine, or Progressive Watch implementation has been initialized.

Phase 1 — Application Foundation is **IN PROGRESS**. The React/TypeScript/Vite web client in [`apps/web/`](apps/web/) contains an application shell with placeholder local-video and capability areas, a web app manifest and service worker registration without offline caching, and a baseline of type checking, linting, formatting, unit/component tests, and Playwright browser smoke tests. Local file selection, playback, media metadata, and capability detection are not implemented yet. Physical-device and real-network qualification remains deferred.

## Documentation

- [Project charter](docs/PROJECT_CHARTER.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Conceptual protocol](docs/PROTOCOL.md)
- [Media pipeline](docs/MEDIA_PIPELINE.md)
- [Roadmap and phase gates](docs/ROADMAP.md)
- [Security baseline](docs/SECURITY.md)
- [Test plan](docs/TEST_PLAN.md)
- [Compatibility policy](docs/COMPATIBILITY.md)
- [Authoritative project state](PROJECT_STATE.md)
- [Architecture decision records](docs/adr/)
- [Planning document index](docs/planning/README.md)

The master planning document is retained unchanged under `docs/planning/` as the original baseline. [PROJECT_STATE.md](PROJECT_STATE.md) records current execution status, and [ROADMAP.md](docs/ROADMAP.md) records phase progression.

## Roadmap summary

Work is organized into gated phases: feasibility, application foundation, internet peer-to-peer foundations, Local Sync, room reliability, Progressive Watch spikes and productionization, cross-browser hardening, three-person rooms, and v1.0 hardening. See [ROADMAP.md](docs/ROADMAP.md) for scope and exit gates.

## Contributing

The contribution process and governance model have not been selected. Until they are documented, discuss substantial changes before implementation and keep proposals aligned with the accepted ADRs and phase gates.

## License

No license has been selected. All rights remain with the copyright holder until a license file is added.
