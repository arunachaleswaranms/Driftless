import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INVITE_SECRET_BYTES,
  INVITE_SECRET_LENGTH,
  NEGOTIATION_ID_BYTES,
  NEGOTIATION_ID_LENGTH,
  PARTICIPANT_ID_BYTES,
  PARTICIPANT_ID_LENGTH,
  ROOM_ID_BYTES,
  ROOM_ID_LENGTH,
  isInviteSecret,
  isNegotiationId,
  isParticipantId,
  isRoomId,
} from '../src/index.js';
import { INVITE_SECRET, NEGOTIATION_ID, PARTICIPANT_ID, ROOM_ID } from './fixtures.js';

const formats = [
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
