# @driftless/signaling

The Driftless signaling service: a small Node/TypeScript server that creates and admits private two-person rooms over a WebSocket (Phase 2A), relays WebRTC negotiation between a room's two members (Phase 2B), and holds a member's room membership through a lost connection until it resumes by proof, relaying fresh recovery negotiations (Phase 2C).

It carries only small JSON control messages. It never receives, stores, proxies, or inspects media, and it keeps no state beyond memory. It treats session descriptions as opaque bounded text and keeps none of them. It provides no STUN or TURN service.

## Running

From the repository root, after `npm ci`:

```sh
npm run dev --workspace @driftless/signaling     # build, then run with development defaults
npm run build --workspace @driftless/signaling
npm run start --workspace @driftless/signaling   # run the built service
```

`dev` builds `@driftless/protocol` and the service with `tsc -b`, then starts it; there is no watch mode. No global tools are needed.

The service logs one JSON object per line to stdout and stops cleanly on `SIGINT` or `SIGTERM`: it refuses new connections, closes open ones with 1001 (terminating any that do not finish the close handshake within 2 seconds), drops all rooms, memberships, and pending challenges, stops the expiry sweep and the liveness check, and stops listening.

## Configuration

Configuration comes from environment variables only; no `.env` file is read, and tests need none. Invalid values stop the service with a message naming the variable. They are never replaced by defaults.

| Variable                            | Default                                      | Rule                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                          | unset (development)                          | `production` selects production mode.                                                                                                                    |
| `SIGNALING_HOST`                    | `127.0.0.1`                                  | An IP address literal or `localhost`. Loopback by default, so the service is not exposed to the LAN unless explicitly configured, for example `0.0.0.0`. |
| `SIGNALING_PORT`                    | `8787`                                       | Integer 0–65535; 0 selects a free port.                                                                                                                  |
| `SIGNALING_ALLOWED_ORIGINS`         | development: see below; production: required | Comma-separated exact origins (`scheme://host[:port]`), at most 16. No wildcard, no `null`, no path. Production requires `https` origins.                |
| `SIGNALING_ROOM_TTL_SECONDS`        | `3600`                                       | Integer 60–86400. Room lifetime from creation.                                                                                                           |
| `SIGNALING_RECONNECT_GRACE_SECONDS` | `30`                                         | Integer 5–120. How long a member whose connection was lost keeps its membership.                                                                         |
| `SIGNALING_HEARTBEAT_SECONDS`       | `15`                                         | Integer 5–60. Interval of WebSocket protocol pings; a connection that misses one is treated as lost.                                                     |

The development origin default is the web client's Vite servers on loopback: `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, and `http://127.0.0.1:4173`. Production has no default and never accepts `*`.

The web client connects to `/v1/signaling` on its own origin. Its development and preview servers forward that path to this service (default `http://127.0.0.1:8787`), passing the browser's `Origin` through unchanged, so this origin policy still applies. A deployment must route the path the same way behind TLS.

The one-hour room lifetime, the 30-second reconnect grace period, and the 15-second ping interval are provisional engineering defaults, not product decisions; the ping interval is not tuned for mobile networks.

## Production boundary: HTTPS and WSS

The service speaks plain HTTP and `ws://`. **Plain `ws://` is a development-only exception.** A deployment must terminate TLS in front of the service (a reverse proxy or platform load balancer) so that clients use HTTPS and WSS only. No certificate handling is built in, and no deployment has been chosen.

## Endpoints

- `GET /healthz` (and `HEAD`) → `200 {"status":"ok"}` with `Cache-Control: no-store`. It reveals no counts, identifiers, versions, addresses, or environment.
- `/v1/signaling` → the WebSocket endpoint. The upgrade is refused with:
  - `404` for any other path;
  - `400` if the URL has any query string, so credentials cannot be placed in it;
  - `403` if the `Origin` header is missing or not exactly one of the allowed origins;
  - `503` when the connection bound (256) is reached, or once shutdown has begun.
- Everything else → `404`.

Origin checking is a browser-enforced policy layer, not authentication: a non-browser client can send any `Origin`. Room authorization comes only from the invite secret inside a validated message.

## Rooms

`src/roomStore.ts` holds rooms in memory, independent of the transport:

```text
WebSocket (src/server.ts) → protocol parser → SignalingController (src/controller.ts) → RoomStore
```

- **Create.** `ROOM_CREATE` makes the connection the room's host. The service generates a non-secret room ID (16 bytes), a non-secret session ID (20 bytes) naming this room incarnation, a separate invite secret (32 bytes, 256 bits), the host's own resume secret (33 bytes, 264 bits), and an opaque participant ID (12 bytes) from `crypto.randomBytes`, and returns them once, to the creator only, in `ROOM_CREATED`. The room keeps only SHA-256 digests of the two secrets. At most 256 rooms are held at once, including rooms whose host is reconnecting; beyond that `ROOM_CREATE` gets `SERVER_ERROR`.
- **Join.** `ROOM_JOIN` carries the room ID and invite secret. The digest of the presented secret is compared in constant time (`timingSafeEqual`) against the room's digest, or against a decoy digest when the room does not exist. A missing room, an expired room, and a wrong secret all return the same `ROOM_UNAVAILABLE`. Only a caller with the correct secret can learn `ROOM_FULL`. On success the guest receives `ROOM_JOINED` (with the session ID, its own resume secret, and the host's participant ID) and the host receives `ROOM_PARTICIPANT_JOINED`; if the host is reconnecting, the guest instead also receives `ROOM_PARTICIPANT_CONNECTION` `RECONNECTING` for the host.
- **Participant limit.** A room has one host slot and one guest slot, so a third participant is never admitted.
- **Guest leaves.** The guest slot is freed. The host receives `ROOM_PARTICIPANT_LEFT` with reason `LEFT` (a `ROOM_LEAVE`), `DISCONNECTED` (a normal close or a policy closure), or `RECONNECT_TIMEOUT` (the guest's grace ended), and the room stays open. The invite remains valid until the room ends, so a guest can join again, with a new participant ID.
- **Host leaves.** The room closes and its invite stops working. The guest receives `ROOM_CLOSED` with `HOST_LEFT`, `HOST_DISCONNECTED`, or `HOST_RECONNECT_TIMEOUT`. The guest is never promoted to host.
- **Connection lost.** An ordinary loss holds the membership for the reconnect grace period; see [Session resume](#session-resume).
- **Expiry.** One periodic sweep (every second) closes rooms whose lifetime has ended (members receive `ROOM_CLOSED` with `EXPIRED`), ends grace periods, and drops expired challenges. Joins and resumes are also refused at the deadline, before the sweep runs. Room expiry overrides every grace period. The sweep timer is stopped on shutdown.
- **Restart.** Rooms are not persisted. A restart drops every room, and no membership can be resumed afterwards.

The leaver of an intentional `ROOM_LEAVE` receives `ROOM_LEFT`.

## Session resume

A participant is a stable membership: its participant ID, role, and a derived resume key belong to the room, and a connection is only its current binding. `RoomStore` holds participants, never sockets.

- **Connection endings.** `ROOM_LEAVE`, a client close with 1000, 1001, or 1002, and every close the service makes for a policy or protocol violation (rate limit, invalid messages, unsupported version, binary data, internal error, or an invalid or oversized frame reported by `ws`) end the membership at once; none is resumable. Any other close — above all a lost TCP connection (1006) or a missed protocol ping — holds the membership, unbound, for the grace period. A held guest keeps its slot. The other member, if connected, receives `ROOM_PARTICIPANT_CONNECTION` with `RECONNECTING`, and `CONNECTED` on resume, each with the service's active negotiation ID and negotiation count.
- **Flow.** A new connection that is in no room sends `SESSION_RESUME_BEGIN { sessionId, participantId }` and always receives a fresh 24-byte `SESSION_RESUME_CHALLENGE`, whether or not the session exists. While that challenge is pending the connection may send only `SESSION_RESUME_PROVE { challenge, proof }`. The challenge is consumed by the proof, whatever the outcome, and expires after 10 seconds.
- **Verification.** `proof` must be HMAC-SHA-256 of the 76-byte `resumeProofInput` under the participant's stored key, compared with `timingSafeEqual` (against a decoy key when the session or participant is unknown). It must answer this connection's pending, unexpired challenge, and the participant must be reconnecting, within its grace period, in an unexpired room. Then the connection is bound to the membership and receives `SESSION_RESUMED`, the authoritative snapshot; otherwise it receives the same recoverable `ERROR SESSION_UNAVAILABLE` for every cause. A live connection is never taken over.
- **Grace.** When a guest's grace ends, its slot is freed and the host receives `ROOM_PARTICIPANT_LEFT` `RECONNECT_TIMEOUT`; when a host's ends, the room closes with `HOST_RECONNECT_TIMEOUT`. Both may be reconnecting at once. Nothing is queued for a reconnecting member.
- **Sequences.** The new connection starts its own sequence spaces; the reset grants nothing without the accepted proof, and nothing from the old connection is replayed.
- **Liveness.** A WebSocket protocol ping goes to every connection each heartbeat interval; one that has not answered the previous ping is terminated and treated as lost. Until then a silently dead connection still counts as live, and a resume is refused, so detection (up to two intervals) can outlast a client's retries; tuning this needs real-network evidence.

## Negotiation relay

`RTC_OFFER`, `RTC_ANSWER`, `ICE_CANDIDATE`, and `ICE_COMPLETE` name no destination. `RoomStore.negotiate()` derives the room and the recipient from the sender's membership and decides legality; the controller then relays the validated payload in a new server message to the sender's peer only.

- Only the host offers; only the guest answers, once per negotiation. The first negotiation of a guest membership is an `RTC_OFFER`; a second `RTC_OFFER` is refused. Later ones are `RTC_RECOVER { previousNegotiationId, negotiationId, sdp }`, accepted only from the host, naming the active negotiation, with a never-used ID, while fewer than 4 (`MAX_NEGOTIATIONS_PER_MEMBERSHIP`) negotiations have been used; the new negotiation replaces the old one atomically, with fresh counters and flags. `RTC_RECOVERY_REQUEST { negotiationId }` from the guest is relayed once per active negotiation, only while a recovery can follow. No ID used by the membership, nor the room's most recent ID, is accepted again.
- The recipient must be connected; every message towards a reconnecting member is refused.
- Every other message must name the active negotiation. The host may send candidates after its offer; the guest after its answer. Each sends at most 32 candidates (`MAX_ICE_CANDIDATES_PER_NEGOTIATION`) and one `ICE_COMPLETE`, then no more candidates.
- A connection outside a room, a room without a guest, a wrong or stale negotiation ID, and every role or order violation receive a recoverable `ERROR INVALID_STATE`. These refusals do not count toward the invalid-message limit, because a well-behaved client can send a candidate just before its peer leaves.
- A message whose relayed copy, with the service's own envelope, could exceed the message bound is refused as `INVALID_MESSAGE` before any state changes.
- The room keeps only the active negotiation ID, an answered flag, a recovery-requested flag, per-participant candidate counters, completion flags, and the membership's used negotiation IDs (at most 4). Session descriptions and candidates are never stored. The negotiation state is discarded when the guest's membership ends and with the room, and kept while a member is reconnecting.

## Connection states

```text
NOT_IN_ROOM --ROOM_CREATE / ROOM_JOIN--> IN_ROOM
NOT_IN_ROOM --SESSION_RESUME_BEGIN--> RESUMING
RESUMING --SESSION_RESUME_PROVE accepted--> IN_ROOM
RESUMING --proof refused, or challenge expired--> NOT_IN_ROOM
IN_ROOM --ROOM_LEAVE, or ROOM_CLOSED received--> NOT_IN_ROOM
any --socket closed, or closed by the server--> CLOSED (terminal)
```

- `ROOM_CREATE` or `ROOM_JOIN` while `IN_ROOM` → `INVALID_STATE`. One connection never belongs to two rooms.
- `ROOM_LEAVE` while `NOT_IN_ROOM` → `INVALID_STATE`. Leave is not idempotent; the explicit error tells the client its state was not what it assumed.
- Clients never claim a participant ID or role. The only client message naming a participant ID is `SESSION_RESUME_BEGIN`, and it grants nothing until the proof is accepted; any other message with such a field fails validation.
- A `CLOSED` connection is gone: its membership is either ended or held for the grace period, unbound, and nothing it sends later is processed.

## Bounds

| Bound                        | Value                                        | Behavior                                                                                           |
| ---------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| WebSocket message size       | 32,768 bytes (`MAX_SIGNALING_MESSAGE_BYTES`) | `ws` closes the connection with 1009; no error message is sent.                                    |
| Message rate, per connection | token bucket: burst 48, then 10 per second   | `ERROR RATE_LIMITED` (not recoverable), then close 1008.                                           |
| ICE candidates               | 32 per participant per negotiation           | `ERROR INVALID_STATE` (recoverable); not relayed.                                                  |
| Invalid messages             | 5 per connection                             | Each gets `ERROR INVALID_MESSAGE`; the fifth is not recoverable and the connection closes 1008.    |
| Unsupported protocol version | —                                            | `ERROR UNSUPPORTED_PROTOCOL`, then close 1002.                                                     |
| Binary messages              | never accepted                               | `ERROR INVALID_MESSAGE`, then close 1003.                                                          |
| Concurrent connections       | 256                                          | Upgrade refused with 503.                                                                          |
| Rooms                        | 256, at most one per host                    | `ROOM_CREATE` gets `ERROR SERVER_ERROR`; rooms of reconnecting hosts count until their grace ends. |
| Negotiations                 | 4 per guest membership                       | `ERROR INVALID_STATE` (recoverable); not relayed.                                                  |
| Pending resume challenges    | 1 per connection, 10 s                       | Consumed by the proof; dropped on expiry, close, and shutdown.                                     |
| Reconnect grace              | 30 s default, 5–120 s                        | Then the membership ends (`RECONNECT_TIMEOUT` / `HOST_RECONNECT_TIMEOUT`).                         |

`ws` counts the payload in bytes and the shared parser counts the decoded text in UTF-8 bytes against the same constant, so the two limits agree. The 32 KiB message bound fits a 16 KiB session description after JSON escaping; data-channel-only Chromium negotiation in the browser tests produced descriptions of about 715 bytes. The rate limit was raised from Phase 2A's burst 20, 5 per second so that one whole trickled negotiation (create or join, the description, 32 candidates, completion) fits in a burst; it still closes a flooding connection. These are provisional implementation and security bounds, not benchmark-derived limits. `perMessageDeflate` is disabled.

Client `sequence` numbers must strictly increase on each connection; a duplicate or lower value is an invalid message. Sequence orders messages; it authorizes nothing. `sentAt` is diagnostic only. Server messages carry their own per-connection sequence starting at 0.

## Logging

`src/logger.ts` defines a closed set of structured events: `server_started`, `server_stopped`, `upgrade_rejected`, `connection_opened`, `connection_closed`, `room_created`, `participant_joined`, `participant_left`, `room_closed`, `participant_disconnected` (a membership entered its grace period), `resume_challenge_issued`, `participant_resumed`, `resume_rejected` (with no reason), `reconnect_timeout` (with a role token), `negotiation_relayed` (offer, answer, completion, recover, and recovery request, never candidates), `message_rejected`, `transport_error` (including `liveness_timeout`), and `internal_error`. Every field is a number or a fixed token. Connections are identified by a process-local counter.

Never logged: invite secrets, resume secrets and keys, resume challenges and proofs, room IDs, session IDs, participant IDs, negotiation IDs, session descriptions, ICE candidates and username fragments, raw payloads, request URLs, headers (including `Origin`), IP addresses, exception messages, and media of any kind. Error responses use fixed text per error code and never echo input.

## Tests

`npm test` runs 183 Vitest tests:

- `roomStore.test.ts` (45) — room creation, credential format and entropy (including session IDs and resume secrets), joins, enumeration-safe failures, the participant limit, leave, host non-transfer, expiry with an explicit clock, retained-state bounds, negotiation legality, routing, candidate bounds, and cleanup; and stable membership: holding a lost participant, resume by proof with the same identity and role, one indistinguishable refusal for every unusable resume, one binding, exactly-at-deadline guest and host timeouts, both participants lost at once, room expiry over grace, terminal leave, the room cap, recovery offers and requests, the negotiation bound, refusal towards reconnecting members, and zero retained state after many cycles;
- `controller.test.ts` (45) — the connection state machine, sequencing, notifications, violation, rate, and binary bounds, internal-error sanitization, secret and identifier leakage, and the negotiation relay: both directions, every role, order, and stale-ID refusal, replacement guests, room closure, overlong and malformed SDP and candidates, the candidate limit, relay size, flooding, and the absence of SDP, candidate, and negotiation ID text from logs and errors;
- `reconnect.test.ts` (24) — close classification, presence notifications, guest and host resume, timeouts, a guest joining while the host is away, room expiry over resume, equivalent challenges for real and fake sessions, one result for wrong proofs, fake sessions, and expired rooms, consumed challenges and replayed proofs, challenge expiry, no takeover of a live connection, a powerless old connection, the sequence reset, resume state rules, shutdown cleanup, log contents, terminal policy closures, no traffic for an absent peer, and the recovery relay and its bound;
- `server.integration.test.ts` (42) — the real server on an ephemeral `127.0.0.1` port with real WebSocket clients: health, origins, paths, queries, capacity, room flows, normal closes, grace and cleanup after abrupt loss, expiry through the sweep, oversized and binary messages, multi-byte size agreement between the transport and the parser, flooding, a full negotiation relay, a third participant's refused negotiation, a candidate burst under the default rate limit, shutdown (including refusal of upgrades during shutdown and stop during start), log contents, and session resume over real sockets: guest and host resume, wrong, fake, and replayed proofs, one binding, timeouts, room expiry, a policy-terminated connection, a client that never answers pings, and no secret, proof, challenge, or identifier in the logs. It verifies that no server, socket, or timer outlives the suite;
- `config.test.ts` (11), `credentials.test.ts` (10, including the service's proof verifier against the fixed vector), `rateLimiter.test.ts` (6).

`npm run smoke:dist` runs the built `dist/main.js` as `npm start` does: production-mode refusal without origins, startup, health, one room with a joined guest and a relayed offer, a lost guest connection resumed by challenge and proof, and SIGTERM shutdown. `npm run check` runs typecheck, lint, format, tests, build, and the smoke test.

Node and WebSocket tests are not browser, device, or network evidence.
