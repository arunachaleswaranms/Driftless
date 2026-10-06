// Imports the built package through its own package name, so Node resolves it
// through the "exports" map to dist/, exactly as a consumer would. Fails if the
// build is missing, incomplete, or behaves differently from the sources.
import assert from 'node:assert/strict';
import * as protocol from '@driftless/protocol';

const EXPECTED_EXPORTS = [
  'READINESS_ID_BYTES',
  'READINESS_ID_LENGTH',
  'isReadinessId',
  'MEDIA_SELECTION_ID_BYTES',
  'MEDIA_SELECTION_ID_LENGTH',
  'MEDIA_FINGERPRINT_BYTES',
  'MEDIA_FINGERPRINT_LENGTH',
  'MEDIA_FINGERPRINT_VERSION',
  'MEDIA_FINGERPRINT_CHUNK_BYTES',
  'MAX_MEDIA_FINGERPRINT_CHUNKS',
  'MAX_MEDIA_FINGERPRINT_BYTES',
  'NOT_READY_REASONS',
  'isMediaSelectionId',
  'isMediaFingerprint',
  'CLIENT_MESSAGE_TYPES',
  'ERROR_CODES',
  'INVITE_SECRET_BYTES',
  'INVITE_SECRET_LENGTH',
  'MAX_ERROR_MESSAGE_LENGTH',
  'MAX_ICE_CANDIDATES_PER_NEGOTIATION',
  'MAX_ICE_CANDIDATE_BYTES',
  'MAX_NEGOTIATIONS_PER_MEMBERSHIP',
  'MAX_PEER_MESSAGE_BYTES',
  'MAX_SDP_BYTES',
  'MAX_SDP_MID_BYTES',
  'MAX_SDP_MLINE_INDEX',
  'MAX_SIGNALING_MESSAGE_BYTES',
  'MAX_USERNAME_FRAGMENT_BYTES',
  'NEGOTIATION_ID_BYTES',
  'NEGOTIATION_ID_LENGTH',
  'NEGOTIATION_MESSAGE_TYPES',
  'PARTICIPANT_ID_BYTES',
  'PARTICIPANT_ID_LENGTH',
  'PARTICIPANT_LEFT_REASONS',
  'PARTICIPANT_SIGNALING_STATES',
  'PEER_CONTROL_CHANNEL_LABEL',
  'PEER_MESSAGE_TYPES',
  'PROTOCOL_VERSION',
  'RESUME_CHALLENGE_BYTES',
  'RESUME_CHALLENGE_LENGTH',
  'RESUME_PROOF_BYTES',
  'RESUME_PROOF_DOMAIN',
  'RESUME_PROOF_INPUT_BYTES',
  'RESUME_PROOF_LENGTH',
  'RESUME_SECRET_BYTES',
  'RESUME_SECRET_LENGTH',
  'ROOM_CLOSED_REASONS',
  'ROOM_ID_BYTES',
  'ROOM_ID_LENGTH',
  'SERVER_MESSAGE_TYPES',
  'SESSION_ID_BYTES',
  'SESSION_ID_LENGTH',
  'decodeBase64Url',
  'encodeBase64Url',
  'fitsUtf8Bytes',
  'isErrorCode',
  'isInviteSecret',
  'isNegotiationId',
  'isParticipantId',
  'isResumeChallenge',
  'isResumeProof',
  'isResumeSecret',
  'isRoomId',
  'isSessionId',
  'isSessionDescription',
  'parseClientMessage',
  'parsePeerMessage',
  'parseServerMessage',
  'resumeProofInput',
  'resumeSecretBytes',
  'serializeMessage',
  'toIceCandidate',
  'toRtcIceServer',
  'iceServerUrlKind',
  'MAX_ICE_SERVER_CREDENTIAL_BYTES',
  'MAX_ICE_SERVER_URL_BYTES',
  'MAX_ICE_SERVER_USERNAME_BYTES',
  'MAX_RTC_CONFIG_TTL_MS',
  'MAX_RTC_ICE_SERVERS',
  'MAX_RTC_ICE_SERVER_URLS',
  'utf8ByteLength',
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

// The size bound counts UTF-8 bytes, not string length.
const multiByte = '€'.repeat(Math.floor(protocol.MAX_SIGNALING_MESSAGE_BYTES / 3) + 1);
assert.ok(multiByte.length < protocol.MAX_SIGNALING_MESSAGE_BYTES);
assert.equal(protocol.parseServerMessage(multiByte).reason, 'too_large');
assert.equal(protocol.utf8ByteLength('€😀'), 7);

const offer = JSON.stringify({
  protocolVersion: 1,
  type: 'RTC_OFFER',
  sequence: 2,
  sentAt: 0,
  payload: { negotiationId: 'A'.repeat(24), sdp: 'v=0\r\n' },
});
assert.equal(protocol.parseClientMessage(offer).ok, true);
assert.equal(protocol.parseServerMessage(offer).ok, true);

// The resume proof input has its documented fixed layout.
const input = protocol.resumeProofInput('A'.repeat(27), 'B'.repeat(16), 'C'.repeat(32));
assert.equal(input?.byteLength, 76);
assert.equal(new TextDecoder().decode(input.subarray(0, 19)), 'driftless-resume-v1');
assert.equal(protocol.resumeProofInput('short', 'B'.repeat(16), 'C'.repeat(32)), undefined);

console.log('@driftless/protocol dist smoke test passed');

for (const type of ['PLAY', 'PAUSE', 'SEEK']) {
  const text = JSON.stringify({
    protocolVersion: 1,
    type,
    sequence: 1,
    sentAt: 0,
    payload: {
      sessionId: 'A'.repeat(27),
      negotiationId: 'A'.repeat(24),
      senderId: 'A'.repeat(16),
      recipientId: 'B'.repeat(16),
      localSelectionId: 'A'.repeat(22),
      remoteSelectionId: 'B'.repeat(21) + 'A',
      localReadinessId: 'C'.repeat(21) + 'A',
      remoteReadinessId: 'D'.repeat(21) + 'A',
      revision: Number.MAX_SAFE_INTEGER,
      positionMs: Number.MAX_SAFE_INTEGER,
    },
  });
  assert.equal(protocol.parsePeerMessage(text).ok, true);
  assert.equal(protocol.parseClientMessage(text).ok, false);
  assert.equal(protocol.parseServerMessage(text).ok, false);
  assert.ok(protocol.utf8ByteLength(text) < protocol.MAX_PEER_MESSAGE_BYTES);
}
