import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MEDIA_FINGERPRINT_CHUNK_BYTES as CHUNK,
  MAX_MEDIA_FINGERPRINT_BYTES,
  type SessionId,
} from '@driftless/protocol';
import { fingerprintMedia, type FingerprintSource, type Sha256 } from '../src/index.js';
const sessionId = Buffer.from(Array.from({ length: 20 }, (_, i) => i)).toString(
  'base64url',
) as SessionId;
const otherSession = Buffer.alloc(20, 5).toString('base64url') as SessionId;
const sha256: Sha256 = (bytes) =>
  Promise.resolve(Uint8Array.from(createHash('sha256').update(bytes).digest()));
interface Vector {
  name: string;
  size: number;
  changed: number;
  fingerprint: string;
  otherSessionFingerprint: string;
}
const vectors = JSON.parse(
  readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'),
) as Vector[];
function source(size: number, changed = -1): FingerprintSource {
  return {
    size,
    read: async (start, end) => {
      await Promise.resolve();
      const bytes = new Uint8Array(end - start);
      for (let i = start; i < end; i++) bytes[i - start] = (i % 251) ^ (i === changed ? 1 : 0);
      return bytes.buffer;
    },
  };
}
const calculate = (
  source: FingerprintSource,
  sid = sessionId,
  hash = sha256,
  signal = new AbortController().signal,
) => fingerprintMedia({ source, sessionId: sid, sha256: hash, signal });
describe('bounded full-file fingerprint', () => {
  it.each(vectors)('matches independent fixed vector $name', async (v) => {
    await Promise.resolve();
    expect(await calculate(source(v.size, v.changed))).toBe(v.fingerprint);
    expect(await calculate(source(v.size, v.changed), otherSession)).toBe(
      v.otherSessionFingerprint,
    );
  });
  it('same bytes/session match repeatedly, names and MIME cannot affect identity', async () => {
    await Promise.resolve();
    const a = Object.assign(source(10), { name: 'a.mp4', type: 'video/mp4' });
    const b = Object.assign(source(10), { name: 'renamed.webm', type: 'video/webm' });
    expect(await calculate(a)).toBe(await calculate(b));
  });
  it('first/middle/last changed bytes produce distinct identity evidence', () => {
    expect(
      new Set(vectors.filter((v) => v.size === 2 * CHUNK + 17).map((v) => v.fingerprint)).size,
    ).toBe(4);
  });
  it('covers every byte exactly once in sequential <=4MiB reads with at most one read/digest active', async () => {
    await Promise.resolve();
    const size = 2 * CHUNK + 7;
    let active = 0;
    let maximum = 0;
    let hashing = false;
    const ranges: [number, number][] = [];
    const progress: number[] = [];
    const underlying = source(size);
    await fingerprintMedia({
      source: {
        size,
        read: async (start, end) => {
          await Promise.resolve();
          expect(hashing).toBe(false);
          active++;
          maximum = Math.max(maximum, active);
          ranges.push([start, end]);
          await Promise.resolve();
          const bytes = await underlying.read(start, end);
          active--;
          return bytes;
        },
      },
      sessionId,
      sha256: async (bytes) => {
        await Promise.resolve();
        expect(active).toBe(0);
        expect(hashing).toBe(false);
        hashing = true;
        const result = await sha256(bytes);
        hashing = false;
        return result;
      },
      signal: new AbortController().signal,
      onProgress: (processed) => progress.push(processed),
    });
    expect(maximum).toBe(1);
    expect(ranges).toEqual([
      [0, CHUNK],
      [CHUNK, 2 * CHUNK],
      [2 * CHUNK, size],
    ]);
    expect(progress).toEqual([0, CHUNK, 2 * CHUNK, size]);
  });
  it.each([MAX_MEDIA_FINGERPRINT_BYTES + 1, Number.MAX_SAFE_INTEGER, -1, 1.5])(
    'rejects invalid/oversize %s before allocating or reading',
    async (size) => {
      await Promise.resolve();
      let reads = 0;
      await expect(
        calculate({
          size,
          read: async () => {
            await Promise.resolve();
            reads++;
            return new ArrayBuffer(0);
          },
        }),
      ).rejects.toMatchObject({ category: 'FILE_TOO_LARGE' });
      expect(reads).toBe(0);
    },
  );
  it('rejects empty media without a read', async () => {
    await Promise.resolve();
    await expect(calculate(source(0))).rejects.toMatchObject({ category: 'READ_FAILED' });
  });
  it('returns fixed errors for short/failed reads and failed/invalid digests', async () => {
    await Promise.resolve();
    await expect(
      calculate({ size: 1, read: () => Promise.resolve(new ArrayBuffer(0)) }),
    ).rejects.toMatchObject({ category: 'READ_FAILED' });
    await expect(
      calculate({
        size: 1,
        read: async () => {
          await Promise.resolve();
          throw new Error('private path');
        },
      }),
    ).rejects.toMatchObject({ message: 'READ_FAILED' });
    await expect(
      calculate(source(1), sessionId, async () => {
        await Promise.resolve();
        throw new Error('raw');
      }),
    ).rejects.toMatchObject({ message: 'HASH_FAILED' });
    await expect(
      calculate(source(1), sessionId, () => Promise.resolve(new Uint8Array(31))),
    ).rejects.toMatchObject({ category: 'HASH_FAILED' });
  });
  it.each(['before', 'read', 'hash'] as const)(
    'cancellation %s prevents further reads/progress/publication',
    async (phase) => {
      await Promise.resolve();
      const abort = new AbortController();
      let reads = 0;
      let progress = 0;
      if (phase === 'before') abort.abort();
      const underlying = source(CHUNK + 1);
      await expect(
        fingerprintMedia({
          source: {
            size: underlying.size,
            read: async (start, end) => {
              await Promise.resolve();
              reads++;
              if (phase === 'read') abort.abort();
              return underlying.read(start, end);
            },
          },
          sessionId,
          sha256: async (bytes) => {
            await Promise.resolve();
            if (phase === 'hash') abort.abort();
            return sha256(bytes);
          },
          signal: abort.signal,
          onProgress: (processed) => {
            progress = processed;
          },
        }),
      ).rejects.toMatchObject({ category: 'CANCELLED' });
      expect(reads).toBe(phase === 'before' ? 0 : 1);
      expect(progress).toBe(0);
    },
  );
});
