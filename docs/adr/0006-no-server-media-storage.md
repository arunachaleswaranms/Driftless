# ADR-0006: No Permanent Backend Media Storage

## Title

Exclude permanent server-side media storage from the normal architecture.

## Status

Accepted

## Context

Driftless handles private local media. Uploading it to the application backend would expand privacy, security, compliance, moderation, storage, and bandwidth obligations. Local Sync does not require media transfer, and Progressive Watch is intended to use peer-to-peer delivery wherever possible.

## Decision

The application backend will not permanently store user media as part of normal operation. Signaling will coordinate sessions without carrying routine media. Progressive media will use WebRTC peer paths, with TURN relay when direct connectivity is impossible. Any transient infrastructure behavior must be necessary, bounded, documented, and must not become durable media storage.

## Rationale

- Reduces backend custody of private content.
- Aligns service scope with synchronization and peer coordination.
- Avoids making centralized media storage and delivery a default cost center.
- Preserves Local Sync as a metadata/control-only mode.

## Consequences

- Host availability and uplink affect Progressive Watch.
- TURN can still carry encrypted media traffic and incur bandwidth cost even without storage.
- Browser-local cache requires its own privacy and cleanup controls.
- The service cannot offer cloud media libraries or server-side resume across absent peers.
- Logs, crash reports, and diagnostics must be designed not to capture media bytes.

## Alternatives Considered

- Permanent backend upload and streaming: operationally simpler for delivery but conflicts with privacy and scope.
- Temporary backend media staging: may improve reachability but adds custody and must not become an implicit fallback.
- Third-party cloud-storage integration: transfers trust and complexity without satisfying the baseline use case.
- Direct-only communication with no TURN: avoids relay cost but would fail on common network configurations.

## Revisit Conditions

Revisit only through a new or superseding ADR if peer-to-peer feasibility fails and the project intentionally accepts materially different privacy, legal, operational, and cost obligations. A production hosting decision alone does not justify reversing this decision.

