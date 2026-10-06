import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INVITE_SECRET_BYTES,
  INVITE_SECRET_LENGTH,
  NEGOTIATION_ID_BYTES,
  NEGOTIATION_ID_LENGTH,
  PARTICIPANT_ID_BYTES,
  PARTICIPANT_ID_LENGTH,
  RESUME_CHALLENGE_BYTES,
  RESUME_CHALLENGE_LENGTH,
  RESUME_PROOF_BYTES,
  RESUME_PROOF_LENGTH,
  RESUME_SECRET_BYTES,
  RESUME_SECRET_LENGTH,
  READINESS_ID_BYTES,
  READINESS_ID_LENGTH,
  isReadinessId,
  ROOM_ID_BYTES,
  ROOM_ID_LENGTH,
  SESSION_ID_BYTES,
  SESSION_ID_LENGTH,
  isInviteSecret,
  isNegotiationId,
  isParticipantId,
  isResumeChallenge,
  isResumeProof,
  isResumeSecret,
  isRoomId,
  isSessionId,
} from '../src/index.js';
import {
  INVITE_SECRET,
  NEGOTIATION_ID,
  PARTICIPANT_ID,
  RESUME_CHALLENGE,
  RESUME_PROOF,
  RESUME_SECRET,
  ROOM_ID,
  SESSION_ID,
} from './fixtures.js';

const formats = [
  {
    name: 'readiness ID',
    check: isReadinessId,
    bytes: READINESS_ID_BYTES,
    length: READINESS_ID_LENGTH,
  },
  { name: 'room ID', check: isRoomId, bytes: ROOM_ID_BYTES, length: ROOM_ID_LENGTH },
  {
    name: 'invite secret',
    check: isInviteSecret,
    bytes: INVITE_SECRET_BYTES,
    length: INVITE_SECRET_LENGTH,
  },
  {
    name: 'participant ID',
    check: isParticipantId,
    bytes: PARTICIPANT_ID_BYTES,
    length: PARTICIPANT_ID_LENGTH,
  },
  {
    name: 'negotiation ID',
    check: isNegotiationId,
    bytes: NEGOTIATION_ID_BYTES,
    length: NEGOTIATION_ID_LENGTH,
  },
  { name: 'session ID', check: isSessionId, bytes: SESSION_ID_BYTES, length: SESSION_ID_LENGTH },
  {
    name: 'resume secret',
    check: isResumeSecret,
    bytes: RESUME_SECRET_BYTES,
    length: RESUME_SECRET_LENGTH,
  },
  {
    name: 'resume challenge',
    check: isResumeChallenge,
    bytes: RESUME_CHALLENGE_BYTES,
    length: RESUME_CHALLENGE_LENGTH,
  },
  {
    name: 'resume proof',
    check: isResumeProof,
    bytes: RESUME_PROOF_BYTES,
    length: RESUME_PROOF_LENGTH,
  },
] as const;

describe('identifier formats', () => {
  it('uses at least 256 bits for the invite secret and distinct lengths per kind', () => {
    expect(INVITE_SECRET_BYTES * 8).toBeGreaterThanOrEqual(256);
    expect(NEGOTIATION_ID_BYTES * 8).toBeGreaterThanOrEqual(128);
    expect(
      new Set([ROOM_ID_LENGTH, INVITE_SECRET_LENGTH, PARTICIPANT_ID_LENGTH, NEGOTIATION_ID_LENGTH])
        .size,
    ).toBe(4);
  });

  it('gives the resume credential at least 256 bits and every identifier its own length', () => {
    expect(RESUME_SECRET_BYTES * 8).toBeGreaterThanOrEqual(256);
    expect(RESUME_CHALLENGE_BYTES * 8).toBeGreaterThanOrEqual(192);
    expect(SESSION_ID_BYTES * 8).toBeGreaterThanOrEqual(128);
    const identifierLengths = [
      ROOM_ID_LENGTH,
      INVITE_SECRET_LENGTH,
      PARTICIPANT_ID_LENGTH,
      NEGOTIATION_ID_LENGTH,
      SESSION_ID_LENGTH,
      RESUME_SECRET_LENGTH,
      RESUME_CHALLENGE_LENGTH,
    ];
    expect(new Set(identifierLengths).size).toBe(identifierLengths.length);
    // The proof is an HMAC output, not an identifier: it shares only the
    // invite secret's length and is accepted in one field only.
    expect(RESUME_PROOF_LENGTH).toBe(INVITE_SECRET_LENGTH);
  });

  it('keeps session and resume values apart from every other kind', () => {
    const values = [
      ROOM_ID,
      INVITE_SECRET,
      PARTICIPANT_ID,
      NEGOTIATION_ID,
      SESSION_ID,
      RESUME_SECRET,
      RESUME_CHALLENGE,
    ];
    const checks = [
      isRoomId,
      isInviteSecret,
      isParticipantId,
      isNegotiationId,
      isSessionId,
      isResumeSecret,
      isResumeChallenge,
    ];
    values.forEach((value, index) => {
      checks.forEach((check, other) => {
        expect(check(value)).toBe(index === other);
      });
    });
    expect(isResumeProof(RESUME_PROOF)).toBe(true);
    expect(isResumeProof(RESUME_SECRET)).toBe(false);
    expect(isSessionId(`${SESSION_ID.slice(0, -1)}B`)).toBe(false);
    expect(isResumeProof(`${RESUME_PROOF.slice(0, -1)}B`)).toBe(false);
  });

  it.each(formats)('accepts canonical random $name values', ({ check, bytes, length }) => {
    for (let index = 0; index < 500; index += 1) {
      const value = randomBytes(bytes).toString('base64url');
      expect(value).toHaveLength(length);
      expect(check(value)).toBe(true);
    }
  });

  it.each(formats)('rejects malformed $name values', ({ check, length }) => {
    const valid = 'A'.repeat(length);
    const rejected: unknown[] = [
      undefined,
      null,
      0,
      12345,
      true,
      {},
      [],
      '',
      valid.slice(1),
      `${valid}A`,
      `${valid.slice(1)}=`,
      `${valid.slice(1)}+`,
      `${valid.slice(1)}/`,
      `${valid.slice(1)} `,
      ` ${valid.slice(1)}`,
      `${valid.slice(1)}\n`,
      `${valid.slice(1)}é`,
      'A'.repeat(10_000),
    ];
    for (const value of rejected) expect(check(value)).toBe(false);
  });

  it('rejects non-canonical final characters', () => {
    // 16 and 32 bytes do not fill the last character; its unused bits must be zero.
    expect(isRoomId(`${ROOM_ID.slice(0, -1)}B`)).toBe(false);
    expect(isReadinessId('A'.repeat(21) + 'B')).toBe(false);
    expect(READINESS_ID_BYTES).toBe(16);
    expect(READINESS_ID_LENGTH).toBe(22);
    expect(isInviteSecret(`${INVITE_SECRET.slice(0, -1)}B`)).toBe(false);
    expect(isRoomId(`${ROOM_ID.slice(0, -1)}Q`)).toBe(true);
    expect(isInviteSecret(`${INVITE_SECRET.slice(0, -1)}E`)).toBe(true);
  });

  it('does not accept one kind of value as another', () => {
    expect(isRoomId(INVITE_SECRET)).toBe(false);
    expect(isRoomId(PARTICIPANT_ID)).toBe(false);
    expect(isInviteSecret(ROOM_ID)).toBe(false);
    expect(isInviteSecret(PARTICIPANT_ID)).toBe(false);
    expect(isParticipantId(ROOM_ID)).toBe(false);
    expect(isParticipantId(INVITE_SECRET)).toBe(false);
    for (const other of [ROOM_ID, INVITE_SECRET, PARTICIPANT_ID]) {
      expect(isNegotiationId(other)).toBe(false);
    }
    expect(isRoomId(NEGOTIATION_ID)).toBe(false);
    expect(isInviteSecret(NEGOTIATION_ID)).toBe(false);
    expect(isParticipantId(NEGOTIATION_ID)).toBe(false);
  });
});
