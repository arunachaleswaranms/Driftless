import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  INVITE_SECRET_BYTES,
  PARTICIPANT_ID_BYTES,
  ROOM_ID_BYTES,
  type InviteSecret,
  type ParticipantId,
  type RoomId,
} from '@driftless/protocol';

/** Returns `size` random bytes. */
export type RandomSource = (size: number) => Uint8Array;

/**
 * The production source: Node's cryptographically secure generator. Tests may
 * inject a deterministic source; production code never replaces this one.
 */
export const cryptoRandom: RandomSource = (size) => randomBytes(size);

function generate(random: RandomSource, size: number): string {
  const bytes = random(size);
  if (bytes.byteLength !== size) throw new Error('Random source returned the wrong length.');
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

export function generateRoomId(random: RandomSource): RoomId {
  return generate(random, ROOM_ID_BYTES) as RoomId;
}

export function generateInviteSecret(random: RandomSource): InviteSecret {
  return generate(random, INVITE_SECRET_BYTES) as InviteSecret;
}

export function generateParticipantId(random: RandomSource): ParticipantId {
  return generate(random, PARTICIPANT_ID_BYTES) as ParticipantId;
}

/**
 * SHA-256 of the decoded secret bytes. Rooms retain only this digest, never
 * the secret itself. The input must already have passed `isInviteSecret`, so
 * it is canonical base64url of exactly 32 bytes.
 */
export function digestInviteSecret(secret: InviteSecret): Buffer {
  return createHash('sha256').update(Buffer.from(secret, 'base64url')).digest();
}

/** Constant-time comparison of two digests of equal, fixed length. */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
