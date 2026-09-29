# @driftless/protocol

The shared, transport-neutral Driftless protocol contract: the versioned message envelope, the Phase 2A signaling and room messages, identifier formats, the error vocabulary, and strict parsing.

It has no runtime dependencies and uses no Node-only or browser-only API, so the same validation can run in the signaling service and, from Phase 2B, in the web client. The protocol is specified in [docs/PROTOCOL.md](../../docs/PROTOCOL.md); this README describes the package.

## Scope

Phase 2A freezes only what it implements:

- the common envelope, `protocolVersion: 1`;
- client → server: `ROOM_CREATE`, `ROOM_JOIN`, `ROOM_LEAVE`;
- server → client: `ROOM_CREATED`, `ROOM_JOINED`, `ROOM_LEFT`, `ROOM_PARTICIPANT_JOINED`, `ROOM_PARTICIPANT_LEFT`, `ROOM_CLOSED`, `ERROR`;
- room ID, invite secret, and participant ID formats;
- the error codes `INVALID_MESSAGE`, `UNSUPPORTED_PROTOCOL`, `INVALID_STATE`, `ROOM_UNAVAILABLE`, `ROOM_FULL`, `RATE_LIMITED`, `SERVER_ERROR`.

WebRTC negotiation, Local Sync, playback, synchronization, social, transfer, and binary framing are not part of this package yet. They remain conceptual in `docs/PROTOCOL.md`.

## API

```ts
import { parseClientMessage, parseServerMessage, serializeMessage } from '@driftless/protocol';

const result = parseClientMessage(text);
if (result.ok) {
  // result.message is a fully typed ClientMessage built from validated values.
} else {
  // result.code: 'INVALID_MESSAGE' | 'UNSUPPORTED_PROTOCOL'
  // result.reason: a fixed token such as 'invalid_json' or 'unknown_field', safe to log.
}
```

- `parseClientMessage(text)` and `parseServerMessage(text)` never throw. They return a typed success or a failure with a fixed reason token that never contains input.
- `serializeMessage(message)` writes exactly the five envelope fields.
- `isRoomId`, `isInviteSecret`, `isParticipantId`, and `isErrorCode` are type guards. `RoomId`, `InviteSecret`, and `ParticipantId` are branded strings, so an unchecked string cannot be used as one.

## Validation strategy

Validation is hand-written and exhaustive rather than a schema library: the Phase 2A message set is small, and explicit code keeps every rule visible and every failure path tested. It:

- bounds the input (`MAX_SIGNALING_MESSAGE_BYTES`, 4096) before parsing;
- discards the JSON parser's error message;
- requires a plain object root, checks `protocolVersion` first so a future version is reported as `UNSUPPORTED_PROTOCOL` rather than malformed, and then requires exactly the five envelope fields;
- requires `sequence` and `sentAt` to be non-negative safe integers;
- selects one payload decoder by `type` and requires exactly that payload's fields, with no coercion;
- rejects unknown keys everywhere, including `__proto__` and `constructor`, which `JSON.parse` creates as ordinary own properties;
- constructs the result from validated values only; nothing parsed is merged or spread into it.

Identifier formats are canonical unpadded base64url with fixed lengths: room ID 16 bytes (22 characters), invite secret 32 bytes (43 characters), participant ID 12 bytes (16 characters). Where a length does not fill the last character, its unused bits must be zero, so each accepted string has exactly one byte representation.

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

`dist/` is generated and not committed. Consumers import the built output through the `exports` map; the signaling service's TypeScript build references this project, so `tsc -b` there builds it first.
