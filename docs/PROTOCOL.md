# Conceptual Protocol

## Status

This is the design specification for `protocolVersion: 1`.

- **Implemented through Phase 2D:** the common JSON envelope; the client ↔ signaling-service room lifecycle messages (Phase 2A); the negotiation ID and the relayed WebRTC negotiation messages `RTC_OFFER`, `RTC_ANSWER`, `ICE_CANDIDATE`, and `ICE_COMPLETE`, and a two-message peer connection handshake on the data channel (Phase 2B); and the room session ID, the per-participant resume credential, challenge-response session resume (`SESSION_RESUME_BEGIN`, `SESSION_RESUME_CHALLENGE`, `SESSION_RESUME_PROVE`, `SESSION_RESUMED`), signaling presence (`ROOM_PARTICIPANT_CONNECTION`), the reconnect grace period, and fresh-negotiation peer recovery (`RTC_RECOVERY_REQUEST`, `RTC_RECOVER`) (Phase 2C); and the ICE server configuration request and answer, `RTC_CONFIG_REQUEST` and `RTC_CONFIG`, which carry short-lived TURN credentials to an authenticated room member (Phase 2D). All are strictly validated in [`packages/protocol/`](../packages/protocol/), specified exactly in [Implemented through Phase 2D](#implemented-through-phase-2d-signaling-rooms-negotiation-recovery-and-ice-configuration) below, and used by [`services/signaling/`](../services/signaling/) and the web client.
- **Implemented in Phase 3A:** the peer-only MEDIA_INFO, MEDIA_MATCH, MEDIA_MISMATCH, READY and NOT_READY messages; media selection IDs, session-scoped fingerprint version 1, current-pair readiness and fresh-peer recovery semantics.
- **Still conceptual:** host-authoritative playback, heartbeat/drift synchronization, social, transfer, Progressive Watch, and connection diagnostics (`CONNECTION_STATUS`) — and binary framing. Phase 2D connection diagnostics are browser-local and use no message: no diagnostic, statistic, candidate type, or path classification is ever sent to the service or the peer. Their wire representations are not frozen. Values that depend on benchmarking, including transport chunk size, buffering thresholds, playback heartbeat intervals, and drift thresholds, remain undecided. The Phase 2C reconnect and recovery values below are provisional implementation bounds, not tuned network settings.

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

## Implemented through Phase 2D: Signaling, Rooms, Negotiation, Recovery, and ICE Configuration

This section is normative for the implemented subset. It covers traffic between a client and the signaling service over the `/v1/signaling` WebSocket, including the Phase 2D ICE server configuration, and the connection handshake on the peer data channel. Phase 3A adds the application messages specified below on that peer channel only.

The implemented subset is pre-release: the service and client ship together from this repository. Phase 2D added two message types without changing an existing one. Phase 2C changed some Phase 2A/2B shapes in place under `protocolVersion: 1` (new fields in `ROOM_CREATED`, `ROOM_JOINED`, `PEER_HELLO`, and `PEER_READY`; new reasons and an error code). The compatibility rules under [Versioning and Compatibility](#versioning-and-compatibility) apply from the first deployment.

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
- `sequence` is scoped to one WebSocket connection and one direction. A client's sequences must strictly increase: a duplicate or lower value is rejected, and gaps are allowed. The server numbers its own messages on each connection from 0, incrementing by 1. Sequence orders messages; it does not authorize anything. A new connection, including one that resumes a membership, starts its own sequence space; see [Sequence reset](#sequence-reset).
- `sentAt` is diagnostic only. It is never used for authorization, freshness, or expiry.

### Identifiers

All are canonical, unpadded base64url of cryptographically random bytes, with distinct lengths so that one kind cannot be mistaken for another. Where the byte count does not fill the final character, its unused bits must be zero.

| Value             | Bytes         | Characters | Secret | Purpose                                                                                                                       |
| ----------------- | ------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `roomId`          | 16 (128 bits) | 22         | No     | Opaque room identifier. Knowing it grants nothing.                                                                            |
| `inviteSecret`    | 32 (256 bits) | 43         | Yes    | Authorizes joining one room. Never logged, never placed in a URL.                                                             |
| `participantId`   | 12 (96 bits)  | 16         | No     | Opaque identifier the server assigns to a member. Clients send it only to name the membership they resume, never to claim one. |
| `negotiationId`   | 18 (144 bits) | 24         | No     | Opaque identifier of one WebRTC negotiation, created by the host's browser from `crypto.getRandomValues`.                     |
| `sessionId`       | 20 (160 bits) | 27         | No     | Opaque identifier of one room incarnation, created by the service with the room and shared by both participants.              |
| `resumeSecret`    | 33 (264 bits) | 44         | Yes    | One participant's own resume credential. Never sent after admission, logged, persisted, shown, or placed in a URL.            |
| `challenge`       | 24 (192 bits) | 32         | No     | One-time resume challenge chosen by the service for one connection.                                                           |

The negotiation ID is 18 rather than 16 bytes, and the resume secret 33 rather than 32, only to keep every identifier a distinct length. A resume `proof` is an HMAC-SHA-256 value: 32 bytes, 43 characters, the invite secret's length; it is not an identifier and is accepted only in `SESSION_RESUME_PROVE`.

### Client → server messages

| Type          | Payload                    | Meaning                                             |
| ------------- | -------------------------- | --------------------------------------------------- |
| `ROOM_CREATE` | `{}`                       | Create a private room; the sender becomes its host. |
| `ROOM_JOIN`   | `{ roomId, inviteSecret }` | Join a room as its guest.                           |
| `ROOM_LEAVE`  | `{}`                       | End the sender's membership in its current room.    |
| `SESSION_RESUME_BEGIN` | `{ sessionId, participantId }` | Ask to resume a membership on this connection. Carries no secret. |
| `SESSION_RESUME_PROVE` | `{ challenge, proof }`         | Answer this connection's pending challenge.                      |
| `RTC_CONFIG_REQUEST`   | `{}`                           | Ask for this membership's ICE server configuration (Phase 2D).   |

The negotiation and recovery messages below are also client → server messages.

### Server → client messages

| Type                      | Payload                                                                                      | Sent to                              |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| `ROOM_CREATED`                | `{ roomId, sessionId, inviteSecret, resumeSecret, participantId, role: "host", expiresAt }`                           | The creator only.                                 |
| `ROOM_JOINED`                 | `{ roomId, sessionId, resumeSecret, participantId, role: "guest", peer: { participantId, role: "host" }, expiresAt }` | The joining guest.                                |
| `ROOM_LEFT`                   | `{}`                                                                                                                  | The sender of `ROOM_LEAVE`.                       |
| `ROOM_PARTICIPANT_JOINED`     | `{ participant: { participantId, role: "guest" } }`                                                                   | The host, when a guest joins.                     |
| `ROOM_PARTICIPANT_LEFT`       | `{ participantId, reason: "LEFT" \| "DISCONNECTED" \| "RECONNECT_TIMEOUT" }`                                          | The host, when the guest's membership ends.       |
| `ROOM_CLOSED`                 | `{ reason: "EXPIRED" \| "HOST_LEFT" \| "HOST_DISCONNECTED" \| "HOST_RECONNECT_TIMEOUT" }`                              | Every remaining connected member.                 |
| `ROOM_PARTICIPANT_CONNECTION` | `{ participantId, signaling: "CONNECTED" \| "RECONNECTING", activeNegotiationId, negotiationCount }`                   | The other member, when a member's signaling is lost or resumed. |
| `SESSION_RESUME_CHALLENGE`    | `{ challenge }`                                                                                                       | A connection that sent `SESSION_RESUME_BEGIN`.    |
| `SESSION_RESUMED`             | the resume snapshot, below                                                                                            | A connection whose resume proof was accepted.     |
| `RTC_CONFIG`                  | `{ expiresAt, iceServers }`, below                                                                                     | The member that sent `RTC_CONFIG_REQUEST`, only.  |
| `ERROR`                       | `{ code, message, recoverable }`                                                                                      | The connection whose message failed.              |

The negotiation and recovery messages below are also server → client messages: the relayed copy a participant receives from its peer.

`expiresAt` is the server clock in milliseconds since the Unix epoch. `ROOM_CLOSED` ends the recipient's membership. The invite secret appears only in `ROOM_CREATED`, and each resume secret only in the one `ROOM_CREATED` or `ROOM_JOINED` sent to its owner; no other message carries either.

### Room rules

- A room admits exactly two active participants: one host and one guest.
- One connection belongs to at most one room. `ROOM_CREATE` or `ROOM_JOIN` from a member, and `ROOM_LEAVE` from a non-member, fail with `INVALID_STATE`.
- A join with a missing room, an expired room, or a wrong secret fails with the same `ROOM_UNAVAILABLE`. `ROOM_FULL` is returned only to a caller that presented the correct secret.
- When the guest's membership ends, the room stays open and the invite remains usable until the room ends. When the host's membership ends, the room closes and the invite becomes invalid; the guest is not promoted.
- Rooms expire at a configured lifetime after creation. Rooms are held in memory only; a service restart loses every room, and no membership can be resumed after one.
- A participant is a stable membership, independent of any connection: identity, role, and resume key belong to the membership, and a connection is only its current binding. How a connection's ending affects its membership is specified under [Connection endings](#connection-endings).

### WebRTC negotiation

| Type            | Payload                        | Sender → recipient             |
| --------------- | ------------------------------ | ------------------------------ |
| `RTC_OFFER`            | `{ negotiationId, sdp }`                        | Host → guest                   |
| `RTC_ANSWER`           | `{ negotiationId, sdp }`                        | Guest → host                   |
| `ICE_CANDIDATE`        | `{ negotiationId, candidate }`                  | Either participant → the other |
| `ICE_COMPLETE`         | `{ negotiationId }`                             | Either participant → the other |
| `RTC_RECOVERY_REQUEST` | `{ negotiationId }`                             | Guest → host                   |
| `RTC_RECOVER`          | `{ previousNegotiationId, negotiationId, sdp }` | Host → guest                   |

`RTC_RECOVERY_REQUEST` and `RTC_RECOVER` are specified under [Peer recovery](#peer-recovery); `previousNegotiationId` and `negotiationId` must differ.

`candidate` is exactly `{ candidate, sdpMid, sdpMLineIndex, usernameFragment }`, the browser-defined fields of `RTCIceCandidateInit`. All four keys are present; `sdpMid`, `sdpMLineIndex`, and `usernameFragment` may be `null`, but not both `sdpMid` and `sdpMLineIndex`. A browser builds this plain object field by field; it never forwards an `RTCIceCandidate` object. An empty candidate string, which browsers use to mark the end of a generation, is never sent; the end of gathering is `ICE_COMPLETE`.

The messages are identical in both directions: the service relays the validated payload, re-enveloped with its own sequence. They name no destination room or participant, and no role. The service routes each one from the sender's current membership to its one peer, so a client cannot address another room or participant, and cannot claim a role.

Rules, enforced by the service from membership:

- A connection that is not in a room, or a room without a guest, cannot negotiate.
- The recipient must be connected: every negotiation and recovery message towards a participant that is reconnecting is refused, and nothing is queued for it.
- Only the host sends `RTC_OFFER`. The offer starts the first negotiation of the current guest membership and names a fresh negotiation ID. A second `RTC_OFFER` while a negotiation exists is refused; a later negotiation of the same membership is only an `RTC_RECOVER`. No negotiation ID used by the membership, and not the room's most recent ID, is accepted again.
- Only the guest sends `RTC_ANSWER`, once, naming the active negotiation.
- Every `RTC_ANSWER`, `ICE_CANDIDATE`, and `ICE_COMPLETE` must name the active negotiation; a stale or unknown ID is refused.
- The host may trickle candidates as soon as it has offered; the guest only after it has answered.
- Each participant sends at most `MAX_ICE_CANDIDATES_PER_NEGOTIATION` candidates and one `ICE_COMPLETE` per negotiation, and no candidate after its `ICE_COMPLETE`.
- When the guest's membership ends, its negotiation state is discarded. A later guest starts a new negotiation, with a new ID and a fresh budget, and never receives messages of an earlier one. When the room closes, everything is discarded. A reconnecting participant's negotiation state is kept, so it can be reconciled.
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
| `MAX_NEGOTIATIONS_PER_MEMBERSHIP`    | 4        | Negotiations one guest membership uses: the first and 3 recoveries  |
| `MAX_PEER_MESSAGE_BYTES`             | 1024 B   | One peer data-channel message, UTF-8                                |

A message must satisfy every bound that applies to it.

### Peer connection handshake

The host creates one data channel, labelled `driftless-control` (`PEER_CONTROL_CHANNEL_LABEL`), ordered and reliable: no `maxRetransmits`, no `maxPacketLifeTime`, no subprotocol, negotiated in band. A guest accepts exactly that channel; any other channel, or a second one, is closed and fails the session. Its connection handshake exchanges:

| Type         | Payload                                    |
| ------------ | ------------------------------------------ |
| `PEER_HELLO` | `{ sessionId, negotiationId, senderId, recipientId }` |
| `PEER_READY` | `{ sessionId, negotiationId, senderId, recipientId }` |

Messages use the common envelope, with `sequence` strictly increasing per channel and direction. The host sends `PEER_HELLO` when its channel opens. The guest sends nothing until it receives that `PEER_HELLO`, then sends its own `PEER_HELLO` followed by `PEER_READY`; the host answers the guest's `PEER_HELLO` with `PEER_READY`. A peer treats the channel as usable only after it has received both the other's `PEER_HELLO` and its `PEER_READY`, which shows that data crossed the channel in both directions; a connected `RTCPeerConnection` alone is not enough. (Phase 2B let the guest greet as soon as its announced channel was open. Phase 2C same-host Chromium testing observed that greeting, sent before the host's channel had opened, never being delivered, leaving both sides waiting; replying to the host guarantees the host's channel is open first.)

`sessionId`, `senderId`, and `recipientId` are values both peers learned through authenticated signaling, and `negotiationId` names the negotiation. A receiver requires its own room session, the active negotiation, the expected peer as sender, itself as recipient, and an increasing sequence; a mismatch — including a message from another room session, an earlier room incarnation, another participant, or another negotiation — a repeat, an unknown type, binary data, or an oversized message fails the session. No credential, invite or resume, is ever sent over the data channel. Each recovery negotiation runs the handshake again on its fresh channel. This handshake is not the Phase 3 control protocol: it carries no media, playback, chat, or arbitrary text.

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
| `SERVER_ERROR`         | The server failed internally, or cannot hold another room.                                |
| `SESSION_UNAVAILABLE`  | The membership cannot be resumed. Deliberately does not say why.                          |

`message` is a fixed, non-empty text of at most 200 characters chosen by the code; it never contains input, parser output, stack traces, paths, or secrets. `recoverable` says whether the client may keep using the connection. The service closes the connection after a non-recoverable error; close codes and bounds are described in [`services/signaling/README.md`](../services/signaling/README.md).

### Session resume

Each participant receives, once, at admission, its own `resumeSecret`. The service keeps only `resumeKey = SHA-256(resumeSecret bytes)`. A client never sends the secret again; it proves knowledge of it:

```text
new WebSocket, in no room
  → SESSION_RESUME_BEGIN { sessionId, participantId }       client sequence 0
  ← SESSION_RESUME_CHALLENGE { challenge }                  always, for any session
  → SESSION_RESUME_PROVE { challenge, proof }               client sequence 1
  ← SESSION_RESUMED { snapshot }  or  ERROR SESSION_UNAVAILABLE
```

- **Proof.** `proof = HMAC-SHA-256(resumeKey, input)`, unpadded base64url. `input` is exactly 76 bytes: ASCII `driftless-resume-v1` (19 bytes), one `0x00` byte, the 20 decoded session ID bytes, the 12 decoded participant ID bytes, and the 24 decoded challenge bytes. Every field after the domain separator has a fixed length, and the values are decoded bytes rather than strings, so the encoding is unique and free of locale or separator ambiguity. `resumeProofInput` in `@driftless/protocol` builds it; browsers compute the HMAC with Web Crypto and the service with Node's crypto. A fixed test vector checks both.
- **Challenge.** 24 random bytes from the service's secure generator, bound to the connection that asked, answerable once, and valid for 10 seconds (`RESUME_CHALLENGE_TTL_MS`, provisional). It is consumed by the first `SESSION_RESUME_PROVE`, whatever the outcome; it is also dropped when it expires, when its connection closes, and on shutdown. A connection holds at most one, and may send nothing but `SESSION_RESUME_PROVE` while it does. `SESSION_RESUME_BEGIN` from a member, a second one while a challenge is pending, and a `SESSION_RESUME_PROVE` without one are refused with `INVALID_STATE`.
- **Verification.** The service compares the proof in constant time against one computed from the named participant's key, or from a decoy key when the session or participant does not exist, so every path does the same work. It accepts only if the proof matches the pending challenge, the challenge has not expired, the participant exists and is reconnecting (has no live connection), its grace period has not ended, and the room has not expired.
- **Enumeration-safe failure.** Every refusal — unknown session, unknown participant, wrong or replayed proof, expired challenge, a participant that still has a live connection, an ended grace period, an expired room, or an ended membership — is the same recoverable `ERROR SESSION_UNAVAILABLE` with the same fixed text, and carries no room metadata. The challenge is identical in shape whether or not the session exists.
- **One binding.** A participant has at most one connection. A resume never takes over a participant whose connection is still live, even with a valid proof; that connection stays authoritative.
- **Snapshot.** `SESSION_RESUMED` carries `{ sessionId, roomId, participantId, role, expiresAt, peer, activeNegotiationId, negotiationCount }`. `peer` is `{ participantId, role, signaling: "CONNECTED" | "RECONNECTING" }`, or `null` for a host without a guest. `activeNegotiationId` is the latest negotiation the service accepted for the current guest membership, whether or not its peer connection still works, and is `null` exactly when `negotiationCount` is 0. It never carries a credential, session description, candidate, or address. The parser enforces the role, peer, and negotiation consistency rules.
- **Terminal leave.** A client whose user leaves while its signaling is reconnecting uses the same flow only to end the membership: after `SESSION_RESUMED` it sends `ROOM_LEAVE` at once, reconciles nothing, and treats `ROOM_LEFT`, `ROOM_CLOSED`, a refusal, or `SESSION_UNAVAILABLE` as the end of the membership. The service needs nothing new: a resumed connection is an ordinary member, and `ROOM_LEAVE` on it is an intentional leave (`ROOM_PARTICIPANT_LEFT` `LEFT`, or `ROOM_CLOSED` `HOST_LEFT` with the invite invalidated). A client that cannot reach the service in its bounded leave schedule leaves locally, and the service ends the membership at the end of the grace period or room lifetime.
- **Reconciliation.** A resumed client reconciles with the snapshot before sending anything else, and nothing it queued is replayed (it queues nothing). It keeps an existing peer session only if that session is connected and belongs to `activeNegotiationId`; it closes any other, and then follows [Peer recovery](#peer-recovery). Every later action must be accepted against reconciled state: this is the rule future message families (such as Phase 3 playback) inherit, not a replay queue.

#### Sequence reset

A new connection starts its own sequence space in both directions, from its first message: in a resume, `SESSION_RESUME_BEGIN` is client sequence 0, `SESSION_RESUME_PROVE` 1, and resumed traffic continues from 2; the service's `SESSION_RESUME_CHALLENGE` is 0 and `SESSION_RESUMED` 1. The reset grants nothing: only an accepted proof binds the connection to the membership. Sequence numbers of the old connection mean nothing on the new one, and nothing sent on or queued for the old connection is replayed.

### Connection endings

| Ending | Effect on the membership |
| --- | --- |
| `ROOM_LEAVE` | Ends at once; `ROOM_PARTICIPANT_LEFT` `LEFT`, or `ROOM_CLOSED` `HOST_LEFT`. The resume key is discarded. |
| The client closes with 1000 (normal), 1001 (going away: the page closed or navigated), or 1002 (it rejected a message from the service and gave up) | Ends at once, as `DISCONNECTED` / `HOST_DISCONNECTED`. A page that goes away has lost its in-memory resume secret anyway. A browser abandoning a resume attempt closes with 4000, which is resumable. |
| The service closes the connection for a policy or protocol violation (rate limit, repeated invalid messages, unsupported version, binary data, internal error), or `ws` closes it for an invalid or oversized frame | Ends at once, as `DISCONNECTED` / `HOST_DISCONNECTED`. Never resumable, so the same participant cannot return to bypass the enforcement. |
| Any other close, above all a lost TCP connection (1006), or a missed protocol ping | **Reconnecting**: held for the reconnect grace period. |

While a participant is reconnecting it keeps its participant ID, role, slot, and negotiation state; a guest's slot is not freed, so a third party's join with the invite gets `ROOM_FULL`. The other member, if connected, receives `ROOM_PARTICIPANT_CONNECTION` with `signaling: "RECONNECTING"`, and `"CONNECTED"` when the participant resumes; both carry the service's `activeNegotiationId` and `negotiationCount` so the recipient can reconcile too. A guest that joins while the host is reconnecting receives `ROOM_JOINED` and then `ROOM_PARTICIPANT_CONNECTION` `RECONNECTING` for the host.

The reconnect grace period is 30 seconds by default (`SIGNALING_RECONNECT_GRACE_SECONDS`, 5–120), a provisional implementation bound rather than a user-experience promise. When it ends — exactly at the deadline — a guest is removed (`ROOM_PARTICIPANT_LEFT` `RECONNECT_TIMEOUT` to the host; the slot is free) and a host's room closes (`ROOM_CLOSED` `HOST_RECONNECT_TIMEOUT` to the guest, if connected; the invite is invalid). No one is promoted. Both participants may be reconnecting at once, each with its own deadline; the host's expiry closes the room whatever the guest's state. Room expiry overrides every grace period. One periodic sweep (every second) applies all these deadlines, and resume refuses them exactly at the deadline even before the sweep runs.

The service sends a WebSocket protocol ping to every connection every 15 seconds by default (`SIGNALING_HEARTBEAT_SECONDS`, 5–60, provisional, not tuned for mobile networks); browsers answer pings themselves. A connection that has not answered the previous ping when the next is due is terminated and treated as lost. No JSON message is involved, and this is unrelated to any future playback heartbeat.

**Known limitation (open).** A connection whose network path dies silently — no FIN or RST reaches the service — is still considered live by the service until it misses a ping, 15–30 seconds with the default interval, and a resume is refused while it is. The browser's retry schedule (about 16 seconds of delays) can therefore end before the service notices, for example after a network switch; the room then ends in the browser while the other participant sees "reconnecting" until the service's own detection and grace run out. Conversely, the browser has no application-level liveness check of its own. Choosing the ping interval and retry window for real and mobile networks needs real-network evidence; Phase 2C automation relies on observed transport closes. Phase 2D qualification could not evaluate it on a real network and changed no value; it observed only that the protocol pings traverse a Cloudflare tunnel and that a non-answering client was terminated within two intervals ([PHASE2_QUALIFICATION.md](PHASE2_QUALIFICATION.md#known-limitation-heartbeat-detection-versus-the-resume-schedule)).

### ICE server configuration

Phase 2D. A browser needs STUN and TURN servers, and TURN needs a credential, which must never be built into the public browser bundle. The service therefore hands each authenticated room member its own short-lived configuration on request.

```text
connection carrying a membership (after ROOM_CREATED, ROOM_JOINED, or SESSION_RESUMED)
  → RTC_CONFIG_REQUEST {}
  ← RTC_CONFIG { expiresAt, iceServers: [ { urls, username, credential }, … ] }
```

- **Authorization.** Accepted only from a connection that currently carries a room membership. A connection in no room, one with a pending resume challenge, and one whose resume proof was refused receive a recoverable `INVALID_STATE` and no configuration. The answer goes to the requesting connection only, never to the other participant.
- **Bound.** At most `MAX_RTC_CONFIG_REQUESTS_PER_CONNECTION` (8, provisional) requests per connection; later ones receive `INVALID_STATE`. A browser asks once after admission and again only before a new peer connection when its configuration is within 60 seconds of expiry.
- **`iceServers`.** At most `MAX_RTC_ICE_SERVERS` (4) entries, each exactly `{ urls, username, credential }`:
  - `urls`: 1 to `MAX_RTC_ICE_SERVER_URLS` (4) distinct URLs of at most `MAX_ICE_SERVER_URL_BYTES` (300) bytes, all of one kind: `stun:`/`stuns:` (RFC 7064) or `turn:`/`turns:` (RFC 7065) with a DNS name, IPv4, or bracketed IPv6 host, an optional port 1–65535, and, for TURN only, an optional `?transport=udp` or `?transport=tcp`. No other scheme, user information, path, or parameter is accepted.
  - A STUN entry has `username` and `credential` `null`. A TURN entry has both, each printable ASCII without spaces, at most `MAX_ICE_SERVER_USERNAME_BYTES` (128) and `MAX_ICE_SERVER_CREDENTIAL_BYTES` (128) bytes.
  - Any invalid entry or extra field rejects the whole message; nothing is skipped. An empty list is valid: the service has no ICE server configured.
- **Expiry.** `expiresAt` is the service clock in milliseconds since the Unix epoch. The configuration's lifetime is `expiresAt − sentAt` of the same message, both on the service clock, so client clock skew does not change it; a client refuses a lifetime that is not positive or exceeds `MAX_RTC_CONFIG_TTL_MS` (one day). The service never issues one beyond the room's expiry. A client uses it only for peer connections it creates before the lifetime ends, in memory, and never persists, displays, logs, or exports it.
- **TURN credentials.** Derived by the service with the TURN REST shared-secret scheme ([ADR-0007](adr/0007-ephemeral-turn-credentials.md)): `username = "<expiry, Unix seconds>:<pseudonymous participant label>"` and `credential = base64(HMAC-SHA1(secret, username))`. The protocol carries only the derived values; the shared secret never appears in any message. The username's expiry equals `expiresAt` in whole seconds.
- **Failure.** If no usable configuration arrives within a bounded wait (3 s, provisional, client policy), a client may connect with its build-time STUN servers only; it never falls back to a stored or built-in TURN credential.

### Peer recovery

A failed peer session is never repaired: no ICE restart (`restartIce()` is not used) and no renegotiation within it. It is replaced by a fresh `RTCPeerConnection`, a fresh negotiation ID, a fresh `driftless-control` channel, and a fresh handshake. The host remains the only offerer.

- `RTC_RECOVERY_REQUEST { negotiationId }`, guest → host: the guest's peer session for the active negotiation failed. The service relays it only if it names the active negotiation, the host is connected, the guest has not already asked for that negotiation, and the membership's negotiation budget is not spent; duplicates are refused.
- `RTC_RECOVER { previousNegotiationId, negotiationId, sdp }`, host → guest: replaces the active negotiation with a fresh one and carries its offer. The service accepts it only from the host, only if `previousNegotiationId` is the active negotiation, `negotiationId` has never been used by this guest membership (nor is the room's most recent ID; a later guest membership starts a fresh set), the guest is connected, and fewer than `MAX_NEGOTIATIONS_PER_MEMBERSHIP` negotiations have been used. It then atomically makes the new negotiation active, with fresh candidate counters and completion flags; the previous negotiation is over, and every later `RTC_ANSWER`, `ICE_CANDIDATE`, or `ICE_COMPLETE` naming it is refused.
- A guest accepts an `RTC_RECOVER` only if `previousNegotiationId` is the negotiation it knows to be active; it closes its old session, answers with the new ID, and accepts the new channel. It never offers.
- A host recovers when the guest asks, and when its own session fails, after a provisional one-second wait (`HOST_RECOVERY_DELAY_MS`) that a guest's request or departure cuts short: a guest's intentional leave closes the data channel, and its teardown can reach the host before the service's notice. A participant also starts or requests a fresh negotiation after reconciliation when the snapshot's active negotiation does not match a connected local session.
- Recovery waits while either participant's signaling is reconnecting; nothing is queued. A transport that fails during a signaling outage is recorded locally and recovered after `SESSION_RESUMED` or `ROOM_PARTICIPANT_CONNECTION` `CONNECTED`. A negotiation interrupted by a signaling outage is abandoned, never resumed by replaying its remaining messages.
- A guest membership uses at most `MAX_NEGOTIATIONS_PER_MEMBERSHIP` (4) negotiations: the first and up to three recoveries. When the budget is spent, recovery stops in a failed state and the user may leave; there is no loop.

The browser's signaling reconnect schedule, its terminal-leave schedule, its per-attempt timeout, and the host's recovery wait are client policy, documented in [`apps/web/README.md`](../apps/web/README.md).

### Terminology relative to the conceptual families

`ROOM_JOIN` and `ROOM_LEAVE` keep their conceptual names but are currently client-to-signaling messages; capability negotiation at join is not implemented. `ROOM_CREATE`, the server replies, and `ROOM_LEFT` are new. `ROOM_LEFT` was added so that a leaving client receives explicit confirmation that its membership ended. The negotiation messages and the peer handshake are new in Phase 2B; the handshake is not the readiness family below. The session resume, presence, and recovery messages are new in Phase 2C; `ROOM_PARTICIPANT_CONNECTION` is signaling presence only, not the conceptual `CONNECTION_STATUS` diagnostics. The `ERROR` code set is the implemented signaling vocabulary; peer-protocol error codes remain open, and the handshake reports no errors to the peer: a violation ends the session.

## Implemented through Phase 3A: Local Sync setup

Phase 3A adds exactly `MEDIA_INFO`, `MEDIA_MATCH`, `MEDIA_MISMATCH`, `READY`, and `NOT_READY`, both directions on `driftless-control` only. They are never signaling messages, room-store fields, or media-transfer messages. `protocolVersion` remains 1; the pre-release endpoints ship together.

### Receiver-local application traffic bound

PeerSession enforces one finite inbound token bucket shared by all five application types, after parsing, current session/negotiation/participant validation, increasing sequence validation, and handshake completion, before application dispatch. Initial allowance and maximum capacity are **32 messages**; lazy refill is **8 messages/second**, based exclusively on the injected local receiver clock in milliseconds. Fractional tokens are retained, capacity is clamped, identical timestamps grant no refill, and backwards readings cannot lower the refill timestamp or double-count elapsed time when the clock catches up. Peer `sentAt` is diagnostic only and grants no allowance.

`PEER_HELLO` and `PEER_READY` retain their strict handshake state machine and consume no application tokens. Malformed, unknown, binary, wrong-context, duplicate/lower-sequence, and premature application messages fail as `peer_protocol`, without consuming application tokens. A valid application message without one full token is not dispatched: the current PeerSession fails once with the fixed local reason `application_rate_limit`, closes its channel and connection, and detaches handlers. Existing fresh-peer recovery decides the next action; each fresh PeerSession starts with the full burst. Outbound sends are unchanged. This provisional abuse bound is transport enforcement, not a throughput guarantee or wire field: no counter, acknowledgement, rate-limit message, new timestamp, or version change is introduced.

### Media identifiers and bounds

- `MediaSelectionId`: 16 browser Web Crypto random bytes (128 bits), canonical unpadded base64url, exactly 22 characters including zero unused tail bits. Non-secret; generated for each new selection, never intentionally reused. It has its own branded type even though its encoding shares the room-ID width.
- `MediaFingerprint`: 32 SHA-256 result bytes, canonical unpadded base64url, exactly 43 characters including zero unused tail bits. `MEDIA_FINGERPRINT_VERSION = 1` is the only supported version; peers cannot choose an algorithm.
- `byteLength`: positive safe integer, at most `MAX_MEDIA_FINGERPRINT_BYTES = 17,179,869,184` (16 GiB). `MEDIA_FINGERPRINT_CHUNK_BYTES = 4,194,304` (4 MiB); `MAX_MEDIA_FINGERPRINT_CHUNKS = 4096`. These are provisional implementation bounds, not a final product maximum. Empty files are refused locally with `READ_FAILED` and never announced.
- Every peer envelope still fits `MAX_PEER_MESSAGE_BYTES = 1024` UTF-8 bytes. Exact fields, enum values, canonical IDs, and prototype-key rejection apply at every level; largest legal envelopes are tested with maximum safe-integer sequence/timestamp values.

### Canonical version-1 fingerprint

Read every file byte sequentially, one `File.slice(offset, end).arrayBuffer()` at a time, each source chunk at most 4 MiB. Finish its SHA-256 before starting another read. Only its 32-byte digest is retained.

```text
chunkDigest[i] = SHA-256(chunk bytes)
contentRootInput = ASCII("driftless-media-content-v1") || 0x00
                 || uint64be(fileByteLength)
                 || uint32be(4194304)
                 || uint32be(chunkCount)
                 || chunkDigest[0] || ... || chunkDigest[chunkCount - 1]
contentRoot = SHA-256(contentRootInput)
wireFingerprintInput = ASCII("driftless-local-sync-media-v1") || 0x00
                     || decoded SessionId bytes (20 bytes)
                     || contentRoot (32 bytes)
wireFingerprint = base64url(SHA-256(wireFingerprintInput))
```

Integers are unsigned, fixed-width, big-endian; chunks are ordered by offset and the last may be shorter. The cryptographic input uses no JSON or padding. The content-root header is 43 bytes; bounded digest storage is at most 128 KiB, plus one actively read/digested source chunk. Web Crypto performs SHA-256 in the browser adapter; the platform-neutral engine accepts an injected digest function. Independent fixed Node-crypto vectors cover chunk boundaries and changes in first, middle, and last chunks.

The private root and chunk digests never leave the function or cross the wire. Equal bytes in the same SessionId produce equal wire fingerprints; unrelated room sessions produce different fingerprints. This is cooperative identity evidence, not DRM or remote attestation: an authorized malicious peer can lie about possession/playback. A peer knowing guessed candidate bytes and the room session can test guesses; session scoping prevents a stable cross-room identifier, not all inference.

### Payloads

Every payload includes exactly the existing context fields `{ sessionId, negotiationId, senderId, recipientId }` plus the fields in this table:

| Message | Additional fields |
| --- | --- |
| `MEDIA_INFO` | `{ selectionId, fingerprintVersion: 1, fingerprint, byteLength }` |
| `MEDIA_MATCH` | `{ localSelectionId, remoteSelectionId, fingerprint }` |
| `MEDIA_MISMATCH` | `{ localSelectionId, remoteSelectionId, reason: "IDENTITY_MISMATCH" }` |
| `READY` | `{ localSelectionId, remoteSelectionId, fingerprint }` |
| `NOT_READY` | `{ localSelectionId: MediaSelectionId \| null, reason }` |

The sender's `localSelectionId` names its selection; its `remoteSelectionId` names the receiver's selection. A match/Ready fingerprint must equal the current matched identity. `NOT_READY.reason` is exactly `USER`, `NO_MEDIA`, `MEDIA_CHANGED`, `PEER_MEDIA_CHANGED`, `MEDIA_MISMATCH`, or `LOCAL_MEDIA_ERROR`. No wire field carries filename, path, MIME, duration, dimensions, object URL, modification time, content root, chunk digests, filesystem handles, or media bytes.

### Ordering, readiness, and stale selection policy

`PeerSession` injects authenticated context through `sendApplicationMessage(body)` and validates it before `onApplicationMessage(body)`. Sends are allowed only while connected. Applications received before the bidirectional HELLO/READY handshake completes fail the peer session with `peer_protocol`; they are never passed to React. Handshake and setup share one strictly increasing sequence per channel/direction. Wrong session, negotiation, sender, recipient, duplicate/lower sequence, binary, unknown, oversized, or malformed traffic fails closed. Teardown detaches callbacks and old peer callbacks are powerless.

A file matches only when byte lengths and current session-scoped fingerprints agree. Each participant emits MEDIA_MATCH/MISMATCH for that pair. Ready requires current local identity, successful local-player metadata, no local error, current remote identity, matching evidence and peer confirmation of that pair; it always requires explicit user intent. `Both participants are ready` requires local Ready and remote Ready for that same current pair. No playback action follows.

Replacement sends NOT_READY before new MEDIA_INFO, cancels obsolete hashing, selects a fresh ID, loads metadata normally and announces only a current completed identity. Clear sends NOT_READY and no empty MEDIA_INFO. Local read/hash/playback failure blocks readiness. Remote selection change clears pair confirmation and both readiness flags; another explicit click is required after matching again. USER withdrawal leaves matching evidence and the other user's choice intact. NO_MEDIA, MEDIA_CHANGED, and LOCAL_MEDIA_ERROR remove the sender's previously known usable identity.

Structurally valid MATCH/READY/MISMATCH/NOT_READY referring to a superseded selection pair are **ignored**, not transport violations; they cannot mutate current state. Same-selection MEDIA_INFO repeats are ignored (including conflicting repeats); a changed identity must use a fresh selection ID. The engine stores only current selections, never unbounded historical IDs or fingerprints.

### Fresh peers and signaling recovery

A fresh recovered PeerSession has a fresh negotiation, channel, handshake, and sequence starting at zero. All old remote setup evidence and both Ready choices are cleared. After handshake, regenerate MEDIA_INFO from current local truth, exchange peer identity, recompute match, and require both users to explicitly Ready again. No old message or Ready choice is replayed. A signaling reconnect that preserves the same healthy channel preserves identity, match, and readiness; it triggers no duplicate announcement or rehash.

Selection replacement/clear, room leave/change, and shutdown abort old hashing. Every completion/progress callback is generation-owned. Cancellation is not a visible error; real failures use only FILE_TOO_LARGE, READ_FAILED, or HASH_FAILED. Progress is local only (coarse 10% UI updates; no per-chunk live announcements). No identity, private root, selection ID, remote evidence, or readiness is persisted; reload begins setup again.

## Message Families

The families below separate implemented Local Sync setup from future playback, social, transfer, and diagnostics contracts.

### Room and Session

The signaling-level room messages are implemented; see [above](#implemented-through-phase-2d-signaling-rooms-negotiation-recovery-and-ice-configuration). Capability negotiation at join remains conceptual. `READY` and `NOT_READY` are implemented by Phase 3A on the peer channel, as specified above.

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
| `MEDIA_INFO` | Announce only the current selection ID, version-1 session-scoped fingerprint, and byte length (implemented 3A). |
| `MEDIA_MATCH` | Report sufficient evidence that local media matches for Local Sync. |
| `MEDIA_MISMATCH` | Report byte identity mismatch for the current media pair (implemented 3A). |

Local filesystem paths and filenames are never exchanged. The exact Phase 3A identity scheme is normative above; metadata/compatibility exchange beyond it remains future work.

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

The implemented `driftless-control` channel is ordered and reliable. Any future transfer channel configuration remains undecided. Protocol behavior must therefore make its assumptions explicit per channel or message family.

- Playback state uses sequence or revision ordering so stale play/pause/seek messages cannot overwrite newer authority.
- Idempotent handling is preferred for retryable messages.
- Duplicate transfer chunks must not create duplicate buffered ranges or allocations.
- Missing transfer data is requested explicitly rather than inferred from wall-clock delay alone.
- Sequences are scoped to a room/session and are reset only through an authenticated, explicit session transition. (Implemented for signaling: see [Sequence reset](#sequence-reset).)
- Replayed messages from an expired or previous room session are rejected. (Implemented for the peer handshake, which names the session ID.)
- Reconnect includes state reconciliation before any new action is accepted, and there is no blind replay queue. (Implemented for signaling resume and peer recovery; future families inherit the rule.)

## Versioning and Compatibility

Peers exchange capabilities before mode activation. A peer that cannot safely interpret the active protocol version or required message family must not join that mode. Future compatible additions may be negotiated, but silent reinterpretation of existing fields is forbidden. Breaking changes require a new protocol version and migration documentation.

## Representation Still to Be Decided

Phase 2A settled, for signaling only: hand-written strict validation in `packages/protocol` rather than a schema library, the room ID, invite secret, and participant ID encodings, and the signaling error codes. Phase 2B settled the negotiation message shapes and the negotiation ID, the provisional negotiation bounds, and the control channel's label and settings and its connection handshake. Phase 2C settled the session ID, the resume secret, challenge, and proof formats, the resume flow and its sequence reset, signaling presence, the connection-ending classification, and the recovery messages and negotiation bound; its timing values remain provisional. Phase 2D settled the ICE server configuration messages, their bounds, and the TURN credential derivation.

Phase 3A settles media selection IDs, fingerprint version/format and bounded identity chunking, the five setup messages, and readiness invalidation/recovery. The following remain open: playback/social peer messages, binary framing, further channels, transfer identifiers and transport chunk size, acknowledgement strategy, future peer error vocabulary, timing intervals, and correction thresholds. Phase 0 evidence informs these decisions; later subsystem design and target-device/network qualification must settle them. Spike 0.7's laboratory wire format and one-part acknowledgement loop are not the production protocol.
