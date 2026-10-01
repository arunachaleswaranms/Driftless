import { randomBytes } from 'node:crypto';
import {
  isInviteSecret,
  isParticipantId,
  isResumeChallenge,
  isResumeSecret,
  isRoomId,
  isSessionId,
  type ParticipantId,
  type ResumeChallenge,
  type ResumeProof,
  type ResumeSecret,
  type SessionId,
} from '@driftless/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  cryptoRandom,
  deriveResumeKey,
  digestInviteSecret,
  digestsEqual,
  generateInviteSecret,
  generateParticipantId,
  generateResumeChallenge,
  generateResumeSecret,
  generateRoomId,
  generateSessionId,
  resumeProofMatches,
} from '../src/credentials.js';
import { flipped } from './support.js';

describe('credential generation', () => {
  it('produces canonical identifiers from the crypto source', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(isRoomId(generateRoomId(cryptoRandom))).toBe(true);
      expect(isInviteSecret(generateInviteSecret(cryptoRandom))).toBe(true);
      expect(isParticipantId(generateParticipantId(cryptoRandom))).toBe(true);
    }
  });

  it('requests exactly 16, 32, and 12 bytes', () => {
    const random = vi.fn((size: number) => randomBytes(size));
    generateRoomId(random);
    generateInviteSecret(random);
    generateParticipantId(random);
    expect(random.mock.calls).toStrictEqual([[16], [32], [12]]);
  });

  it('never uses Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    generateRoomId(cryptoRandom);
    generateInviteSecret(cryptoRandom);
    generateParticipantId(cryptoRandom);
    expect(spy).not.toHaveBeenCalled();
  });

  it('encodes a view of a larger buffer correctly', () => {
    const backing = new Uint8Array(64).fill(0xff);
    const view = backing.subarray(8, 24).fill(0);
    expect(generateRoomId(() => view)).toBe('AAAAAAAAAAAAAAAAAAAAAA');
  });
});

describe('invite secret digests', () => {
  it('matches only the same secret', () => {
    const secret = generateInviteSecret(cryptoRandom);
    const other = generateInviteSecret(cryptoRandom);
    expect(digestsEqual(digestInviteSecret(secret), digestInviteSecret(secret))).toBe(true);
    expect(digestsEqual(digestInviteSecret(secret), digestInviteSecret(other))).toBe(false);
    expect(digestInviteSecret(secret).byteLength).toBe(32);
  });

  it('returns false instead of throwing for unequal lengths', () => {
    expect(digestsEqual(Buffer.alloc(32), Buffer.alloc(31))).toBe(false);
  });
});

describe('resume credentials', () => {
  // The fixed vector of packages/protocol/test/resume.test.ts, computed
  // independently with Python's hashlib and hmac.
  const secret = 'gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp-g' as ResumeSecret;
  const sessionId = 'EBESExQVFhcYGRobHB0eHyAhIiM' as SessionId;
  const participantId = 'MDEyMzQ1Njc4OTo7' as ParticipantId;
  const challenge = 'UFFSU1RVVldYWVpbXF1eX2BhYmNkZWZn' as ResumeChallenge;
  const proof = 'SPsQyqpMlcEcZf7Z7SoxC9hy3bg-S5a3SEiKBk7YxMM' as ResumeProof;

  it('generates canonical session IDs, resume secrets, and challenges', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(isSessionId(generateSessionId(cryptoRandom))).toBe(true);
      expect(isResumeSecret(generateResumeSecret(cryptoRandom))).toBe(true);
      expect(isResumeChallenge(generateResumeChallenge(cryptoRandom))).toBe(true);
    }
  });

  it('verifies the fixed vector with the stored key only', () => {
    const key = deriveResumeKey(secret);
    expect(key.byteLength).toBe(32);
    expect(key.toString('base64url')).not.toContain(secret);
    expect(resumeProofMatches(key, sessionId, participantId, challenge, proof)).toBe(true);
  });

  it('refuses a proof with any altered byte or binding', () => {
    const key = deriveResumeKey(secret);
    for (let index = 0; index < 32; index += 1) {
      expect(
        resumeProofMatches(key, sessionId, participantId, challenge, flipped(proof, index)),
      ).toBe(false);
    }
    expect(resumeProofMatches(key, flipped(sessionId), participantId, challenge, proof)).toBe(
      false,
    );
    expect(resumeProofMatches(key, sessionId, flipped(participantId), challenge, proof)).toBe(
      false,
    );
    expect(resumeProofMatches(key, sessionId, participantId, flipped(challenge), proof)).toBe(
      false,
    );
    expect(
      resumeProofMatches(
        deriveResumeKey(flipped(secret)),
        sessionId,
        participantId,
        challenge,
        proof,
      ),
    ).toBe(false);
  });

  it('never matches non-canonical input', () => {
    const key = deriveResumeKey(secret);
    expect(resumeProofMatches(key, 'x' as SessionId, participantId, challenge, proof)).toBe(false);
    expect(resumeProofMatches(key, sessionId, participantId, challenge, 'AA' as ResumeProof)).toBe(
      false,
    );
    expect(() => deriveResumeKey('short' as ResumeSecret)).toThrow();
  });
});
