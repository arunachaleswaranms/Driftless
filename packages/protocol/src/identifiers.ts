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

/**
 * Opaque, non-secret identifier of one WebRTC negotiation: 18 random bytes
 * (144 bits), 24 characters. The host's browser creates a fresh one from its
 * cryptographically secure generator for every offer; it correlates the
 * offer, answer, and ICE messages of that negotiation, so messages of an
 * earlier negotiation cannot be mistaken for a later one. It is not a
 * credential.
 */
export type NegotiationId = Brand<string, 'NegotiationId'>;

/**
 * Opaque, non-secret identifier of one room incarnation, shared by its two
 * participants: 20 random bytes (160 bits), 27 characters. The service
 * creates it with the room; it never changes while the room exists and is
 * never reused. It is not a credential.
 */
export type SessionId = Brand<string, 'SessionId'>;

/**
 * Secret, participant-specific resume credential: 33 random bytes (264 bits),
 * 44 characters. The service gives each participant its own when it is
 * admitted. It is never sent again: a resuming client proves knowledge of it
 * by answering a challenge. It authorizes nothing else and must never be
 * logged, persisted, shown, or placed in a URL.
 */
export type ResumeSecret = Brand<string, 'ResumeSecret'>;

/**
 * One-time resume challenge chosen by the service for one connection: 24
 * random bytes (192 bits), 32 characters. Not secret.
 */
export type ResumeChallenge = Brand<string, 'ResumeChallenge'>;

/**
 * Answer to a resume challenge: an HMAC-SHA-256 value, 32 bytes, 43
 * characters. See `resumeProofInput`. It is not an identifier; it shares the
 * invite secret's length but is accepted only in `SESSION_RESUME_PROVE`.
 */
export type ResumeProof = Brand<string, 'ResumeProof'>;

export const ROOM_ID_BYTES = 16;
export const ROOM_ID_LENGTH = 22;
export const INVITE_SECRET_BYTES = 32;
export const INVITE_SECRET_LENGTH = 43;
export const PARTICIPANT_ID_BYTES = 12;
export const PARTICIPANT_ID_LENGTH = 16;
// 18 rather than 16 bytes keeps every identifier kind a distinct length; a
// 16-byte value would have the room ID's 22-character form.
export const NEGOTIATION_ID_BYTES = 18;
export const NEGOTIATION_ID_LENGTH = 24;
// 20 bytes give a 27-character form that no other identifier uses.
export const SESSION_ID_BYTES = 20;
export const SESSION_ID_LENGTH = 27;
// 33 rather than 32 bytes keeps the resume secret a different length from the
// invite secret, so one cannot be mistaken for the other.
export const RESUME_SECRET_BYTES = 33;
export const RESUME_SECRET_LENGTH = 44;
export const RESUME_CHALLENGE_BYTES = 24;
export const RESUME_CHALLENGE_LENGTH = 32;
/** HMAC-SHA-256 output. */
export const RESUME_PROOF_BYTES = 32;
export const RESUME_PROOF_LENGTH = 43;

// 16 bytes: the final character carries 2 data bits and 4 zero bits.
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
// 32 bytes: the final character carries 4 data bits and 2 zero bits.
const INVITE_SECRET_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
// 12 bytes: a whole number of 3-byte groups, so every character is data.
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
// 18 bytes: a whole number of 3-byte groups, so every character is data.
const NEGOTIATION_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
// 20 bytes: the final character carries 4 data bits and 2 zero bits.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{26}[AEIMQUYcgkosw048]$/;
// 33 bytes: a whole number of 3-byte groups, so every character is data.
const RESUME_SECRET_PATTERN = /^[A-Za-z0-9_-]{44}$/;
// 24 bytes: a whole number of 3-byte groups, so every character is data.
const RESUME_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
// 32 bytes: the final character carries 4 data bits and 2 zero bits.
const RESUME_PROOF_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function isRoomId(value: unknown): value is RoomId {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

export function isInviteSecret(value: unknown): value is InviteSecret {
  return typeof value === 'string' && INVITE_SECRET_PATTERN.test(value);
}

export function isParticipantId(value: unknown): value is ParticipantId {
  return typeof value === 'string' && PARTICIPANT_ID_PATTERN.test(value);
}

export function isNegotiationId(value: unknown): value is NegotiationId {
  return typeof value === 'string' && NEGOTIATION_ID_PATTERN.test(value);
}

export function isSessionId(value: unknown): value is SessionId {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

export function isResumeSecret(value: unknown): value is ResumeSecret {
  return typeof value === 'string' && RESUME_SECRET_PATTERN.test(value);
}

export function isResumeChallenge(value: unknown): value is ResumeChallenge {
  return typeof value === 'string' && RESUME_CHALLENGE_PATTERN.test(value);
}

export function isResumeProof(value: unknown): value is ResumeProof {
  return typeof value === 'string' && RESUME_PROOF_PATTERN.test(value);
}

/** One locally generated media selection: 128 random bits, not a credential. */
export type MediaSelectionId = Brand<string, 'MediaSelectionId'>;
/** Session-scoped SHA-256 identity evidence; never a stable content identifier. */
export type MediaFingerprint = Brand<string, 'MediaFingerprint'>;
export const MEDIA_SELECTION_ID_BYTES = 16;
export const MEDIA_SELECTION_ID_LENGTH = 22;
export const MEDIA_FINGERPRINT_BYTES = 32;
export const MEDIA_FINGERPRINT_LENGTH = 43;
export function isMediaSelectionId(value: unknown): value is MediaSelectionId {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}
export function isMediaFingerprint(value: unknown): value is MediaFingerprint {
  return typeof value === 'string' && INVITE_SECRET_PATTERN.test(value);
}
