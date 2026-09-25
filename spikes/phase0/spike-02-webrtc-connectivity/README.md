# Spike 0.2 WebRTC Peer Connectivity Experiment

This dependency-free page tests a single `RTCPeerConnection` between two browser peers and one tiny text-only `RTCDataChannel`. It does not send media or binary data, measure throughput, chunk data, synchronize playback, provide production signaling, or implement Progressive Watch.

## Scope and Signaling

For controlled desktop testing, SDP and ICE candidates are exchanged through a same-origin `BroadcastChannel`. This is isolated development signaling: it has no server, authentication, persistence, database, room service, analytics, telemetry, or production credentials. It works only between same-origin browser contexts on one browser profile and therefore cannot prove separate-network connectivity.

The peer configuration uses `stun:stun.l.google.com:19302` only as a public, non-production feasibility STUN server. No production STUN or TURN selection is made. If controlled testing indicates that TURN is necessary to make even the experiment work, stop for architecture review before adopting a provider or service.

## Run

From the repository root:

```sh
python3 -m http.server 4174 --directory spikes/phase0/spike-02-webrtc-connectivity
```

Open two tabs in the browser under test:

- `http://127.0.0.1:4174/?role=responder&room=wc-local`
- `http://127.0.0.1:4174/?role=initiator&room=wc-local`

Click **Start peer** in both tabs. Either start order is supported by the bounded development-signaling handshake. The initiator creates the `control` data channel and automatically sends `PING` when it opens; the responder sends `PONG`. Use **Refresh diagnostics** to request the latest `getStats()` result and **Close peer** in each tab to exercise cleanup.

## Automated Checks

No package installation is required:

```sh
node --test src/diagnostics.test.mjs
node --check src/app.mjs
node --check src/diagnostics.mjs
```

The Node tests verify candidate parsing, selected-pair lookup, path classification, and diagnostic formatting. Browser automation evidence remains `AUTOMATED DESKTOP`; it is not physical-device or real different-network evidence.

## Test Cases

| ID | Procedure | Expected |
| --- | --- | --- |
| WC-01 | Start responder and initiator peers. | Both `RTCPeerConnection` objects initialize. |
| WC-02 | Allow development signaling to exchange offer and answer. | Both peers show local and remote descriptions set and signaling becomes stable. |
| WC-03 | Observe ICE gathering. | Gathering completes or reaches a usable connected state; candidate types are recorded. |
| WC-04 | Observe connection state. | Both peers reach `connected`. |
| WC-05 | Observe the `control` data channel. | Both peers report `open`. |
| WC-06 | Use the automatic exchange or click **Send PING**. | Initiator sends `PING`; responder receives it and returns `PONG`. |
| WC-07 | Click **Close peer** in both tabs. | Peer connection, data channel, signaling channel, and timers close cleanly. |
| WC-08 | Click **Refresh diagnostics** while connected. | Selected candidate-pair details are recorded where the browser exposes them. Missing fields remain explicitly unavailable. |
| WC-09 | Repeat with peers on genuinely separate Internet networks. | `DEFERRED PHYSICAL / EXTERNAL-NETWORK VALIDATION` until actual evidence exists. |

## Evidence Classification

- Browser automation on desktop: `AUTOMATED DESKTOP`.
- User-operated desktop run: `DESKTOP MANUAL PASS` when all observed outcomes are recorded.
- Android emulator exploration: `EMULATOR`; never physical-device evidence.
- Physical Android run: `PHYSICAL DEVICE PASS` only with device and network details.
- Unperformed real-device/network work: `DEFERRED PHYSICAL` or `DEFERRED-PHYSICAL / EXTERNAL-NETWORK VALIDATION`.

## Security and Privacy Notes

- No media files or media bytes are accepted or sent.
- The only application data messages are short text `PING` and `PONG` values.
- Development signaling contains only the SDP and ICE candidates required to establish the experiment connection, is same-origin and in-memory, and is not persisted.
- WebRTC negotiation and selected-path diagnostics can expose network-related information to the other peer. This experiment displays candidate types but does not log candidate addresses or raw SDP.
- Room labels are bounded local coordination labels, not authentication secrets.
- Closing the experiment releases its peer connection, data channel, signaling channel, and owned timers.
