# Security Architecture Baseline

## Status

This document defines design requirements. Except for the controls listed under [Implemented in Phase 2A](#implemented-in-phase-2a), [Implemented in Phase 2B](#implemented-in-phase-2b), and [Implemented in Phase 2C](#implemented-in-phase-2c), it does not claim that controls have been implemented, audited, or tested. Nothing here has been independently security-audited. Security issues and reporting channels will be documented before public testing.

## Implemented in Phase 2A

The signaling foundation ([`services/signaling/`](../services/signaling/) and [`packages/protocol/`](../packages/protocol/)) implements these controls. They are covered by Node unit and loopback integration tests only; no deployment, browser, device, or real-network testing has occurred.

- **Separate room identifier and invite secret.** The loggable 128-bit `roomId` authorizes nothing. Joining requires a separate 256-bit `inviteSecret`. Both, and the 96-bit participant IDs, come from Node's `crypto.randomBytes`; no timestamp, counter, or `Math.random` is involved.
- **Secret handling.** The secret is returned once, to the room's creator, inside a WebSocket message. The service retains only its SHA-256 digest and compares digests with `timingSafeEqual`. It never appears in logs, errors, the health response, notifications to other participants, or URLs; the WebSocket upgrade refuses any query string.
- **Enumeration resistance.** A missing room, an expired room, and a wrong secret produce the same `ROOM_UNAVAILABLE` response by the same comparison path. `ROOM_FULL` is revealed only to a caller with the correct secret. Unauthorized callers receive no room metadata.
- **Room expiry.** Rooms have a finite, validated lifetime (60 s–24 h, default one hour, provisional) and are removed by a periodic sweep; joins are refused at expiry even before the sweep. A room also closes, invalidating its invite, when its host leaves or disconnects.
- **Participant limit.** Rooms hold one host and one guest; a third participant is never admitted. One connection belongs to at most one room. Clients cannot claim a participant ID or role.
- **Strict protocol validation.** Versioned envelope, exact fields at every level, bounded canonical identifiers, no coercion, unknown versions rejected, prototype-pollution keys rejected, typed results constructed only from validated values. Parser errors and exception text are never exposed.
- **Bounds.** 4096-byte WebSocket messages (32,768 bytes from Phase 2B); binary messages refused; per-connection token-bucket rate limit (burst 20, 5 per second; burst 48, 10 per second from Phase 2B); at most 5 invalid messages per connection; strictly increasing per-connection sequences; at most 256 connections; `perMessageDeflate` disabled. These are provisional implementation bounds.
- **Origin policy.** WebSocket upgrades require an `Origin` exactly matching a configured list. Development defaults to the local Vite origins; production requires an explicit `https` list and never accepts `*` or `null`. Origin is a browser policy layer, not authentication.
- **Conservative exposure.** The service binds to `127.0.0.1` by default. `GET /healthz` returns only `{"status":"ok"}`.
- **Sanitized logging.** A closed set of structured events whose fields are numbers or fixed tokens. No secrets, room or participant IDs, payloads, URLs, headers, or IP addresses are logged.
- **Ephemeral state, no media.** Rooms exist only in memory and are lost on restart. The service accepts only small JSON control messages and never receives, stores, or proxies media.

Plain `ws://` is a development-only exception. Production must use HTTPS and WSS through TLS termination in front of the service; no deployment exists yet.

## Implemented in Phase 2B

Phase 2B adds WebRTC negotiation through the service and the browser room client. The service controls have Node unit and loopback integration tests; the browser controls have unit tests and automated same-host browser tests (two browser contexts on one development machine). There is no deployment, real-network, NAT-traversal, TURN, or device evidence.

- **Server-derived routing and roles.** Negotiation messages name no destination room, participant, or role. The service relays each one only to the sender's one peer in the sender's current room, so cross-room relay and role impersonation cannot be expressed. Only the host may offer and only the guest may answer.
- **Negotiation correlation and stale rejection.** Every negotiation message names a negotiation ID; the service accepts only the active one. One negotiation exists per guest membership, a second offer is refused, the room's most recent ID cannot be reused, and a guest's departure discards the negotiation, so a new guest never inherits or receives an old one. The browsers likewise ignore signaling and peer events that do not belong to their current room, guest, and negotiation.
- **Bounded SDP and ICE.** Session descriptions (16,384 bytes), candidate strings (1024 bytes, printable ASCII), `sdpMid`, username fragments, the m-line index, and candidates per participant per negotiation (32) are bounded and exactly typed, with extra fields refused. Size bounds count UTF-8 bytes in the shared parser, so multi-byte text cannot exceed them. A message whose relay could exceed the message bound is refused. The service keeps only counters and flags: it stores no session description, candidate, or negotiation history, and parses no SDP.
- **Rate limiting.** Provisional per-connection token bucket of burst 48, 10 per second, enough for one whole negotiation burst, still closing a flooding connection.
- **No negotiation data in logs or errors.** The closed log union gained one event, `negotiation_relayed`, with a connection counter and a fixed step token; candidates are not logged at all. No SDP, candidate, username fragment, IP address, fingerprint, negotiation ID, or invite secret is logged or echoed in an error; tests inject recognizable values to check this.
- **Browser validation.** The browser parses every server message with the shared parser before use and closes the connection on an invalid or out-of-sequence message. It sends local candidates only as validated four-field plain objects, holds early remote candidates in a queue bounded by count (32) and size (16 KiB), and drops the queue on every teardown.
- **One trusted channel, and a handshake.** The guest accepts only the expected ordered, reliable control channel; any other or additional channel is closed and fails the session. The session counts as connected only after a strictly validated handshake that names the negotiation and both participant IDs has crossed the channel both ways. The invite secret never crosses the data channel.
- **No media.** The peer connection carries one data channel only. The client never calls `getUserMedia`, `getDisplayMedia`, `addTrack`, or `addTransceiver`.
- **Secret handling in the browser.** The invite secret lives only in memory while its room exists: masked until the host reveals it, copied only on request, never placed in a URL, history, Web Storage, IndexedDB, OPFS, Cache Storage, or a log, and dropped when the room ends. Join fields are cleared after use, use `autocomplete="off"`, and the secret field is not a password field, to avoid prompting a password manager to save it.
- **Same-origin, secure signaling.** The browser derives the WebSocket URL from its own origin: `wss` for `https` pages, plain `ws` only on a loopback development origin, otherwise no connection. The URL carries no room ID, secret, or query. The development and preview servers forward the path to a loopback signaling service; the Content Security Policy is unchanged, because `default-src 'self'` already admits the same-origin socket.
- **STUN configuration validation.** ICE servers come only from the build-time `VITE_RTC_STUN_URLS` setting, default none. Only `stun:` and `stuns:` URLs with a host and optional port are accepted, at most four; any invalid entry disables rooms rather than being skipped. TURN URLs and credentials are refused.
- **No recovery in this phase.** There was no reconnect, ICE restart, or renegotiation in Phase 2B: a failure tore the session down. Phase 2C replaces this with the bounded, authenticated recovery below.

## Implemented in Phase 2C

Phase 2C adds authenticated signaling resume and bounded peer recovery. The service controls have Node unit and loopback integration tests; the browser controls have unit tests and automated same-host browser tests. There is no deployment, real-network, NAT-traversal, TURN, mobile, or device evidence.

- **Separate resume credential.** Each participant receives its own 264-bit `resumeSecret` from `crypto.randomBytes`, once, inside its own `ROOM_CREATED` or `ROOM_JOINED`. It is distinct from the invite secret, is never sent to the other participant, and authorizes nothing but resuming that one participant's membership: it cannot create or join a room. The invite secret is never a reconnect credential.
- **Derived key only.** The service keeps only `SHA-256(resumeSecret bytes)`, in memory. That key is the HMAC key of resume proofs, so it is sensitive in its own right; it is never logged or sent, and it is discarded with the membership.
- **Challenge-response, never secret replay.** A resuming connection names the session and participant, receives a fresh 192-bit challenge, and answers with `HMAC-SHA-256(key, fixed 76-byte input)` binding a domain separator, the session ID, the participant ID, and the challenge. The secret is never resent. Browsers compute the proof with Web Crypto, importing the key as non-extractable; the service verifies with Node's crypto and `timingSafeEqual`. No crypto dependency was added.
- **One-time, connection-bound challenges.** A challenge belongs to the connection that asked for it, expires after 10 seconds, and is consumed by the first proof whatever the outcome. It is dropped on proof, expiry, connection close, and shutdown; a connection holds at most one. A proof captured for one challenge does not answer another, and an old proof cannot resume a participant after a later disconnection.
- **Enumeration-safe refusal.** An unknown session or participant, a wrong or replayed proof, an expired challenge or room, an ended grace period, an ended membership, and a participant that is still connected all produce one recoverable `SESSION_UNAVAILABLE` with fixed text, after the same constant-time comparison (against a decoy key when nothing matches). The challenge reveals nothing either, and no room metadata reaches an unauthenticated connection.
- **One live binding, no takeover.** A participant has at most one connection. A resume is accepted only for a participant whose connection has been lost; a live connection is never evicted, even by a valid proof, and an old connection is unbound the moment it is lost, so it can never act again. Membership is stored independently of connections, and the store never sees a socket.
- **Reconnect grace, bounded.** An ordinary transport loss holds the membership for a validated, provisional 30-second grace period (5–120 s); a guest keeps its slot. The grace ends exactly at its deadline, room expiry overrides it, and the host's expiry closes the room. No one is promoted, and no host role is transferred.
- **Policy closures are terminal.** A connection closed by the service for rate limiting, repeated invalid messages, an unsupported protocol version, binary data, an internal error, or an invalid or oversized WebSocket frame loses its membership at once, with no grace, so the participant cannot resume to bypass the enforcement. A client's own normal (1000), going-away (1001), or protocol-error (1002) close and `ROOM_LEAVE` are also terminal; a browser abandoning a resume attempt closes with 4000 instead, so an attempt the service had just accepted does not end the membership; a left membership's key is discarded.
- **No queued traffic for offline peers.** Every negotiation and recovery message towards a reconnecting participant is refused; nothing is stored for it. Recovery after resume is snapshot reconciliation, never replay, and the browser queues nothing while signaling is down.
- **Bounded recovery and stale-negotiation rejection.** A guest membership uses at most four negotiations, each with an ID never accepted again within that membership (nor, for a later guest, the room's most recent ID); one guest recovery request is accepted per negotiation; only the host may send a recovery offer, naming the exact active negotiation. A replaced negotiation's answers and ICE are refused by the service and ignored by the browsers. The peer handshake now names the room session ID, so a message from another session, an earlier room incarnation, another participant, or another negotiation fails the session.
- **Authoritative leave while reconnecting.** A user who leaves while signaling is reconnecting does not merely leave locally: the browser closes the peer connection at once, then, on a finite schedule (5 attempts), authenticates by the same challenge and proof and sends `ROOM_LEAVE`, so the service frees the guest's slot or closes the host's room and invalidates its invite at once. A resume made for this purpose never restores the room. The credentials stay in private memory only for that bounded attempt and are discarded after it. If the service cannot be reached throughout, the browser cannot invalidate anything remotely: it leaves locally and discards the credential, and the membership — including a host's room and invite — remains valid on the service until the reconnect grace period or room lifetime ends.
- **Bounded reconnect attempts.** The browser makes at most eight resume attempts on a fixed schedule (largest delay 4 s, 15.75 s of delays in all), each abandoned after 5 seconds without an answer, then ends the room and closes its peer session. Exactly one schedule exists per room session, and every timer is cancelled on leave, room end, successful resume, and shutdown.
- **Bounded retained state.** At most 256 rooms are held at once (rooms whose host is reconnecting count), one resume key per participant, one pending challenge per connection, at most four used negotiation IDs per membership, one sweep timer, and one liveness timer.
- **Liveness.** WebSocket protocol pings (provisional 15-second interval, 5–60 s) detect dead connections, which then enter the grace period like any loss. No application message is involved. Detection takes up to two intervals, which can outlast the browser's retry schedule on a silently dead path; see the known limitation in [PROTOCOL.md](PROTOCOL.md#connection-endings).
- **No credential persistence or exposure in the browser.** The resume secret lives only in the room controller's private memory, never in the rendered state, the page, a URL, history, Web Storage, IndexedDB, OPFS, Cache Storage, the clipboard, or a log; it is dropped when the room ends. A page reload therefore cannot resume a room. The interface shows no secret, challenge, proof, retry count, timer, or raw error.
- **Sanitized logging.** New fixed events `participant_disconnected`, `resume_challenge_issued`, `participant_resumed`, `resume_rejected` (with no reason), and `reconnect_timeout` (with a role token), and negotiation steps `recover` and `recovery_request`. No resume secret, key, proof, challenge, session ID, participant ID, room ID, SDP, candidate, or address is logged; tests inject recognizable values to check this.

Still future, not implemented: TURN and its short-lived credential issuance, per-IP or per-room abuse controls beyond the per-connection bounds and the room cap (a client can still hold rooms for one grace period after dropping its connection), idle-connection timeouts for connections that join no room, production deployment security, real-network abuse measurements, privacy-conscious selected-path diagnostics, the peer data-channel application protocol beyond the connection handshake, Phase 3 peer control authorization, Local Sync controls, media integrity, and transfer and cache resource controls.

## Threat Model Scope

The baseline covers the browser client, signaling service, room/invite flow, WebRTC negotiation and data channels, TURN use, browser-local cache, protocol parsing, media parsing, and operational logging. It considers network attackers, unauthenticated abuse, malicious or compromised peers, malformed media, supply-chain compromise, accidental leakage, and device resource exhaustion.

The baseline cannot protect media after an authorized peer receives or displays it, cannot make a compromised endpoint trustworthy, and does not provide DRM.

## Assets

- Invite secrets, room membership, and session authorization.
- Local media contents, metadata, filenames, and fingerprints.
- Playback, chat, reaction, readiness, and presence data.
- WebRTC negotiation details, IP-related metadata, and connection diagnostics.
- Cached media segments and transfer-resume state.
- Signaling and TURN credentials and service secrets.
- Participant device availability, storage, memory, bandwidth, and battery.

## Trust Boundaries

```text
Untrusted network
    |
    +-- HTTPS/WSS --> signaling service --> room state / service secrets
    |
    +-- WebRTC ----> peer browser -------> protocol and media parsers
                                      \--> cache/storage and HTML5 media stack
    |
    +-- TURN ------> relay operator/network boundary
```

The browser UI, worker contexts, shared packages, backend service, TURN service, and remote peer are separate trust boundaries. Local browser APIs and media decoders also handle attacker-influenced data and must be treated defensively.

**WebRTC encryption does not mean the peer itself is trusted.** An authorized or compromised peer can send malicious protocol messages, misleading state, oversized data, or crafted media.

## Required Controls

- Generate unpredictable invite secrets with sufficient entropy; never use enumerable room identifiers as authorization.
- Enforce room expiry and invite expiry, and invalidate both on terminal room closure.
- Enforce the maximum participant count server-side and client-side.
- Validate every signaling, control, metadata, and binary message against its protocol and current state.
- Apply explicit message-size, text-size, collection-size, chunk-size, allocation, queue, and rate bounds.
- Require media integrity verification at defined levels before data is promoted for playback or cache reuse.
- Define cache cleanup for expiry, cancellation, failed validation, and user request according to documented lifecycle rules.
- Require secure TURN credential handling and prefer short-lived, scoped credentials where the deployment permits.
- Use HTTPS and WSS in deployed environments; do not expose secrets through URLs, referrers, or logs.
- Require no permanent backend media storage in the normal architecture.

Exact bounds and cryptographic formats will be selected through design and measurement, then documented before implementation gates pass.

## Signaling Threats

The signaling service must defend against room enumeration, invite guessing, unauthorized joins, participant-slot exhaustion, replayed negotiation data, message flooding, malformed SDP/ICE payloads, cross-room message injection, stale sessions, and metadata leakage.

Planned mitigations include unpredictable secret-bearing invites, expiry, strict participant limits, origin and authentication policy, schema and state validation, per-principal/IP/room rate limits, bounded payloads, short retention, and sanitized diagnostics. Room identifiers and invite secrets should be separated where possible so a loggable identifier is not itself the credential.

## WebRTC and Data-Channel Threats

All peer messages are untrusted after decryption. Receivers must reject:

- Unknown protocol versions or message types.
- Invalid state transitions or unauthorized host actions.
- Replayed, stale, conflicting, or cross-session sequences.
- Invalid offsets, lengths, overlapping ranges, and inconsistent totals.
- Oversized messages, chunks, metadata collections, chat, or reactions.
- Data that would cause unbounded buffering, acknowledgement storms, or retry loops.

Backpressure and bounded concurrency are security controls as well as performance features. Connection closure must release owned queues, temporary state, object URLs, MSE resources, and storage handles.

## Malicious Peer and State Manipulation

A malicious peer may impersonate authority, race state changes, falsify timestamps, request arbitrary ranges, advertise impossible sizes, send corrupted media, force repeated seeks, or attempt storage and memory exhaustion. The protocol must tie actions to the active room/session, enforce role permissions, order authoritative revisions, validate advertised media structure, cap resource commitments, and allow safe cancellation.

Clock values and `sentAt` fields are observations, not trusted security assertions. Reconnect requires authenticated state reconciliation; queued messages from an old connection cannot be applied blindly.

## Media, Filename, and Path Safety

Local paths must never be sent to peers or backend services. Filenames, if displayed or retained, are untrusted text: strip path semantics, normalize safely, escape in the UI, bound length, and never use a remote filename directly as a filesystem path or HTML value. Cache keys should use internal identifiers rather than participant-supplied paths.

Container parsing and browser decoding operate on potentially malicious bytes. Parser dependencies must be kept current, isolated where practical, and exercised with malformed media. Driftless will not execute media metadata or treat it as markup.

## Memory and Storage Exhaustion

- Check declared sizes and arithmetic for overflow before allocation.
- Stream and incrementally verify data instead of building unbounded in-memory blobs.
- Bound partial chunks, in-flight segments, retransmission state, and queued sends.
- Estimate storage availability without treating browser quota estimates as guarantees.
- Stop safely on quota loss or eviction and provide cleanup controls.
- Apply per-room/session and global cache ceilings selected from device evidence.
- Delete invalid partial state that cannot be resumed safely.

## Cache Privacy

Cached media remains sensitive even when stored in a browser-private origin. The application must document persistence, provide user-visible cleanup, avoid service-worker exposure outside required routes, isolate entries by media and session identity, and prevent one participant or room from discovering another's cached data. Shared-device and browser-profile risks must be explained.

## TURN and Network Metadata

TURN may observe connection metadata and relay encrypted media traffic. Credentials must not be committed, embedded as long-lived public secrets, logged, or exposed to unrelated rooms. Credential issuance, expiry, quotas, abuse response, provider trust, and bandwidth alerts are production decisions. No TURN provider has been selected.

## Browser Security Controls

The deployed web client should use a restrictive Content Security Policy, HTTPS-only delivery, safe framing policy, appropriate referrer policy, permissions policy, Subresource Integrity where applicable, safe cross-origin isolation decisions, and secure service-worker scope. Any cross-origin isolation required by a selected implementation must be assessed for deployment and third-party integration effects.

WSS is required for production signaling. Development exceptions must not become production defaults.

## Dependency and Supply-Chain Security

- Minimize dependencies and justify security-sensitive parsers and networking packages.
- Pin and review dependency changes through the chosen package-management policy.
- Run vulnerability, license, and provenance checks once tooling exists.
- Protect build and release credentials and review generated artifacts.
- Respond to vulnerabilities according to severity and exposure, not only automated scores.

MP4Box.js is an investigation candidate, not an approved dependency.

## Secrets Handling

Secrets, credentials, tokens, and `.env` files must not be committed. Production signaling and TURN secrets belong in a managed secret store or deployment-specific secure configuration. Client-delivered code cannot hold a durable secret. Rotation and revocation procedures must exist before production use.

## Logging and Privacy

Logs must omit media bytes, invite secrets, full credentials, local paths, chat contents by default, raw session descriptions unless explicitly required and sanitized, and unnecessary IP or device identifiers. Use bounded, structured event codes and short retention. Diagnostic export must be explicit and reviewable by the user.

## Security Test Expectations

The [test plan](TEST_PLAN.md) includes schema fuzzing, malformed frames and media, authorization and replay tests, rate limiting, quota pressure, oversized input, reconnect state manipulation, cache isolation, and dependency checks. Passing transport-encryption tests alone is insufficient.
