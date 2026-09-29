export interface RateLimit {
  /** Messages that may arrive back to back. */
  readonly burst: number;
  /** Sustained messages per second. */
  readonly perSecond: number;
}

/**
 * Provisional per-connection bound. Phase 2A clients send a handful of room
 * messages per session; this rejects floods while leaving ample headroom. It
 * must be revisited when Phase 2B adds negotiation traffic.
 */
export const DEFAULT_RATE_LIMIT: RateLimit = { burst: 20, perSecond: 5 };

/**
 * Deterministic token bucket. The caller supplies the time, so tests need no
 * timers. A clock that moves backwards adds no tokens.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #perMs: number;
  #tokens: number;
  #last: number;

  constructor(limit: RateLimit, now: number) {
    if (!Number.isInteger(limit.burst) || limit.burst < 1) {
      throw new RangeError('burst must be a positive integer');
    }
    if (!Number.isFinite(limit.perSecond) || limit.perSecond <= 0) {
      throw new RangeError('perSecond must be positive and finite');
    }
    this.#capacity = limit.burst;
    this.#perMs = limit.perSecond / 1000;
    this.#tokens = limit.burst;
    this.#last = now;
  }

  /** Takes one token if available. Returns false when the limit is exceeded. */
  tryTake(now: number): boolean {
    const elapsed = Math.max(0, now - this.#last);
    this.#last = Math.max(this.#last, now);
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#perMs);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
