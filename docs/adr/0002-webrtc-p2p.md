# ADR-0002: WebRTC Peer-to-Peer-First Communication

## Title

Use WebRTC as the peer-to-peer-first communication layer.

## Status

Accepted

## Context

Driftless needs low-latency state exchange and, for Progressive Watch, potentially large binary media transfer between browsers. Users should not have to upload media to an application server. Direct browser connectivity is not always possible because of NAT, firewall, enterprise, and carrier behavior.

## Decision

Use WebRTC for peer communication and RTCDataChannel for application data. Use a small signaling service to coordinate rooms and exchange negotiation data, STUN to assist direct connectivity, and TURN as a fallback when direct peer-to-peer connection is unavailable. Prefer direct paths, but design and test relayed paths explicitly.

The signaling service must not become the routine playback-control or media path.

## Rationale

- WebRTC provides browser-native encrypted transport and connectivity establishment.
- RTCDataChannel can carry small control messages and binary data under application-defined protocols.
- Direct transfer supports the project's privacy and backend-custody goals.
- TURN provides a necessary compatibility fallback rather than pretending universal direct connectivity.

## Consequences

- A signaling service and STUN/TURN infrastructure are required.
- TURN may relay media and create significant bandwidth and cost.
- Connectivity and performance vary by network, browser, and device.
- Backpressure, message bounds, recovery, and direct-versus-relay diagnostics are required.
- WebRTC encryption does not make a remote peer trusted.

## Alternatives Considered

- Upload media to a backend and stream it: simpler central control but conflicts with privacy, storage, and cost goals.
- WebSocket relay for all application traffic: centralizes bandwidth and makes the backend a media path.
- WebTransport or other transports: potentially useful later, but not the accepted browser peer-to-peer baseline.
- Manual clock coordination without a data connection: insufficient for reliable synchronization and recovery.

## Revisit Conditions

Revisit if real-network evidence shows unacceptable WebRTC connectivity, data-channel performance, TURN dependence, operating cost, or browser support, or if a better widely available peer-to-peer browser transport emerges.

