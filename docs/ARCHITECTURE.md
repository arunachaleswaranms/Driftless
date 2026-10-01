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
- `apps/web/` also contains the runtime capability-reporting foundation (Phase 1C): a local report of which browser API surfaces the page observes, for the current foundation and for later-phase prerequisites. It reports observations only. It derives no browser support status and no mode eligibility; mode gating, including the Progressive Watch runtime checks of media, codecs, storage, and protocol, is not implemented.
- Phase 1 — Application Foundation is closed with its exit gate passed; see [PHASE1_QUALIFICATION.md](PHASE1_QUALIFICATION.md). The qualification changed no architecture and no product code.
- `apps/web/src/features/room/` (Phase 2B) contains the room UI and the client side of signaling and WebRTC, layered so that React renders state and nothing else:

  ```text
  RoomPanel (React)  →  RoomController  →  SignalingClient  →  WebSocket (same origin, /v1/signaling)
                                         →  PeerSession      →  RTCPeerConnection + one RTCDataChannel
  ```

  The controller owns one room session. Its state keeps three things independent: room membership (idle, opening, in room, leaving), this participant's signaling connection (connected or reconnecting), and the peer — the other participant's signaling presence and the peer transport (negotiating, connecting, connected, recovering, failed). A room can therefore be in room, with signaling reconnecting and the peer data channel still connected. The signaling client validates every server message with the shared parser; one client is one socket with its own sequence space. The peer session performs the host-offer/guest-answer negotiation with trickle ICE, holds early remote candidates in a bounded queue, validates the single control channel, and runs the connection handshake bound to the room session ID; it is never repaired, only replaced. Each layer takes its browser APIs, including timers and Web Crypto, as injected interfaces, so its races are unit-tested with deterministic fakes. Nothing connects until the user creates or joins a room, and nothing is persisted.

  Phase 2C recovery lives in the controller, below React:

  ```text
  RoomController ── resume schedule (injected one-shot timers) ── SignalingClient (new socket per attempt)
        │                     └─ resume proof (Web Crypto, resumeProof.ts)
        └── PeerSession (replaced by a fresh one on failure)
  ```

  When signaling is lost, a connected peer session is kept and an unfinished negotiation is abandoned; a fresh socket authenticates by challenge and proof on a finite schedule, and the controller reconciles with the service's snapshot before sending anything else. When the peer transport fails, the session is discarded and a fresh negotiation, peer connection, and channel replace it — the guest asks, the host offers — up to four negotiations per guest membership. A page reload loses the in-memory resume secret and cannot resume.

- `packages/protocol/` (Phase 2A, extended in Phase 2B) contains the shared, transport-neutral contract implemented so far: the versioned JSON envelope, the client ↔ signaling room messages, the WebRTC negotiation messages and negotiation ID, the peer connection handshake, identifier formats, bounds counted in UTF-8 bytes, the signaling error vocabulary, and strict parsing. Other message families remain conceptual; see [PROTOCOL.md](PROTOCOL.md).
- `services/signaling/` (Phase 2A, extended in Phase 2B and 2C) contains an ephemeral signaling service: Node's HTTP server, a `ws` WebSocket endpoint at `/v1/signaling`, a health endpoint, and an in-memory store of two-person rooms with room creation, invite-secret join, leave, and expiry. Room state is kept separate from the transport (socket → protocol parser → connection controller → room store). In Phase 2B it relays offer, answer, and ICE messages between the two members of a room; the room store decides legality and the recipient from membership and keeps only counters and flags. In Phase 2C a participant is a stable membership — identity, role, and a derived resume key — and a connection is only its current binding: an ordinary transport loss holds the membership for a bounded grace period, a new connection takes it over only by answering a one-time challenge, policy closures and leaves end it at once, WebSocket pings detect dead connections, and recovery offers replace a failed negotiation within a bounded budget. It has no persistence, parses no SDP, and never handles media; a restart loses every room.
- In production the client expects the signaling path on its own origin, so a deployment routes `/v1/signaling` to the service behind TLS. The development and preview servers forward the path to a loopback service. No deployment exists.
- `packages/protocol/` gained, in Phase 2C, the session ID, resume secret, challenge, and proof formats, the canonical 76-byte resume proof input (no hashing; each endpoint uses platform crypto), the resume, presence, and recovery messages, and a pure base64url codec.
- `packages/sync-engine/` and `packages/transfer-engine/` are empty; synchronization, STUN/TURN infrastructure, connection diagnostics, and media transfer, including the production Progressive Watch components, are not implemented. Reconnect and peer recovery exist only for signaling and the control data channel, with same-host automated evidence only.
- The repository is a root npm workspace (`apps/*`, `packages/*`, `services/*`) with one root lockfile.

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
| Signaling service unavailable | Existing peer sessions may continue where possible; new negotiation and reconnect are unavailable. Do not route media through signaling as a workaround. (Phase 2C: a working data channel survives a signaling outage while the browser resumes on a bounded schedule; a service restart cannot be resumed, and the browser ends the room after its schedule.) |
| Direct connection fails | Attempt configured TURN fallback; report whether relay is used. |
| TURN unavailable or unaffordable | Fail connection or Progressive Watch clearly; do not claim P2P succeeded. |
| Peer disconnects temporarily | Preserve bounded resumable state, renegotiate as needed, and reconcile authority before resuming. (Phase 2C: signaling membership is held for a bounded grace period and resumed by proof; a failed transport is replaced by a fresh negotiation; both reconcile with the service's snapshot.) |
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

Phase 0 supplied controlled desktop evidence for fragmentation, bounded data-channel transfer, MSE, OPFS, and parts of multi-GB resource behavior; see the [Phase 0 results](../spikes/phase0/). Physical Android, real-network/TURN behavior, broad browser compatibility, fingerprinting, reconnect behavior on real networks, and production parameter choices still need evidence. These choices are intentionally not frozen here.
