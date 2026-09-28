# Architecture

## Status and Scope

This document describes the accepted high-level architecture for Driftless. It is a design baseline, not an implementation description. All components are planned unless explicitly recorded as completed in [PROJECT_STATE.md](../PROJECT_STATE.md).

## System Context

```text
                      +-----------------------+
                      |   Signaling service   |
                      | room + negotiation    |
                      +-----------+-----------+
                                  |
                              HTTPS/WSS
                                  |
                   +--------------+--------------+
                   |                             |
          +--------v---------+          +--------v---------+
          | Host web client |          | Guest web client|
          | local media     |          | local/cache media|
          +--------+---------+          +--------+---------+
                   |                             |
                   +------ WebRTC session -------+
                          direct when possible
                          TURN relay if required
```

STUN assists peers in discovering viable network paths. TURN relays WebRTC traffic when a direct path cannot be established. A TURN path may carry both control and media-transfer traffic and must be observable in diagnostics because of its privacy, capacity, and cost implications.

## Planned Repository Responsibilities

| Area | Planned responsibility |
| --- | --- |
| `apps/web/` | React/Vite PWA, room UI, local media selection, HTML5 video integration, capability reporting |
| `services/signaling/` | Ephemeral room coordination and WebRTC offer/answer/ICE exchange |
| `packages/protocol/` | Versioned message definitions, validation, encoding boundaries, error taxonomy |
| `packages/sync-engine/` | Host-authoritative state, heartbeat processing, drift estimation and correction decisions |
| `packages/transfer-engine/` | Transfer planning, backpressure, chunk scheduling, reassembly, resume and integrity behavior |

These responsibilities remain the accepted target architecture. Current implementation, as recorded in [PROJECT_STATE.md](../PROJECT_STATE.md):

- `apps/web/` contains the Phase 1 production web foundation: the application shell, PWA foundation, and test tooling, plus the local media player — local file selection, browser-local object URL lifecycle, HTML5 video integration, reported media metadata, and playback, error, and reset behavior.
- Capability detection and reporting (Phase 1C) is not implemented; the web client shows only a placeholder that makes no browser support claim.
- Room/session UI is not implemented.
- `services/signaling/`, `packages/protocol/`, `packages/sync-engine/`, and `packages/transfer-engine/` are empty; signaling, synchronization, and media transfer, including the production Progressive Watch components, are not implemented.

## Web Client Components

```text
+----------------------------------------------------------+
| Web client                                               |
|                                                          |
|  Room/session UI         Capability detection            |
|          |                       |                       |
|          +------------+----------+                       |
|                       |                                  |
|               Protocol adapter                           |
|                /      |      \                            |
|     Signaling plane  Sync plane  Media transfer plane    |
|                         |               |                |
|                 Sync engine       Transfer engine        |
|                         |               |                |
|                 Local player      Buffer manager         |
|                         |               |                |
|                         +---- HTML5 video                |
|                                         |                |
|                                  Cache/storage           |
+----------------------------------------------------------+
```

- **Local media player:** owns the browser media element integration, local file binding, playback observations, and authorized control application.
- **Synchronization engine:** models authoritative playback state, sequences commands, estimates drift, and recommends correction. It does not move media bytes.
- **Transfer engine:** schedules, sends, receives, acknowledges, verifies, and resumes media data. It does not decide shared playback state.
- **Buffer manager:** tracks playable media ranges and requests work needed for startup, continuous playback, or a seek.
- **Cache/storage:** retains eligible received data under an explicit lifecycle. OPFS is one candidate and not yet selected.
- **Protocol package:** provides shared, versioned message contracts and validation across client and signaling boundaries.

## Logical Planes

### Signaling Plane

The signaling plane establishes a room and exchanges the information required to create a WebRTC connection. It may carry ephemeral presence and negotiation state. It must not become the routine path for playback control or media and must not permanently store media.

Typical responsibilities:

- Room creation, join authorization, expiry, and participant-limit enforcement.
- WebRTC session descriptions and ICE candidates.
- Minimal connection lifecycle coordination.
- Abuse controls and bounded diagnostics.

### Synchronization Plane

The synchronization plane carries small control and state messages such as readiness, play, pause, seek, synchronization heartbeats, chat, and reactions. The host is the initial authoritative playback source. This plane must function for Local Sync without enabling the media transfer plane.

### Media Transfer Plane

The media transfer plane exists only for Progressive Watch. It carries metadata, bounded binary chunks, acknowledgements, buffer state, integrity information, cancellation, and recovery state. It coordinates with the buffer manager but remains separate from playback authority.

Separation is mandatory: congestion, cancellation, or failure in media transfer must not silently redefine host authority; a signaling reconnect must not imply media completion; and Local Sync must not activate file-transfer behavior.

## Host and Guest Roles

The **host** creates or owns the room's authoritative session, selects the shared playback state, and issues sequenced playback changes. In Progressive Watch, the host also supplies the compatible local media.

The **guest** joins using an authorized invite, reports readiness and local observations, applies accepted host commands, and reports buffer state when receiving media.

Roles are protocol responsibilities, not trust guarantees. Both clients validate all peer input. Host migration after disconnection remains an open design question for later phases.

## Media Modes

### Mode A - Local Sync

Both participants bind matching local media. A media fingerprint or other identity evidence is exchanged, but media bytes are not. The synchronization plane operates independently of transfer components.

### Mode B - Progressive Watch

The host inspects a local file for target compatibility, parses and segments suitable MP4 media, fragments segments into transport units, and sends them over a data channel. The guest reassembles and verifies data, caches it according to policy, makes complete media segments available to MSE, and plays through HTML5 video. See [MEDIA_PIPELINE.md](MEDIA_PIPELINE.md).

Progressive Watch is enabled only when runtime checks establish the required browser, codec, storage, and media-structure capabilities.

## Direct P2P and TURN Relay

The preferred path is a direct WebRTC connection because it avoids backend media custody and reduces service bandwidth. Direct connectivity cannot be guaranteed across NATs, firewalls, enterprise networks, or mobile carriers.

TURN is the compatibility fallback. WebRTC remains encrypted in transit, but relay operators handle traffic and metadata at the network layer, and relayed media consumes service bandwidth. Driftless must detect and report the selected candidate path in privacy-conscious diagnostics. No provider or deployment model has been selected.

## Why Peer-to-Peer First

- It aligns media custody with the participants rather than the application backend.
- It permits Local Sync with minimal exchanged data.
- It can reduce centralized bandwidth and storage requirements.
- It provides browser-native encrypted transport and NAT traversal mechanisms.
- It keeps a later backend from becoming a default media repository.

The choice has costs: connectivity variability, TURN exposure, browser constraints, sender uplink requirements, and more complex recovery. Phase gates exist to determine whether those costs are acceptable.

## Major Failure Scenarios

| Scenario | Expected architectural response |
| --- | --- |
| Signaling service unavailable | Existing peer sessions may continue where possible; new negotiation and reconnect are unavailable. Do not route media through signaling as a workaround. |
| Direct connection fails | Attempt configured TURN fallback; report whether relay is used. |
| TURN unavailable or unaffordable | Fail connection or Progressive Watch clearly; do not claim P2P succeeded. |
| Peer disconnects temporarily | Preserve bounded resumable state, renegotiate as needed, and reconcile authority before resuming. |
| Host disconnects permanently | Pause safely and follow a later-defined host-disconnect policy; do not invent authority. |
| Local files do not match | Block synchronized start for Local Sync and present mismatch details that do not disclose paths. |
| Unsupported media or codec | Reject Progressive Watch before transfer where possible and retain Local Sync as an independent option. |
| Data channel congestion | Apply backpressure and prioritize playback-critical data; never enqueue unbounded bytes. |
| Missing, duplicated, or reordered data | Reassemble by validated identifiers, request missing data, and verify integrity before use. |
| Buffer underrun | Pause or surface buffering state, then prioritize the next playable range. |
| Seek outside buffered range | Reprioritize required media segments and cancel or defer obsolete low-priority work. |
| Storage quota pressure | Stop or evict according to an explicit policy; never assume multi-GB capacity. |
| Malicious or malformed peer data | Enforce schemas and resource bounds, reject invalid state transitions, and close unsafe sessions. |
| Browser backgrounding | Detect lifecycle effects, reconcile on return, and avoid promising uninterrupted mobile behavior before tests. |

## Unresolved Design Areas

Phase 0 supplied controlled desktop evidence for fragmentation, bounded data-channel transfer, MSE, OPFS, and parts of multi-GB resource behavior; see the [Phase 0 results](../spikes/phase0/). Physical Android, real-network/TURN behavior, broad browser compatibility, fingerprinting, reconnect semantics, and production parameter choices still need evidence. These choices are intentionally not frozen here.

