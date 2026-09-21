# ADR-0003: Host-Authoritative Synchronization

## Title

Use host-authoritative playback synchronization for initial versions.

## Status

Accepted

## Context

Synchronized playback requires a clear answer when participants issue actions concurrently, messages arrive late or out of order, clocks differ, or a participant reconnects. Fully symmetric consensus would add complexity before two-person reliability is established.

## Decision

The host is the authoritative source for play, pause, seek, and shared playback state in initial versions. Guests report readiness, observations, buffer status, and drift but do not independently redefine authoritative playback state. Authoritative changes use ordering or state revisions so stale messages cannot override newer decisions.

Transfer scheduling and buffer reports do not grant playback authority.

## Rationale

- A single authority makes conflict resolution deterministic.
- It simplifies two-person state machines, reconnect reconciliation, and diagnostics.
- It permits measured drift correction without distributed consensus.
- It keeps playback decisions separate from media availability and transfer progress.

## Consequences

- Guest playback controls must request or defer to host authority according to later UX design.
- Host loss requires an explicit pause, termination, or migration policy.
- Host clocks and messages are inputs to validate, not a trust exemption.
- Sequence handling, idempotence, and stale-state rejection are mandatory.
- Host migration and collaborative control are deferred.

## Alternatives Considered

- Fully symmetric multi-writer controls: friendlier in some interactions but introduces races and conflict policy.
- Server-authoritative playback: centralizes state and availability while increasing backend dependence.
- Clock-only synchronization with no authority: cannot resolve concurrent actions or reconnect state reliably.

## Revisit Conditions

Revisit after two-person Local Sync is stable, if user research requires collaborative controls, when host migration is designed, or before three-person rooms introduce more complex authority needs.

