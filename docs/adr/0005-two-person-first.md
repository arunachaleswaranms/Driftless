# ADR-0005: Two-Person-First Rooms

## Title

Optimize and stabilize two-person rooms before implementing three-person rooms.

## Status

Accepted

## Context

Each added participant increases synchronization interactions, peer-connection topology, sender uplink, TURN exposure, failure combinations, readiness states, and authority questions. The primary use case is two people in different locations, while the long-term maximum is three.

## Decision

Design, test, and stabilize the product for two participants first. Do not implement three-person rooms until the two-person exit gates pass. When Phase 8 begins, select and document a topology from measured evidence and enforce a hard maximum of three active participants.

## Rationale

- Two-person rooms address the primary use case with the smallest failure surface.
- Reliability and security behavior can be established before topology complexity grows.
- Real measurements will inform whether the host can fan out media or TURN capacity changes the design.
- A hard participant boundary supports resource and abuse controls.

## Consequences

- Initial protocols and interfaces should avoid needless assumptions that make a third participant impossible, but must not implement speculative multiparty behavior.
- Marketing and UI must not imply group-room support.
- Three-person chat, readiness, authority, reconnect, and transfer semantics are deferred.
- The two-person path must remain a first-class optimized mode after expansion.

## Alternatives Considered

- Build three-person support from the start: broadens state and network complexity before core feasibility is known.
- Support arbitrary room sizes: incompatible with resource, topology, privacy, and product constraints.
- Permanently restrict rooms to two: unnecessarily forecloses the stated long-term maximum.

## Revisit Conditions

Revisit only after two-person reliability gates pass and Phase 8 begins, or earlier if foundational protocol choices would make a third participant impossible without a deliberate tradeoff.

