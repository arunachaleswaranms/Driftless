// Imports the built package through its own package name, so Node resolves it
// through the "exports" map to dist/, exactly as a consumer would. Fails if the
// build is missing, incomplete, or behaves differently from the sources.
import assert from 'node:assert/strict';
import * as protocol from '@driftless/protocol';

const EXPECTED_EXPORTS = [
  'CLIENT_MESSAGE_TYPES',
  'ERROR_CODES',
  'INVITE_SECRET_BYTES',
  'INVITE_SECRET_LENGTH',
  'MAX_ERROR_MESSAGE_LENGTH',
  'MAX_SIGNALING_MESSAGE_BYTES',
  'PARTICIPANT_ID_BYTES',
  'PARTICIPANT_ID_LENGTH',
  'PARTICIPANT_LEFT_REASONS',
  'PROTOCOL_VERSION',
  'ROOM_CLOSED_REASONS',
  'ROOM_ID_BYTES',
  'ROOM_ID_LENGTH',
  'SERVER_MESSAGE_TYPES',
  'isErrorCode',
  'isInviteSecret',
  'isParticipantId',
  'isRoomId',
  'parseClientMessage',
  'parseServerMessage',
  'serializeMessage',
];

assert.deepEqual(Object.keys(protocol).sort(), [...EXPECTED_EXPORTS].sort());
assert.equal(protocol.PROTOCOL_VERSION, 1);

const join = JSON.stringify({
  protocolVersion: 1,
  type: 'ROOM_JOIN',
  sequence: 1,
  sentAt: 0,
  payload: { roomId: 'A'.repeat(21) + 'Q', inviteSecret: 'A'.repeat(42) + 'E' },
});
const parsed = protocol.parseClientMessage(join);
assert.equal(parsed.ok, true);
assert.equal(protocol.serializeMessage(parsed.message), join);

assert.deepEqual(protocol.parseClientMessage('{'), {
  ok: false,
  code: 'INVALID_MESSAGE',
  reason: 'invalid_json',
});
assert.deepEqual(
  protocol.parseClientMessage(join.replace('"protocolVersion":1', '"protocolVersion":2')),
  { ok: false, code: 'UNSUPPORTED_PROTOCOL', reason: 'unsupported_version' },
);

console.log('@driftless/protocol dist smoke test passed');
