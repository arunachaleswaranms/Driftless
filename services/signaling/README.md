# @driftless/signaling

The Driftless signaling service: a small Node/TypeScript server that creates and admits private two-person rooms over a WebSocket. This is the Phase 2A foundation.

It carries only small JSON control messages. It never receives, stores, proxies, or inspects media, and it keeps no state beyond memory. It does not negotiate WebRTC yet: there is no SDP, ICE, STUN, or TURN handling, and the web client does not connect to it. Those begin in Phase 2B.

## Running

From the repository root, after `npm ci`:

```sh
npm run dev --workspace @driftless/signaling     # build, then run with development defaults
npm run build --workspace @driftless/signaling
npm run start --workspace @driftless/signaling   # run the built service
```

`dev` builds `@driftless/protocol` and the service with `tsc -b`, then starts it; there is no watch mode. No global tools are needed.

The service logs one JSON object per line to stdout and stops cleanly on `SIGINT` or `SIGTERM`: it refuses new connections, closes open ones with 1001 (terminating any that do not finish the close handshake within 2 seconds), stops the expiry sweep, and stops listening.

## Configuration

Configuration comes from environment variables only; no `.env` file is read, and tests need none. Invalid values stop the service with a message naming the variable. They are never replaced by defaults.

| Variable                     | Default                                      | Rule                                                                                                                                                     |
| ---------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                   | unset (development)                          | `production` selects production mode.                                                                                                                    |
| `SIGNALING_HOST`             | `127.0.0.1`                                  | An IP address literal or `localhost`. Loopback by default, so the service is not exposed to the LAN unless explicitly configured, for example `0.0.0.0`. |
| `SIGNALING_PORT`             | `8787`                                       | Integer 0–65535; 0 selects a free port.                                                                                                                  |
| `SIGNALING_ALLOWED_ORIGINS`  | development: see below; production: required | Comma-separated exact origins (`scheme://host[:port]`), at most 16. No wildcard, no `null`, no path. Production requires `https` origins.                |
| `SIGNALING_ROOM_TTL_SECONDS` | `3600`                                       | Integer 60–86400. Room lifetime from creation.                                                                                                           |

The development origin default is the web client's Vite servers on loopback: `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, and `http://127.0.0.1:4173`. Production has no default and never accepts `*`.

The one-hour room lifetime is a provisional engineering default, not a product decision.

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

- **Create.** `ROOM_CREATE` makes the connection the room's host. The service generates a non-secret room ID (16 bytes), a separate invite secret (32 bytes, 256 bits), and an opaque participant ID (12 bytes) from `crypto.randomBytes`, and returns them once, to the creator only, in `ROOM_CREATED`. The room keeps only a SHA-256 digest of the secret.
- **Join.** `ROOM_JOIN` carries the room ID and invite secret. The digest of the presented secret is compared in constant time (`timingSafeEqual`) against the room's digest, or against a decoy digest when the room does not exist. A missing room, an expired room, and a wrong secret all return the same `ROOM_UNAVAILABLE`. Only a caller with the correct secret can learn `ROOM_FULL`. On success the guest receives `ROOM_JOINED` (with the host's participant ID) and the host receives `ROOM_PARTICIPANT_JOINED`.
- **Participant limit.** A room has one host slot and one guest slot, so a third participant is never admitted.
- **Guest leaves or disconnects.** The guest slot is freed. The host receives `ROOM_PARTICIPANT_LEFT` with reason `LEFT` or `DISCONNECTED`, and the room stays open. The invite remains valid until the room ends, so a guest can join again, with a new participant ID.
- **Host leaves or disconnects.** The room closes and its invite stops working. The guest receives `ROOM_CLOSED` with `HOST_LEFT` or `HOST_DISCONNECTED`. The guest is never promoted to host.
- **Expiry.** One periodic sweep (every second) closes rooms whose lifetime has ended; members receive `ROOM_CLOSED` with `EXPIRED`. Joins are also refused at the moment of expiry, before the sweep runs. The sweep timer is stopped on shutdown.
- **Restart.** Rooms are not persisted. A restart drops every room.

The leaver of an intentional `ROOM_LEAVE` receives `ROOM_LEFT`.

## Connection states

```text
NOT_IN_ROOM --ROOM_CREATE / ROOM_JOIN--> IN_ROOM
IN_ROOM --ROOM_LEAVE, or ROOM_CLOSED received--> NOT_IN_ROOM
any --socket closed, or closed by the server--> CLOSED (terminal)
```

- `ROOM_CREATE` or `ROOM_JOIN` while `IN_ROOM` → `INVALID_STATE`. One connection never belongs to two rooms.
- `ROOM_LEAVE` while `NOT_IN_ROOM` → `INVALID_STATE`. Leave is not idempotent; the explicit error tells the client its state was not what it assumed.
- Clients never send a participant ID or role. Identity is bound to the connection, so it cannot be claimed or spoofed; a message with such a field fails validation.
- **No reconnect.** A dropped connection loses its membership, exactly as a leave does. There is no reconnect credential, session resumption, or state reconciliation. Phase 2C owns reconnect and must extend this behavior deliberately.

## Bounds

| Bound                        | Value                                      | Behavior                                                                                        |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| WebSocket message size       | 4096 bytes (`MAX_SIGNALING_MESSAGE_BYTES`) | `ws` closes the connection with 1009; no error message is sent.                                 |
| Message rate, per connection | token bucket: burst 20, then 5 per second  | `ERROR RATE_LIMITED` (not recoverable), then close 1008.                                        |
| Invalid messages             | 5 per connection                           | Each gets `ERROR INVALID_MESSAGE`; the fifth is not recoverable and the connection closes 1008. |
| Unsupported protocol version | —                                          | `ERROR UNSUPPORTED_PROTOCOL`, then close 1002.                                                  |
| Binary messages              | never accepted                             | `ERROR INVALID_MESSAGE`, then close 1003.                                                       |
| Concurrent connections       | 256                                        | Upgrade refused with 503.                                                                       |
| Rooms                        | at most one per connected host             | A room closes when its host's connection closes, so rooms never outlive connections.            |

The message size and rate values comfortably exceed Phase 2A traffic (messages are a few hundred bytes; a session sends a handful). They are implementation and security bounds, not benchmark-derived limits, and must be revisited when Phase 2B forwards SDP and ICE. `perMessageDeflate` is disabled.

Client `sequence` numbers must strictly increase on each connection; a duplicate or lower value is an invalid message. Sequence orders messages; it authorizes nothing. `sentAt` is diagnostic only. Server messages carry their own per-connection sequence starting at 0.

## Logging

`src/logger.ts` defines a closed set of structured events: `server_started`, `server_stopped`, `upgrade_rejected`, `connection_opened`, `connection_closed`, `room_created`, `participant_joined`, `participant_left`, `room_closed`, `message_rejected`, `transport_error`, and `internal_error`. Every field is a number or a fixed token. Connections are identified by a process-local counter.

Never logged: invite secrets, room IDs, participant IDs, raw payloads, request URLs, headers (including `Origin`), IP addresses, exception messages, and media of any kind. Error responses use fixed text per error code and never echo input.

## Tests

`npm test` runs 96 Vitest tests:

- `roomStore.test.ts` — room creation, credential format and entropy, joins, enumeration-safe failures, the participant limit, leave, disconnect, host non-transfer, expiry with an explicit clock, and retained-state bounds;
- `controller.test.ts` — the connection state machine, sequencing, notifications, violation, rate, and binary bounds, internal-error sanitization, and secret and identifier leakage;
- `server.integration.test.ts` — the real server on an ephemeral `127.0.0.1` port with real WebSocket clients: health, origins, paths, queries, capacity, room flows, disconnects, expiry through the sweep, oversized and binary messages, flooding, shutdown (including refusal of upgrades during shutdown and stop during start), and log contents. It verifies that no server, socket, or timer outlives the suite;
- `config.test.ts`, `credentials.test.ts`, `rateLimiter.test.ts`.

`npm run smoke:dist` runs the built `dist/main.js` as `npm start` does: production-mode refusal without origins, startup, health, one room, and SIGTERM shutdown. `npm run check` runs typecheck, lint, format, tests, build, and the smoke test.

Node and WebSocket tests are not browser, device, or network evidence.
