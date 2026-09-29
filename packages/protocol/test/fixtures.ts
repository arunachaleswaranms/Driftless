import { Buffer } from 'node:buffer';

/** Canonical base64url of `length` bytes counting up from `start`. */
export function encodedBytes(length: number, start = 0): string {
  return Buffer.from(Array.from({ length }, (_, index) => (start + index) % 256)).toString(
    'base64url',
  );
}

export const ROOM_ID = encodedBytes(16);
export const OTHER_ROOM_ID = encodedBytes(16, 100);
export const INVITE_SECRET = encodedBytes(32);
export const PARTICIPANT_ID = encodedBytes(12);
export const OTHER_PARTICIPANT_ID = encodedBytes(12, 50);

export function envelope(type: string, payload: unknown, overrides: object = {}): string {
  return JSON.stringify({
    protocolVersion: 1,
    type,
    sequence: 0,
    sentAt: 1_760_000_000_000,
    payload,
    ...overrides,
  });
}

/** One valid raw payload for every client message type. */
export const VALID_CLIENT_PAYLOADS = {
  ROOM_CREATE: {},
  ROOM_JOIN: { roomId: ROOM_ID, inviteSecret: INVITE_SECRET },
  ROOM_LEAVE: {},
} as const;

/** One valid raw payload for every server message type. */
export const VALID_SERVER_PAYLOADS = {
  ROOM_CREATED: {
    roomId: ROOM_ID,
    inviteSecret: INVITE_SECRET,
    participantId: PARTICIPANT_ID,
    role: 'host',
    expiresAt: 1_760_000_600_000,
  },
  ROOM_JOINED: {
    roomId: ROOM_ID,
    participantId: OTHER_PARTICIPANT_ID,
    role: 'guest',
    peer: { participantId: PARTICIPANT_ID, role: 'host' },
    expiresAt: 1_760_000_600_000,
  },
  ROOM_LEFT: {},
  ROOM_PARTICIPANT_JOINED: { participant: { participantId: OTHER_PARTICIPANT_ID, role: 'guest' } },
  ROOM_PARTICIPANT_LEFT: { participantId: OTHER_PARTICIPANT_ID, reason: 'LEFT' },
  ROOM_CLOSED: { reason: 'EXPIRED' },
  ERROR: { code: 'ROOM_UNAVAILABLE', message: 'The room is not available.', recoverable: true },
} as const;
