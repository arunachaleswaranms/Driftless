// Identifier and credential formats shared by every Driftless endpoint.
//
// Each value is fixed-length, unpadded base64url encoding of a fixed number of
// random bytes. The formats differ in length so that one kind of value cannot
// be mistaken for another. Validation accepts only the canonical encoding:
// where the byte count is not a multiple of three, the unused low bits of the
// final character must be zero, so every accepted string decodes to exactly
// one byte sequence and re-encodes to itself.
//
// These checks are pure and use no platform API, so the same rules apply in
// the browser and in Node.

declare const brand: unique symbol;

/** A string that has passed the corresponding format check. */
type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

/**
 * Opaque, non-secret room identifier: 16 random bytes (128 bits), 22
 * characters. Knowing it does not authorize anything.
 */
export type RoomId = Brand<string, 'RoomId'>;

/**
 * Secret invite credential: 32 random bytes (256 bits), 43 characters. It
 * authorizes joining exactly one room and must never be logged or placed in a
 * URL.
 */
export type InviteSecret = Brand<string, 'InviteSecret'>;

/**
 * Opaque, non-secret participant identifier assigned by the signaling
 * service: 12 random bytes (96 bits), 16 characters. It is not a credential;
 * clients never present it to claim an identity.
 */
export type ParticipantId = Brand<string, 'ParticipantId'>;

export const ROOM_ID_BYTES = 16;
export const ROOM_ID_LENGTH = 22;
export const INVITE_SECRET_BYTES = 32;
export const INVITE_SECRET_LENGTH = 43;
export const PARTICIPANT_ID_BYTES = 12;
export const PARTICIPANT_ID_LENGTH = 16;

// 16 bytes: the final character carries 2 data bits and 4 zero bits.
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
// 32 bytes: the final character carries 4 data bits and 2 zero bits.
const INVITE_SECRET_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
// 12 bytes: a whole number of 3-byte groups, so every character is data.
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export function isRoomId(value: unknown): value is RoomId {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

export function isInviteSecret(value: unknown): value is InviteSecret {
  return typeof value === 'string' && INVITE_SECRET_PATTERN.test(value);
}

export function isParticipantId(value: unknown): value is ParticipantId {
  return typeof value === 'string' && PARTICIPANT_ID_PATTERN.test(value);
}
