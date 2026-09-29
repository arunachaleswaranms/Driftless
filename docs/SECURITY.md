# Security Architecture Baseline

## Status

This document defines design requirements. Except for the Phase 2A signaling controls listed under [Implemented in Phase 2A](#implemented-in-phase-2a), it does not claim that controls have been implemented, audited, or tested. Nothing here has been independently security-audited. Security issues and reporting channels will be documented before public testing.

## Implemented in Phase 2A

The signaling foundation ([`services/signaling/`](../services/signaling/) and [`packages/protocol/`](../packages/protocol/)) implements these controls. They are covered by Node unit and loopback integration tests only; no deployment, browser, device, or real-network testing has occurred.

- **Separate room identifier and invite secret.** The loggable 128-bit `roomId` authorizes nothing. Joining requires a separate 256-bit `inviteSecret`. Both, and the 96-bit participant IDs, come from Node's `crypto.randomBytes`; no timestamp, counter, or `Math.random` is involved.
- **Secret handling.** The secret is returned once, to the room's creator, inside a WebSocket message. The service retains only its SHA-256 digest and compares digests with `timingSafeEqual`. It never appears in logs, errors, the health response, notifications to other participants, or URLs; the WebSocket upgrade refuses any query string.
- **Enumeration resistance.** A missing room, an expired room, and a wrong secret produce the same `ROOM_UNAVAILABLE` response by the same comparison path. `ROOM_FULL` is revealed only to a caller with the correct secret. Unauthorized callers receive no room metadata.
- **Room expiry.** Rooms have a finite, validated lifetime (60 s–24 h, default one hour, provisional) and are removed by a periodic sweep; joins are refused at expiry even before the sweep. A room also closes, invalidating its invite, when its host leaves or disconnects.
- **Participant limit.** Rooms hold one host and one guest; a third participant is never admitted. One connection belongs to at most one room. Clients cannot claim a participant ID or role.
- **Strict protocol validation.** Versioned envelope, exact fields at every level, bounded canonical identifiers, no coercion, unknown versions rejected, prototype-pollution keys rejected, typed results constructed only from validated values. Parser errors and exception text are never exposed.
- **Bounds.** 4096-byte WebSocket messages; binary messages refused; per-connection token-bucket rate limit (burst 20, 5 per second); at most 5 invalid messages per connection; strictly increasing per-connection sequences; at most 256 connections; `perMessageDeflate` disabled. These are provisional implementation bounds.
- **Origin policy.** WebSocket upgrades require an `Origin` exactly matching a configured list. Development defaults to the local Vite origins; production requires an explicit `https` list and never accepts `*` or `null`. Origin is a browser policy layer, not authentication.
- **Conservative exposure.** The service binds to `127.0.0.1` by default. `GET /healthz` returns only `{"status":"ok"}`.
- **Sanitized logging.** A closed set of structured events whose fields are numbers or fixed tokens. No secrets, room or participant IDs, payloads, URLs, headers, or IP addresses are logged.
- **Ephemeral state, no media.** Rooms exist only in memory and are lost on restart. The service accepts only small JSON control messages and never receives, stores, or proxies media.

Plain `ws://` is a development-only exception. Production must use HTTPS and WSS through TLS termination in front of the service; no deployment exists yet.

Still future, not implemented: SDP and ICE validation, STUN/TURN credentials, reconnect authentication and session resumption, per-IP or per-room abuse controls beyond the per-connection bounds, idle-connection timeouts and liveness checks, peer data-channel protocol validation, media integrity, transfer and cache resource controls, and every browser-side control for these features.

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
