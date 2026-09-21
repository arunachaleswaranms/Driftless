# Conceptual Protocol

## Status

This is a design specification for `protocolVersion: 1`. No protocol implementation exists. The exact JSON and binary wire representations are not frozen, and values that depend on benchmarking - including transport chunk size, buffering thresholds, heartbeat intervals, retry counts, and drift thresholds - remain undecided.

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

## Message Families

### Room and Session

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

The following remain open: JSON schema tooling, binary frame layout, channel count and settings, identifier encodings, fingerprint format, chunk size, acknowledgement strategy, exact error codes, timing intervals, and numeric correction thresholds. These decisions require Phase 0 evidence and later subsystem design.

