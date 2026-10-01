# @driftless/protocol

The shared, transport-neutral Driftless protocol contract: the versioned message envelope, the signaling room messages (Phase 2A), the WebRTC negotiation messages and the data-channel connection handshake (Phase 2B), identifier formats, size bounds, the error vocabulary, and strict parsing.

It has no runtime dependencies and uses no Node-only or browser-only API, so the same validation runs in the signaling service and in the web client. The protocol is specified in [docs/PROTOCOL.md](../../docs/PROTOCOL.md); this README describes the package.

## Scope

Phases 2A and 2B freeze only what they implement:

- the common envelope, `protocolVersion: 1`;
- client → server: `ROOM_CREATE`, `ROOM_JOIN`, `ROOM_LEAVE`;
- server → client: `ROOM_CREATED`, `ROOM_JOINED`, `ROOM_LEFT`, `ROOM_PARTICIPANT_JOINED`, `ROOM_PARTICIPANT_LEFT`, `ROOM_CLOSED`, `ERROR`;
- both directions, relayed by the service: `RTC_OFFER`, `RTC_ANSWER`, `ICE_CANDIDATE`, `ICE_COMPLETE`;
- peer → peer on the data channel: `PEER_HELLO`, `PEER_READY`, and the control channel label `driftless-control`;
- room ID, invite secret, participant ID, and negotiation ID formats;
- the bounds `MAX_SIGNALING_MESSAGE_BYTES` (32,768), `MAX_SDP_BYTES` (16,384), `MAX_ICE_CANDIDATE_BYTES` (1024), `MAX_SDP_MID_BYTES` (64), `MAX_SDP_MLINE_INDEX` (63), `MAX_USERNAME_FRAGMENT_BYTES` (256), `MAX_ICE_CANDIDATES_PER_NEGOTIATION` (32), and `MAX_PEER_MESSAGE_BYTES` (1024). They are provisional implementation and security bounds, not WebRTC limits;
- the error codes `INVALID_MESSAGE`, `UNSUPPORTED_PROTOCOL`, `INVALID_STATE`, `ROOM_UNAVAILABLE`, `ROOM_FULL`, `RATE_LIMITED`, `SERVER_ERROR`.

Reconnect, Local Sync, playback, synchronization, social, transfer, and binary framing are not part of this package. They remain conceptual in `docs/PROTOCOL.md`.

## API

```ts
import {
  parseClientMessage,
  parsePeerMessage,
  parseServerMessage,
  serializeMessage,
} from '@driftless/protocol';

const result = parseClientMessage(text);
if (result.ok) {
  // result.message is a fully typed ClientMessage built from validated values.
} else {
  // result.code: 'INVALID_MESSAGE' | 'UNSUPPORTED_PROTOCOL'
  // result.reason: a fixed token such as 'invalid_json' or 'unknown_field', safe to log.
}
```

- `parseClientMessage(text)`, `parseServerMessage(text)`, and `parsePeerMessage(text)` never throw. They return a typed success or a failure with a fixed reason token that never contains input.
- `serializeMessage(message)` writes exactly the five envelope fields.
- `isRoomId`, `isInviteSecret`, `isParticipantId`, `isNegotiationId`, `isSessionDescription`, and `isErrorCode` are type guards. `RoomId`, `InviteSecret`, `ParticipantId`, and `NegotiationId` are branded strings, so an unchecked string cannot be used as one.
- `toIceCandidate(value)` validates an untrusted value as the four-field `IceCandidate` and returns a fresh plain object, or undefined.
- `utf8ByteLength(text)` and `fitsUtf8Bytes(text, max)` count UTF-8 bytes exactly as `TextEncoder` and `WebSocket.send()` encode them, with pure arithmetic and no platform API.

## Validation strategy

Validation is hand-written and exhaustive rather than a schema library: the Phase 2A message set is small, and explicit code keeps every rule visible and every failure path tested. It:

- bounds the input in UTF-8 bytes before parsing (`MAX_SIGNALING_MESSAGE_BYTES` for signaling, `MAX_PEER_MESSAGE_BYTES` for peer messages). The count is of encoded bytes, not string length, so multi-byte text cannot exceed the bound, and it matches the signaling service's WebSocket payload limit;
- discards the JSON parser's error message;
- requires a plain object root, checks `protocolVersion` first so a future version is reported as `UNSUPPORTED_PROTOCOL` rather than malformed, and then requires exactly the five envelope fields;
- requires `sequence` and `sentAt` to be non-negative safe integers;
- selects one payload decoder by `type` and requires exactly that payload's fields, with no coercion;
- rejects unknown keys everywhere, including `__proto__` and `constructor`, which `JSON.parse` creates as ordinary own properties;
- constructs the result from validated values only; nothing parsed is merged or spread into it.

Identifier formats are canonical unpadded base64url with fixed lengths: room ID 16 bytes (22 characters), invite secret 32 bytes (43 characters), participant ID 12 bytes (16 characters), negotiation ID 18 bytes (24 characters). Where a length does not fill the last character, its unused bits must be zero, so each accepted string has exactly one byte representation.

## Scripts

Run from this directory, or from the repository root with `-w @driftless/protocol`.

| Script                 | Purpose                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `npm run build`        | Compile `src/` to `dist/` with declarations.                                         |
| `npm run typecheck`    | Type-check the sources and the tests.                                                |
| `npm run lint`         | ESLint with type-aware rules; any warning fails.                                     |
| `npm run format:check` | Prettier check.                                                                      |
| `npm test`             | Vitest unit tests against the sources.                                               |
| `npm run smoke:dist`   | Imports the built package by name through its `exports` map and checks its behavior. |
| `npm run check`        | `typecheck`, `lint`, `format:check`, `test`, `build`, and `smoke:dist` in sequence.  |

`npm test` runs 153 Vitest tests: `parse.test.ts` (envelope, version, fields, sequence, room payloads, untrusted JSON, serialization), `negotiation.test.ts` (negotiation messages in both directions, SDP and candidate bounds at and over each bound, multi-byte SDP, extra fields, malformed IDs, the peer handshake, and no echo of SDP or candidate text), `encoding.test.ts` (UTF-8 counting against `TextEncoder` for every code unit, lone surrogates, and the byte bound with multi-byte text), and `identifiers.test.ts`.

`dist/` is generated and not committed. Consumers import the built output through the `exports` map; the signaling service's TypeScript build references this project, so `tsc -b` there builds it first.
