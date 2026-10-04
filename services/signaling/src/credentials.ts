import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  INVITE_SECRET_BYTES,
  PARTICIPANT_ID_BYTES,
  RESUME_CHALLENGE_BYTES,
  RESUME_PROOF_BYTES,
  RESUME_SECRET_BYTES,
  ROOM_ID_BYTES,
  SESSION_ID_BYTES,
  resumeProofInput,
  resumeSecretBytes,
  type InviteSecret,
  type ParticipantId,
  type ResumeChallenge,
  type ResumeProof,
  type ResumeSecret,
  type RoomId,
  type SessionId,
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

export function generateSessionId(random: RandomSource): SessionId {
  return generate(random, SESSION_ID_BYTES) as SessionId;
}

export function generateResumeSecret(random: RandomSource): ResumeSecret {
  return generate(random, RESUME_SECRET_BYTES) as ResumeSecret;
}

export function generateResumeChallenge(random: RandomSource): ResumeChallenge {
  return generate(random, RESUME_CHALLENGE_BYTES) as ResumeChallenge;
}

/**
 * The resume key: SHA-256 of the decoded resume secret bytes. The service
 * keeps only this key, never the secret. It is the HMAC key of resume proofs,
 * so it is sensitive in its own right and is held in memory only.
 */
export function deriveResumeKey(secret: ResumeSecret): Buffer {
  const bytes = resumeSecretBytes(secret);
  if (bytes === undefined) throw new Error('Not a canonical resume secret.');
  return createHash('sha256').update(bytes).digest();
}

/**
 * Whether `proof` is HMAC-SHA-256(key, resumeProofInput(...)), compared in
 * constant time. A value that is not a canonical proof never matches.
 */
export function resumeProofMatches(
  key: Buffer,
  sessionId: SessionId,
  participantId: ParticipantId,
  challenge: ResumeChallenge,
  proof: ResumeProof,
): boolean {
  const input = resumeProofInput(sessionId, participantId, challenge);
  const presented = Buffer.from(proof, 'base64url');
  // Computed even when the input is unusable, so every path does the same work.
  const expected = createHmac('sha256', key)
    .update(input ?? new Uint8Array(0))
    .digest();
  return (
    input !== undefined &&
    presented.byteLength === RESUME_PROOF_BYTES &&
    timingSafeEqual(presented, expected)
  );
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
