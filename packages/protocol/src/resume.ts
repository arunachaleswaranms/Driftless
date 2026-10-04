// The canonical input of a session resume proof.
//
// A participant proves that it holds its resume secret without sending it:
//
//   resumeKey = SHA-256(resumeSecretBytes)
//   proof     = HMAC-SHA-256(resumeKey, resumeProofInput(sessionId, participantId, challenge))
//
// The service keeps only `resumeKey`. The input is a fixed byte layout of
// decoded values, never a concatenation of strings, so it has exactly one
// encoding and no locale, Unicode, or separator ambiguity:
//
//   offset  length  content
//   0       19      ASCII "driftless-resume-v1" (domain separator)
//   19      1       0x00
//   20      20      session ID bytes
//   40      12      participant ID bytes
//   52      24      challenge bytes
//   total   76
//
// Every field after the domain separator has a fixed length, so no field can
// be shifted into another. This module computes no hash; each endpoint uses
// its own platform cryptography (Web Crypto in the browser, Node's crypto in
// the service) over exactly these bytes.

import { decodeBase64Url } from './encoding.js';
import {
  PARTICIPANT_ID_BYTES,
  RESUME_CHALLENGE_BYTES,
  SESSION_ID_BYTES,
  isParticipantId,
  isResumeChallenge,
  isResumeSecret,
  isSessionId,
  type ParticipantId,
  type ResumeChallenge,
  type ResumeSecret,
  type SessionId,
} from './identifiers.js';

/** Domain separator of protocol version 1 resume proofs. */
export const RESUME_PROOF_DOMAIN = 'driftless-resume-v1';

/** Length of `resumeProofInput`'s result, in bytes. */
export const RESUME_PROOF_INPUT_BYTES =
  RESUME_PROOF_DOMAIN.length + 1 + SESSION_ID_BYTES + PARTICIPANT_ID_BYTES + RESUME_CHALLENGE_BYTES;

/**
 * The exact bytes a resume proof authenticates. Returns undefined if any
 * value is not in its canonical format.
 */
export function resumeProofInput(
  sessionId: SessionId,
  participantId: ParticipantId,
  challenge: ResumeChallenge,
): Uint8Array<ArrayBuffer> | undefined {
  if (!isSessionId(sessionId) || !isParticipantId(participantId) || !isResumeChallenge(challenge)) {
    return undefined;
  }
  const session = decodeBase64Url(sessionId);
  const participant = decodeBase64Url(participantId);
  const nonce = decodeBase64Url(challenge);
  if (session === undefined || participant === undefined || nonce === undefined) return undefined;

  const input = new Uint8Array(RESUME_PROOF_INPUT_BYTES);
  let offset = 0;
  for (let index = 0; index < RESUME_PROOF_DOMAIN.length; index += 1) {
    input[offset] = RESUME_PROOF_DOMAIN.charCodeAt(index);
    offset += 1;
  }
  input[offset] = 0;
  offset += 1;
  for (const field of [session, participant, nonce]) {
    input.set(field, offset);
    offset += field.length;
  }
  return input;
}

/** The raw bytes of a resume secret, or undefined if it is not canonical. */
export function resumeSecretBytes(secret: ResumeSecret): Uint8Array<ArrayBuffer> | undefined {
  if (!isResumeSecret(secret)) return undefined;
  return decodeBase64Url(secret);
}
