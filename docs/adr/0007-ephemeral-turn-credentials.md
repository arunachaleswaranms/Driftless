# ADR-0007: Ephemeral TURN Credentials from the Signaling Service

## Title

Issue short-lived, shared-secret TURN credentials to authenticated room members from the signaling service, using the provider-neutral TURN REST mechanism.

## Status

Accepted (Phase 2D). Supersedes nothing; refines how [ADR-0002](0002-webrtc-p2p.md)'s TURN fallback is reached.

## Context

ADR-0002 accepts TURN as the relay fallback when a direct path is impossible, and Phase 2D owns its integration. A TURN server authenticates every allocation, so a browser needs a username and credential. Anything in the browser build is public, so a long-lived TURN password in a `VITE_*` variable would let anyone use the relay. No TURN provider or deployment had been selected, and the project must not take on vendor lock-in without a decision.

The service already authenticates room membership (invite secret at admission, challenge and proof on resume), so it can decide who may receive a credential.

## Decision

- Use the time-limited credential scheme of the TURN REST API draft (draft-uberti-behave-turn-rest-00), which coturn implements as `use-auth-secret`/`static-auth-secret` and other TURN servers and services also implement:

  ```text
  username   = "<expiry, Unix seconds>:<user label>"
  credential = base64(HMAC-SHA1(shared secret, username))
  ```

  The TURN server recomputes the credential from the username and its own copy of the secret and refuses an expired username. The two services share only the secret; no state is exchanged.

- The signaling service holds the shared secret, read from `SIGNALING_TURN_SECRET_FILE` (preferred) or `SIGNALING_TURN_SECRET`, and never logs, sends, or echoes it.
- A browser asks with `RTC_CONFIG_REQUEST` only on a connection that carries an authenticated membership (after `ROOM_CREATED`, `ROOM_JOINED`, or an accepted resume proof). The service answers that connection alone with `RTC_CONFIG { expiresAt, iceServers }`. A connection outside a room or still resuming is refused.
- The user label is `base64url(HMAC-SHA-256(secret, "driftless-turn-user-v1" ‖ 0x00 ‖ participant ID bytes)[0..12])`: one stable pseudonym per room membership, so a TURN server's per-user quota and logs see one name per participant without learning the participant ID.
- A credential lives for `SIGNALING_TURN_CREDENTIAL_TTL_SECONDS` (default 3600 s, 60–86400 s), never beyond its room's expiry, rounded down to whole seconds. The browser keeps it in memory only, uses it for peer connections it creates before expiry (fetching a fresh one within 60 s of expiry), and never shows, logs, exports, or stores it.
- The browser's ICE transport policy stays `all`. `relay` exists only as a build-time qualification setting (`VITE_RTC_ICE_TRANSPORT_POLICY=relay`), with no user-facing switch.
- The recommended self-hosted server is coturn; nothing in the code is coturn-specific.

## Rationale

- The scheme is provider-neutral and supported by the most widely deployed open-source TURN server, so a deployment can self-host or choose a compatible service later without code change.
- Credentials are derived, not stored: the service keeps no credential table, and revocation is secret rotation.
- Issuance reuses the existing membership authentication rather than adding a second credential.
- A 1-hour default matches the default room lifetime. The TURN server checks the expiry on authenticated requests, which can include refreshes of an allocation in use, so a credential much shorter than a relayed session could end that session; a recovery then fetches a fresh credential. Capping at the room's expiry keeps a credential from outliving its room.

## Consequences

- The scheme authenticates "someone the service gave a credential to", not a specific room: the TURN server cannot tell rooms apart, and a credential holder can allocate relays until the credential expires. Per-room scoping is not available from this mechanism; per-user quotas (coturn `user-quota`) apply to the per-participant label.
- Anyone admitted to any room can obtain relay credentials, so TURN bandwidth exposure grows with room creation; deployment-level quotas, bandwidth caps, and monitoring are required. The service bounds requests to eight per connection.
- HMAC-SHA1 is fixed by the scheme; its use here is as a MAC, where SHA-1 collisions are not the relevant weakness.
- Rotating the secret invalidates every outstanding credential at the TURN server; a relayed session then fails at its next authenticated refresh and recovers with a fresh credential. Overlapping old and new secrets during a rotation depends on the TURN server's own features and is not designed here.
- The protocol subset `RTC_CONFIG_REQUEST`/`RTC_CONFIG` becomes normative; see [PROTOCOL.md](../PROTOCOL.md).

## Alternatives Considered

- **Long-lived TURN username and password in the browser build:** public secret; rejected.
- **A commercial provider's credential API:** viable, but no provider was selected; it would add vendor coupling and an outbound dependency. A compatible provider can still be configured if it accepts this scheme.
- **Per-room static users created in the TURN server's database:** needs state synchronization between services; rejected for Phase 2.
- **OAuth third-party authorization for TURN (RFC 7635):** better scoping, but limited browser and server support; not adopted.

## Revisit Conditions

Revisit if real-network qualification shows the credential lifetime ending relayed sessions in practice, if a deployment needs per-room relay scoping or a provider with a different credential API, or if TURN abuse or cost evidence requires stronger issuance controls.
