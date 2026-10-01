# Conceptual Protocol

## Status

This is the design specification for `protocolVersion: 1`.

- **Implemented through Phase 2B:** the common JSON envelope; the client ↔ signaling-service room lifecycle messages (Phase 2A); the negotiation ID and the relayed WebRTC negotiation messages `RTC_OFFER`, `RTC_ANSWER`, `ICE_CANDIDATE`, and `ICE_COMPLETE`; and a two-message peer connection handshake on the data channel (Phase 2B). All are strictly validated in [`packages/protocol/`](../packages/protocol/), specified exactly in [Implemented through Phase 2B](#implemented-through-phase-2b-signaling-rooms-and-negotiation) below, and used by [`services/signaling/`](../services/signaling/) and the web client.
- **Still conceptual:** every other message family in this document — reconnect and session resumption, readiness, media identity, host-authoritative playback, synchronization, social, transfer, Progressive Watch, connection diagnostics — and binary framing. Their wire representations are not frozen. Values that depend on benchmarking, including transport chunk size, buffering thresholds, heartbeat intervals, retry counts, and drift thresholds, remain undecided.

Implementing one subset does not freeze the rest of this conceptual protocol.

## Principles

- Reject unknown or invalid input before it reaches stateful subsystems.
- Keep signaling, synchronization, and media transfer messages logically distinct.
- Make host authority, session identity, media identity, and sequencing explicit.
- Bound every message, collection, allocation, queue, and retry mechanism.
- Permit compatible protocol evolution while failing safely on incompatible versions.
- Never infer media completion from connection state alone.

## Common Envelope

Conceptually, every control message contains:

```text
{
  protocolVersion: 1,
  type: <known message type>,
  sequence: <monotonic sender/session sequence>,
  sentAt: <sender timestamp>,
  payload: <type-specific validated content>
}
```

- `protocolVersion` identifies the contract version and is exactly `1` for this baseline.
- `type` selects one known message schema.
- `sequence` supports ordering, duplicate detection, and replay defense within a defined session scope.
- `sentAt` supports diagnostics and synchronization calculations. It is not trusted as authorization or proof of freshness on its own.
- `payload` contains only fields allowed by the selected message type.

Session, participant, correlation, and media identifiers are expected where needed, but their exact placement and representation are not yet frozen. Binary media data may use a compact frame separate from JSON control messages while retaining equivalent version, type, transfer, ordering, and integrity context.

## Implemented through Phase 2B: Signaling, Rooms, and Negotiation

This section is normative for the implemented subset. It covers traffic between a client and the signaling service over the `/v1/signaling` WebSocket, and the connection handshake on the peer data channel. No other peer-to-peer message exists.

### Envelope

```text
{
  "protocolVersion": 1,
  "type": <one of the message types below>,
  "sequence": <non-negative safe integer>,
  "sentAt": <non-negative safe integer, sender clock in ms since the Unix epoch>,
  "payload": <exact object for the type>
}
```

- A message is one UTF-8 JSON text of at most 32,768 encoded bytes (`MAX_SIGNALING_MESSAGE_BYTES`), in either direction. The bound counts UTF-8 bytes, exactly as the WebSocket frame carries them, not JavaScript string length; the shared parser enforces it itself, and the service's WebSocket payload limit is the same value. It was raised from Phase 2A's 4096 bytes so that a session description of up to `MAX_SDP_BYTES`, JSON-escaped, fits. This is a provisional implementation and security bound, not a benchmark-derived limit. Binary messages are never valid.
- The root must be a plain object with exactly the five fields above. Unknown fields fail, at every level. No value is coerced.
- `protocolVersion` must be exactly `1`. Any other non-negative integer is reported as `UNSUPPORTED_PROTOCOL`, checked before the other fields, because a future version may define a different envelope. Anything else is `INVALID_MESSAGE`.
- `type` must be a known type for the direction of travel: a server type sent by a client is unknown.
- `sequence` is scoped to one WebSocket connection and one direction. A client's sequences must strictly increase: a duplicate or lower value is rejected, and gaps are allowed. The server numbers its own messages on each connection from 0, incrementing by 1. Sequence orders messages; it does not authorize anything. Reset and replay semantics across reconnects are not defined; Phase 2C owns them.
- `sentAt` is diagnostic only. It is never used for authorization, freshness, or expiry.

### Identifiers

All four are canonical, unpadded base64url of cryptographically random bytes, with distinct lengths so that one kind cannot be mistaken for another. Where the byte count does not fill the final character, its unused bits must be zero.

| Value           | Bytes         | Characters | Secret | Purpose                                                                                                   |
| --------------- | ------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `roomId`        | 16 (128 bits) | 22         | No     | Opaque room identifier. Knowing it grants nothing.                                                        |
| `inviteSecret`  | 32 (256 bits) | 43         | Yes    | Authorizes joining one room. Never logged, never placed in a URL.                                         |
| `participantId` | 12 (96 bits)  | 16         | No     | Opaque identifier the server assigns to a member. Clients never send it to the service.                   |
| `negotiationId` | 18 (144 bits) | 24         | No     | Opaque identifier of one WebRTC negotiation, created by the host's browser from `crypto.getRandomValues`. |

The negotiation ID is 18 rather than 16 bytes only to keep every identifier a distinct length; 16 bytes would share the room ID's 22-character form.

### Client → server messages

| Type          | Payload                    | Meaning                                             |
| ------------- | -------------------------- | --------------------------------------------------- |
| `ROOM_CREATE` | `{}`                       | Create a private room; the sender becomes its host. |
| `ROOM_JOIN`   | `{ roomId, inviteSecret }` | Join a room as its guest.                           |
| `ROOM_LEAVE`  | `{}`                       | End the sender's membership in its current room.    |

The negotiation messages below are also client → server messages.

### Server → client messages

| Type                      | Payload                                                                                      | Sent to                              |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| `ROOM_CREATED`            | `{ roomId, inviteSecret, participantId, role: "host", expiresAt }`                           | The creator only.                    |
| `ROOM_JOINED`             | `{ roomId, participantId, role: "guest", peer: { participantId, role: "host" }, expiresAt }` | The joining guest.                   |
| `ROOM_LEFT`               | `{}`                                                                                         | The sender of `ROOM_LEAVE`.          |
| `ROOM_PARTICIPANT_JOINED` | `{ participant: { participantId, role: "guest" } }`                                          | The host, when a guest joins.        |
| `ROOM_PARTICIPANT_LEFT`   | `{ participantId, reason: "LEFT" \| "DISCONNECTED" }`                                        | The host, when the guest departs.    |
| `ROOM_CLOSED`             | `{ reason: "EXPIRED" \| "HOST_LEFT" \| "HOST_DISCONNECTED" }`                                | Every remaining member.              |
| `ERROR`                   | `{ code, message, recoverable }`                                                             | The connection whose message failed. |

The negotiation messages below are also server → client messages: the relayed copy a participant receives from its peer.

`expiresAt` is the server clock in milliseconds since the Unix epoch. `ROOM_CLOSED` ends the recipient's membership. The invite secret appears only in `ROOM_CREATED`; no other message carries it.

### Room rules

- A room admits exactly two active participants: one host and one guest.
- One connection belongs to at most one room. `ROOM_CREATE` or `ROOM_JOIN` from a member, and `ROOM_LEAVE` from a non-member, fail with `INVALID_STATE`.
- A join with a missing room, an expired room, or a wrong secret fails with the same `ROOM_UNAVAILABLE`. `ROOM_FULL` is returned only to a caller that presented the correct secret.
- When the guest leaves or disconnects, the room stays open and the invite remains usable until the room ends. When the host leaves or disconnects, the room closes and the invite becomes invalid; the guest is not promoted.
- Rooms expire at a configured lifetime after creation. Rooms are held in memory only.
- A dropped connection loses its membership. No reconnect or resumption exists. In Phase 2B a browser tears down its peer connection when its signaling connection closes; the peer session does not outlive signaling.

### WebRTC negotiation

| Type            | Payload                        | Sender → recipient             |
| --------------- | ------------------------------ | ------------------------------ |
| `RTC_OFFER`     | `{ negotiationId, sdp }`       | Host → guest                   |
| `RTC_ANSWER`    | `{ negotiationId, sdp }`       | Guest → host                   |
| `ICE_CANDIDATE` | `{ negotiationId, candidate }` | Either participant → the other |
| `ICE_COMPLETE`  | `{ negotiationId }`            | Either participant → the other |

`candidate` is exactly `{ candidate, sdpMid, sdpMLineIndex, usernameFragment }`, the browser-defined fields of `RTCIceCandidateInit`. All four keys are present; `sdpMid`, `sdpMLineIndex`, and `usernameFragment` may be `null`, but not both `sdpMid` and `sdpMLineIndex`. A browser builds this plain object field by field; it never forwards an `RTCIceCandidate` object. An empty candidate string, which browsers use to mark the end of a generation, is never sent; the end of gathering is `ICE_COMPLETE`.

The messages are identical in both directions: the service relays the validated payload, re-enveloped with its own sequence. They name no destination room or participant, and no role. The service routes each one from the sender's current membership to its one peer, so a client cannot address another room or participant, and cannot claim a role.

Rules, enforced by the service from membership:

- A connection that is not in a room, or a room without a guest, cannot negotiate.
- Only the host sends `RTC_OFFER`. The offer starts the room's one negotiation for its current guest and names a fresh negotiation ID. A second offer while a negotiation exists is refused; renegotiation is not supported. The room's most recent negotiation ID cannot be reused for a later guest.
- Only the guest sends `RTC_ANSWER`, once, naming the active negotiation.
- Every `RTC_ANSWER`, `ICE_CANDIDATE`, and `ICE_COMPLETE` must name the active negotiation; a stale or unknown ID is refused.
- The host may trickle candidates as soon as it has offered; the guest only after it has answered.
- Each participant sends at most `MAX_ICE_CANDIDATES_PER_NEGOTIATION` candidates and one `ICE_COMPLETE` per negotiation, and no candidate after its `ICE_COMPLETE`.
- When the guest leaves or disconnects, the negotiation is discarded. A later guest starts a new negotiation, with a new ID, and never receives messages of an earlier one. When the room closes, everything is discarded.
- A message whose relayed copy could exceed `MAX_SIGNALING_MESSAGE_BYTES` with the service's envelope is refused as `INVALID_MESSAGE` before any state changes.

A refused negotiation message receives a recoverable `INVALID_STATE` error, or `INVALID_MESSAGE` if it is malformed. Because a refusal can concern a message sent just before the peer left, a client treats a recoverable error received while in a room as a stale refusal, not a failure of its current session.

The service treats `sdp` as opaque text: it checks only that it is a non-empty string within the bound. Only the browsers interpret it.

### Bounds

These are provisional implementation and security bounds chosen for Phase 2B, not limits of WebRTC. Data-channel-only Chromium sessions on the development machine produced descriptions of about 715 bytes and two candidates per peer.

| Bound                                | Value    | Applies to                                                          |
| ------------------------------------ | -------- | ------------------------------------------------------------------- |
| `MAX_SIGNALING_MESSAGE_BYTES`        | 32,768 B | One signaling WebSocket message, UTF-8, either direction            |
| `MAX_SDP_BYTES`                      | 16,384 B | `sdp`, UTF-8; non-empty                                             |
| `MAX_ICE_CANDIDATE_BYTES`            | 1024 B   | `candidate.candidate`; printable ASCII, non-empty                   |
| `MAX_SDP_MID_BYTES`                  | 64 B     | `candidate.sdpMid`; printable ASCII, non-empty, or `null`           |
| `MAX_SDP_MLINE_INDEX`                | 63       | `candidate.sdpMLineIndex`; integer 0–63, or `null`                  |
| `MAX_USERNAME_FRAGMENT_BYTES`        | 256 B    | `candidate.usernameFragment`; printable ASCII, non-empty, or `null` |
| `MAX_ICE_CANDIDATES_PER_NEGOTIATION` | 32       | Candidates one participant sends in one negotiation                 |
| `MAX_PEER_MESSAGE_BYTES`             | 1024 B   | One peer data-channel message, UTF-8                                |

A message must satisfy every bound that applies to it.

### Peer connection handshake

The host creates one data channel, labelled `driftless-control` (`PEER_CONTROL_CHANNEL_LABEL`), ordered and reliable: no `maxRetransmits`, no `maxPacketLifeTime`, no subprotocol, negotiated in band. A guest accepts exactly that channel; any other channel, or a second one, is closed and fails the session. On it, the peers exchange only:

| Type         | Payload                                    |
| ------------ | ------------------------------------------ |
| `PEER_HELLO` | `{ negotiationId, senderId, recipientId }` |
| `PEER_READY` | `{ negotiationId, senderId, recipientId }` |

Messages use the common envelope, with `sequence` strictly increasing per channel and direction. Each peer sends `PEER_HELLO` when the channel opens and answers the other's `PEER_HELLO` with `PEER_READY`. A peer treats the channel as usable only after it has received both the other's `PEER_HELLO` and its `PEER_READY`, which shows that data crossed the channel in both directions; a connected `RTCPeerConnection` alone is not enough.

`senderId` and `recipientId` are participant IDs both peers learned through authenticated signaling, and `negotiationId` names the negotiation. A receiver requires the active negotiation, the expected peer as sender, itself as recipient, and an increasing sequence; a mismatch, a repeat, an unknown type, binary data, or an oversized message fails the session. The invite secret is never sent over the data channel. This handshake is not the Phase 3 control protocol: it carries no media, playback, chat, or arbitrary text.

### Errors

`ERROR.payload.code` is one of:

| Code                   | Meaning                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `INVALID_MESSAGE`      | Not a valid message, a stale or duplicate sequence, or a binary message.                  |
| `UNSUPPORTED_PROTOCOL` | A `protocolVersion` other than 1.                                                         |
| `INVALID_STATE`        | Not allowed in the connection's current room state.                                       |
| `ROOM_UNAVAILABLE`     | The room cannot be joined. Deliberately does not say why.                                 |
| `ROOM_FULL`            | The room already has two participants (only after a correct secret).                      |
| `RATE_LIMITED`         | The connection sent too many messages.                                                    |
| `SERVER_ERROR`         | The server failed internally.                                                             |

`message` is a fixed, non-empty text of at most 200 characters chosen by the code; it never contains input, parser output, stack traces, paths, or secrets. `recoverable` says whether the client may keep using the connection. The service closes the connection after a non-recoverable error; close codes and bounds are described in [`services/signaling/README.md`](../services/signaling/README.md).

### Terminology relative to the conceptual families

`ROOM_JOIN` and `ROOM_LEAVE` keep their conceptual names but are currently client-to-signaling messages; capability negotiation at join is not implemented. `ROOM_CREATE`, the server replies, and `ROOM_LEFT` are new. `ROOM_LEFT` was added so that a leaving client receives explicit confirmation that its membership ended. The negotiation messages and the peer handshake are new in Phase 2B; the handshake is not the readiness family below. The `ERROR` code set is the implemented signaling vocabulary; peer-protocol error codes remain open, and the handshake reports no errors to the peer: a violation ends the session.

## Message Families

The families below are the conceptual baseline. Apart from the implemented signaling, negotiation, and handshake subset above, none is implemented.

### Room and Session

The signaling-level room messages are implemented; see [above](#implemented-through-phase-2b-signaling-rooms-and-negotiation). The capability negotiation described for `ROOM_JOIN` and the readiness messages remain conceptual.

| Type | Purpose |
| --- | --- |
| `ROOM_JOIN` | Request entry to an authorized, unexpired room and negotiate compatible capabilities. |
| `ROOM_LEAVE` | Announce an intentional departure and release participant/session state. |
| `READY` | Declare readiness for a specific media identity and session state. |
| `NOT_READY` | Withdraw readiness with a safe, machine-readable reason. |

The room layer enforces the participant limit. Readiness is scoped to a media selection and becomes invalid when that selection or required capability changes.

### Media

| Type | Purpose |
| --- | --- |
| `MEDIA_INFO` | Describe privacy-safe media metadata, compatibility observations, and an identity/fingerprint reference. |
| `MEDIA_MATCH` | Report sufficient evidence that local media matches for Local Sync. |
| `MEDIA_MISMATCH` | Report that selected media does not match or cannot be verified. |

Local filesystem paths must never be exchanged. The exact fingerprint scheme is unresolved and will account for collision resistance, cost, privacy, and large-file behavior.

### Playback

| Type | Purpose |
| --- | --- |
| `PLAY` | Apply a host-authorized transition to playing at a referenced media position. |
| `PAUSE` | Apply a host-authorized transition to paused at a referenced media position. |
| `SEEK` | Apply a host-authorized discontinuous position change. |
| `SYNC` | Exchange authoritative playback state and observations used to estimate drift. |

Playback commands are associated with an authoritative state revision or equivalent ordering context. Guests must not apply stale commands after newer state. Exact clock estimation and correction thresholds belong to the sync-engine design and measurement work.

### Social

| Type | Purpose |
| --- | --- |
| `CHAT` | Carry a bounded plain-text room message. |
| `REACTION` | Carry a bounded reaction chosen from an allowed representation. |

Social messages have independent rate and size limits. They never grant playback authority or alter transfer state.

### Transfer

| Type | Purpose |
| --- | --- |
| `TRANSFER_REQUEST` | Ask for an eligible media transfer or range according to current playback need. |
| `TRANSFER_METADATA` | Describe the transfer, compatible media structure, segment map, and integrity metadata. |
| `TRANSFER_CHUNK` | Carry one bounded piece of transfer data with reassembly context. |
| `TRANSFER_ACK` | Confirm validated receipt or identify missing transfer units. |
| `TRANSFER_CANCEL` | Stop all or a scoped portion of transfer work. |
| `BUFFER_STATUS` | Report buffered/playable ranges and current demand without granting playback authority. |

A transport chunk is not necessarily a playable media segment. Transfer messages identify both levels where necessary. Exact chunk sizing, acknowledgement cadence, and scheduling algorithms require benchmarking and are not specified here.

### Connection and Errors

| Type | Purpose |
| --- | --- |
| `CONNECTION_STATUS` | Report bounded connection diagnostics, path transitions, or recovery state. |
| `ERROR` | Report a sanitized, machine-readable protocol, capability, or session error. |

Errors must not reveal local paths, secrets, credentials, raw session descriptions, or unnecessary network identifiers.

## Validation Requirements

Before processing a message, implementations must validate:

- Envelope shape, `protocolVersion`, known `type`, and allowed fields.
- Primitive types, finite numeric values, string encodings, and enum membership.
- Required identifiers and their association with the active room, participant, media, and transfer.
- Message, text, metadata, binary chunk, and collection size bounds.
- Participant authorization and whether the sender is permitted to perform the transition.
- State-machine legality, including mode-specific rules.
- Sequence and state revision freshness.
- Timestamp plausibility only where useful; local receipt time remains necessary.
- Transfer offsets, lengths, segment boundaries, and advertised total-size consistency.
- Integrity evidence before media is promoted to playable or persistent state.

Unknown message types, incompatible protocol versions, illegal transitions, oversized payloads, and invalid binary framing must fail closed. Repeated violations should terminate or quarantine the peer session according to the security policy.

## Ordering, Duplicates, and Replay

WebRTC data channels can be configured with different ordering and reliability semantics. The chosen configuration has not been frozen. Protocol behavior must therefore make its assumptions explicit per channel or message family.

- Playback state uses sequence or revision ordering so stale play/pause/seek messages cannot overwrite newer authority.
- Idempotent handling is preferred for retryable messages.
- Duplicate transfer chunks must not create duplicate buffered ranges or allocations.
- Missing transfer data is requested explicitly rather than inferred from wall-clock delay alone.
- Sequences are scoped to a room/session and are reset only through an authenticated, explicit session transition.
- Replayed messages from an expired or previous room session are rejected.
- Reconnect includes state reconciliation before queued actions are accepted.

## Versioning and Compatibility

Peers exchange capabilities before mode activation. A peer that cannot safely interpret the active protocol version or required message family must not join that mode. Future compatible additions may be negotiated, but silent reinterpretation of existing fields is forbidden. Breaking changes require a new protocol version and migration documentation.

## Representation Still to Be Decided

Phase 2A settled, for signaling only: hand-written strict validation in `packages/protocol` rather than a schema library, the room ID, invite secret, and participant ID encodings, and the signaling error codes. Phase 2B settled the negotiation message shapes and the negotiation ID, the provisional negotiation bounds, and the control channel's label and settings and its connection handshake.

The following remain open: reconnect and session resumption, peer data-channel message shapes beyond the handshake, binary frame layout, any further channels and their settings, media and transfer identifier encodings, fingerprint format, chunk size, acknowledgement strategy, peer-protocol error codes, timing intervals, and numeric correction thresholds. Phase 0 evidence informs these decisions; later subsystem design and target-device/network qualification must settle them. Spike 0.7's laboratory wire format and one-part acknowledgement loop are not the production protocol.
