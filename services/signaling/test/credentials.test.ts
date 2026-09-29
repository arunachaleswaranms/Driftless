import { randomBytes } from 'node:crypto';
import { isInviteSecret, isParticipantId, isRoomId } from '@driftless/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  cryptoRandom,
  digestInviteSecret,
  digestsEqual,
  generateInviteSecret,
  generateParticipantId,
  generateRoomId,
} from '../src/credentials.js';

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
