import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMIT, TokenBucket } from '../src/rateLimiter.js';

describe('TokenBucket', () => {
  it('allows a burst, then refills at the sustained rate', () => {
    const bucket = new TokenBucket({ burst: 3, perSecond: 2 }, 0);
    expect([bucket.tryTake(0), bucket.tryTake(0), bucket.tryTake(0)]).toStrictEqual([
      true,
      true,
      true,
    ]);
    expect(bucket.tryTake(0)).toBe(false);
    expect(bucket.tryTake(499)).toBe(false);
    expect(bucket.tryTake(500)).toBe(true);
    expect(bucket.tryTake(500)).toBe(false);
  });

  it('never exceeds its burst capacity after idling', () => {
    const bucket = new TokenBucket({ burst: 2, perSecond: 10 }, 0);
    const results = [1, 2, 3].map(() => bucket.tryTake(1_000_000));
    expect(results).toStrictEqual([true, true, false]);
  });

  it('bounds a sustained flood to the configured rate', () => {
    const bucket = new TokenBucket({ burst: 5, perSecond: 5 }, 0);
    let accepted = 0;
    // 1000 messages per second for 10 seconds.
    for (let ms = 0; ms < 10_000; ms += 1) if (bucket.tryTake(ms)) accepted += 1;
    expect(accepted).toBeLessThanOrEqual(5 + 5 * 10);
    expect(accepted).toBeGreaterThanOrEqual(50);
  });

  it('adds no tokens when the clock moves backwards', () => {
    const bucket = new TokenBucket({ burst: 1, perSecond: 1 }, 10_000);
    expect(bucket.tryTake(10_000)).toBe(true);
    expect(bucket.tryTake(0)).toBe(false);
    expect(bucket.tryTake(10_999)).toBe(false);
    expect(bucket.tryTake(11_000)).toBe(true);
  });

  it('validates its limits', () => {
    for (const limit of [
      { burst: 0, perSecond: 1 },
      { burst: 1.5, perSecond: 1 },
      { burst: 1, perSecond: 0 },
      { burst: 1, perSecond: Number.POSITIVE_INFINITY },
      { burst: 1, perSecond: Number.NaN },
    ]) {
      expect(() => new TokenBucket(limit, 0)).toThrow(RangeError);
    }
    expect(() => new TokenBucket(DEFAULT_RATE_LIMIT, 0)).not.toThrow();
  });
});
