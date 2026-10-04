# Driftless

Driftless is an experimental, private, peer-to-peer application for synchronized video watching across different locations. It is web-first, initially optimized for two participants, and intended to support at most three participants after the two-person experience is stable.

> **Phase 2 implementation is complete and ready to merge.** Phases 2A–2D are implemented and have passed software review.
>
> Physical Android / different-network / real-recovery / public-TURN qualification is **DEFERRED / NOT CLOSED**. The literal Phase 2 physical exit gate is **NOT PASSED**; see [PHASE2_QUALIFICATION.md](docs/PHASE2_QUALIFICATION.md).
>
> **Phase 3 — Local Sync Mode: NEXT / NOT STARTED**, after the Phase 2 implementation milestone is merged.

Phase 2 provides private two-person rooms, signaling, WebRTC negotiation and a data-channel handshake, authenticated signaling resume, bounded fresh-peer recovery, safe connection diagnostics, runtime ICE configuration, and short-lived TURN credential issuance. Its automated browser evidence uses two contexts on one development machine; it does not qualify Internet connectivity or public TURN operation.

Phase 0 software feasibility and Phase 1 application foundation are closed. The web client provides an application shell, PWA foundation, local video playback, and a local report of observable browser APIs. Synchronization and media transfer remain unimplemented. Compatibility statuses are unchanged.

Physical Android, real-network recovery, and public TURN remain project-level qualification debt. Phase 3 implementation may proceed after the Phase 2 implementation merge, but final product/release closure must revisit that debt and must not infer the deferred gates as passed.

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

A small signaling service coordinates room entry (Phase 2A) and relays WebRTC negotiation (Phase 2B). STUN servers can be configured to help establish direct connections; none is configured by default. TURN relays traffic when direct connectivity is impossible; this may include media traffic and therefore has bandwidth and cost implications. From Phase 2D the signaling service gives each admitted member its ICE servers, with short-lived TURN credentials derived from a secret shared with a self-hostable TURN server such as coturn ([ADR-0007](docs/adr/0007-ephemeral-turn-credentials.md)); no secret is built into the web client. Signaling should not normally carry or permanently store media.

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

The project version is `0.0.0-planning`. Phase 0 software feasibility closed after final independent review and the merge of [PR #1](https://github.com/arunachaleswaranms/Driftless/pull/1) into `main`. Isolated Spikes 0.1–0.7 and their evidence remain under `spikes/phase0/`. Physical Android and real external-network qualification remain open as `DEFERRED-PHYSICAL-001` through `007`. No synchronization engine, binary transfer engine, or Progressive Watch implementation has been initialized.

Phase 1 — Application Foundation is **CLOSED / PASS**. Its exit gate passed at revision `4bf6e31`; see the [Phase 1 qualification record](docs/PHASE1_QUALIFICATION.md).

Phase 2 — Internet P2P Foundation is **IMPLEMENTATION COMPLETE / READY TO MERGE**; Phases 2A–2D are implemented and review pass. Physical/network qualification is **DEFERRED / NOT CLOSED**, and the literal physical exit gate is **NOT PASSED**. The physical OnePlus Nord 5 was identified, but cellular / Wi-Fi-off establishment, real recovery, and selected-path evidence were not obtained; no public TURN service was available. Phase 3 — Local Sync Mode is **NEXT / NOT STARTED**, after the Phase 2 implementation merge.

- **Phase 1A — implemented:** the React/TypeScript/Vite web client in [`apps/web/`](apps/web/), with an application shell, a web app manifest and service worker registration without offline caching, and a baseline of type checking, linting, formatting, unit/component tests, and Playwright browser tests.
- **Phase 1B — implemented:** a local browser media player. It plays a video file chosen on the device through an object URL and native controls, shows browser-reported file and media details, reports playback failures conservatively, and releases each file on replace or clear. The file is never uploaded or read by the application.
- **Phase 1C — implemented:** capability detection. The capabilities area reports, on the page only, whether the API surfaces used by the current foundation and planned for later phases are present. These are runtime observations: API presence is not browser or product support, and it establishes no mode, including Progressive Watch. Product compatibility remains governed by the [compatibility policy](docs/COMPATIBILITY.md).
- **Phase 1D — complete:** qualification and closure. It added a synthetic MP4/H.264/AAC local-playback fixture, full-lifecycle and PWA qualification tests, and an opt-in run in the installed Google Chrome. The exit gate passed in Playwright Chromium 153 and Google Chrome 154. These are development browsers, not supported browsers.

- **Phase 2A — implemented:** the protocol and signaling foundation. [`packages/protocol/`](packages/protocol/) defines the versioned envelope (`protocolVersion: 1`), the room lifecycle messages, identifier formats, errors, and strict validation. [`services/signaling/`](services/signaling/) is a Node WebSocket service with in-memory two-person rooms: a non-secret room ID and a separate 256-bit invite secret, enumeration-safe join failures, expiry, a hard two-participant limit, bounded and rate-limited messages, an origin policy, and sanitized logging. Rooms are lost on restart. It never handles media. It passed independent review.
- **Phase 2B — implemented:** room join and WebRTC negotiation. The web client's room area creates a room (showing the room ID and a masked, copyable invite secret) or joins one, over a same-origin `/v1/signaling` WebSocket. The service relays offer, answer, and trickled ICE between the two members only, enforcing host-offers/guest-answers roles, a per-negotiation ID, and bounds. The browsers open one ordered, reliable `RTCDataChannel` and exchange a tiny handshake across it before showing "Peer data channel is connected." No media is captured or sent, and nothing is persisted. It passed independent review.
- **Phase 2C — implemented:** connection lifecycle and reconnect. Each room has a non-secret session ID, and each participant its own resume secret, kept only in page memory. A lost signaling connection is held by the service for a bounded grace period (30 s by default), and the browser resumes the same participant — same room, session, participant ID, and role — on a finite retry schedule by answering a one-time challenge, never by resending the secret, while a working data channel stays open. A failed data channel is replaced by a fresh peer connection and negotiation (the guest asks, the host offers), at most four negotiations per guest. Nothing is replayed or queued, policy-closed connections cannot resume, and a page reload or service restart cannot resume a room. Evidence is automated same-host development browser evidence only. It passed independent review.
- **Phase 2D — implemented:** diagnostics and real-network closure. A collapsed **Connection diagnostics** section shows the current connection's states, whether the selected ICE path is `Direct (not relayed)`, `TURN relay`, or `Unknown` — classified from the browser's own `getStats()` selected candidate pair — the candidate types, the negotiation count, whether TURN was available, and the build revision; no address, candidate, or identifier is shown, copied, or sent anywhere. The service answers an authenticated room member's `RTC_CONFIG_REQUEST` with its STUN and TURN servers and a TURN credential valid for at most an hour and never past the room. A relay-only ICE policy exists for qualification builds only. [DEPLOYMENT.md](docs/DEPLOYMENT.md) describes the HTTPS/WSS deployment and coturn configuration. Software review passed. Deferred qualification on real devices and networks, and the unpassed physical gate, are recorded in [PHASE2_QUALIFICATION.md](docs/PHASE2_QUALIFICATION.md).

Automated Chromium results are development evidence, not browser support claims. Node and loopback signaling tests, and same-host two-context WebRTC tests, are not device, NAT-traversal, TURN, or real-network evidence. Physical-device and real-network qualification remains deferred.

## Development

The repository is an npm workspace (`apps/*`, `packages/*`, `services/*`) with one root `package-lock.json`. With Node.js 22.12 or later:

```sh
npm ci                            # install every workspace from the root lockfile
npm run check                     # protocol, signaling, and web: typecheck, lint, format, unit tests, build, smoke tests
npm run test                      # unit tests of every workspace
npx playwright install chromium   # once per machine
npm run test:e2e                  # web Playwright regression (Chromium)
npm run verify                    # check, then test:e2e
```

`npm run test:e2e` starts its own signaling service on `127.0.0.1:8790` and a preview server that forwards `/v1/signaling` to it. To try a room by hand, run `npm run dev --workspace @driftless/signaling` (port 8787) and `npm run dev --workspace @driftless/web`, then open `http://localhost:5173` in two browser windows or profiles. The development server forwards `/v1/signaling` to the signaling service.

Package details: [web client](apps/web/README.md), [protocol](packages/protocol/README.md), [signaling service](services/signaling/README.md).

## Documentation

- [Project charter](docs/PROJECT_CHARTER.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Protocol (Phase 2A–2D subset implemented; the rest conceptual)](docs/PROTOCOL.md)
- [Deployment boundary](docs/DEPLOYMENT.md)
- [Media pipeline](docs/MEDIA_PIPELINE.md)
- [Roadmap and phase gates](docs/ROADMAP.md)
- [Security baseline](docs/SECURITY.md)
- [Test plan](docs/TEST_PLAN.md)
- [Compatibility policy](docs/COMPATIBILITY.md)
- [Phase 1 qualification record](docs/PHASE1_QUALIFICATION.md)
- [Phase 2 qualification record](docs/PHASE2_QUALIFICATION.md)
- [Protocol package](packages/protocol/README.md) and [signaling service](services/signaling/README.md)
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
