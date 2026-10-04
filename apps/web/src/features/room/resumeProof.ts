import {
  encodeBase64Url,
  isResumeProof,
  resumeProofInput,
  resumeSecretBytes,
  type ParticipantId,
  type ResumeChallenge,
  type ResumeProof,
  type ResumeSecret,
  type SessionId,
} from '@driftless/protocol';

/** Answers a resume challenge; undefined if the proof cannot be computed. */
export type ProveResume = (
  secret: ResumeSecret,
  sessionId: SessionId,
  participantId: ParticipantId,
  challenge: ResumeChallenge,
) => Promise<ResumeProof | undefined>;

/** The parts of `SubtleCrypto` the proof uses. */
export type SubtleLike = Pick<SubtleCrypto, 'digest' | 'importKey' | 'sign'>;

/**
 * Computes a resume proof with Web Crypto:
 * HMAC-SHA-256(SHA-256(secret bytes), resumeProofInput(...)), as unpadded
 * base64url. The secret never leaves this function except as the key of a
 * non-extractable HMAC key, and the proof is meaningful only for this one
 * challenge. Never throws; any failure yields undefined, with no detail.
 */
export function createResumeProver(subtle: SubtleLike): ProveResume {
  return async (secret, sessionId, participantId, challenge) => {
    const secretBytes = resumeSecretBytes(secret);
    const input = resumeProofInput(sessionId, participantId, challenge);
    if (secretBytes === undefined || input === undefined) return undefined;
    try {
      const keyBytes = await subtle.digest('SHA-256', secretBytes);
      const key = await subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const proof = encodeBase64Url(new Uint8Array(await subtle.sign('HMAC', key, input)));
      return isResumeProof(proof) ? proof : undefined;
    } catch {
      return undefined;
    }
  };
}
