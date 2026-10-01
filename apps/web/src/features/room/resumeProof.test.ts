import type { ParticipantId, ResumeChallenge, ResumeSecret, SessionId } from '@driftless/protocol';
import { describe, expect, it } from 'vitest';
import {
  RECONNECT_DELAYS_MS,
  RESUME_ATTEMPT_TIMEOUT_MS,
  browserTimers,
} from './reconnectSchedule.ts';
import { createResumeProver, type SubtleLike } from './resumeProof.ts';

// The fixed vector of packages/protocol/test/resume.test.ts, computed
// independently with Python's hashlib and hmac. Node's crypto (the service)
// reproduces it there; this checks the browser's Web Crypto path.
const VECTOR = {
  secret: 'gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp-g' as ResumeSecret,
  sessionId: 'EBESExQVFhcYGRobHB0eHyAhIiM' as SessionId,
  participantId: 'MDEyMzQ1Njc4OTo7' as ParticipantId,
  challenge: 'UFFSU1RVVldYWVpbXF1eX2BhYmNkZWZn' as ResumeChallenge,
  proof: 'SPsQyqpMlcEcZf7Z7SoxC9hy3bg-S5a3SEiKBk7YxMM',
};

const args = [VECTOR.secret, VECTOR.sessionId, VECTOR.participantId, VECTOR.challenge] as const;

describe('createResumeProver', () => {
  it('computes the fixed vector with Web Crypto', async () => {
    const prove = createResumeProver(crypto.subtle);
    expect(await prove(...args)).toBe(VECTOR.proof);
  });

  it('binds every input', async () => {
    const prove = createResumeProver(crypto.subtle);
    const variants = await Promise.all([
      prove(
        VECTOR.secret,
        VECTOR.sessionId,
        VECTOR.participantId,
        'U'.repeat(32) as ResumeChallenge,
      ),
      prove(VECTOR.secret, 'E'.repeat(27) as SessionId, VECTOR.participantId, VECTOR.challenge),
      prove(VECTOR.secret, VECTOR.sessionId, 'M'.repeat(16) as ParticipantId, VECTOR.challenge),
      prove(
        'g'.repeat(44) as ResumeSecret,
        VECTOR.sessionId,
        VECTOR.participantId,
        VECTOR.challenge,
      ),
    ]);
    expect(new Set([VECTOR.proof, ...variants]).size).toBe(5);
  });

  it('uses a non-extractable signing key and never exposes the secret', async () => {
    const calls: unknown[][] = [];
    const subtle: SubtleLike = {
      digest: (...input) => {
        calls.push(['digest', ...input]);
        return crypto.subtle.digest(...input);
      },
      importKey: ((...input: Parameters<SubtleCrypto['importKey']>) => {
        calls.push(['importKey', ...input]);
        return crypto.subtle.importKey(...input);
      }) as SubtleCrypto['importKey'],
      sign: (...input) => crypto.subtle.sign(...input),
    };
    await createResumeProver(subtle)(...args);
    const importCall = calls.find((call) => call[0] === 'importKey');
    expect(importCall?.[4]).toBe(false);
    expect(importCall?.[5]).toStrictEqual(['sign']);
  });

  it('fails closed, without detail, on bad input or a crypto failure', async () => {
    expect(
      await createResumeProver(crypto.subtle)(
        'bad' as ResumeSecret,
        VECTOR.sessionId,
        VECTOR.participantId,
        VECTOR.challenge,
      ),
    ).toBeUndefined();
    const broken: SubtleLike = {
      digest: () => Promise.reject(new Error('internal crypto detail')),
      importKey: crypto.subtle.importKey.bind(crypto.subtle),
      sign: crypto.subtle.sign.bind(crypto.subtle),
    };
    expect(await createResumeProver(broken)(...args)).toBeUndefined();
  });
});

describe('reconnect schedule', () => {
  it('is finite, starts immediately, has a bounded step, and fits the service grace period', () => {
    expect(RECONNECT_DELAYS_MS).toStrictEqual([0, 250, 500, 1000, 2000, 4000, 4000, 4000]);
    expect(Math.max(...RECONNECT_DELAYS_MS)).toBeLessThanOrEqual(4000);
    const total = RECONNECT_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBe(15_750);
    expect(total).toBeLessThan(30_000);
    expect(RESUME_ATTEMPT_TIMEOUT_MS).toBe(5000);
  });

  it('browser timers can be cancelled', async () => {
    let ran = false;
    const cancel = browserTimers.schedule(0, () => {
      ran = true;
    });
    cancel();
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ran).toBe(false);
  });
});
