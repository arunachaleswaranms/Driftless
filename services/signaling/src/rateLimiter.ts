export interface RateLimit {
  /** Messages that may arrive back to back. */
  readonly burst: number;
  /** Sustained messages per second. */
  readonly perSecond: number;
}

/**
 * Provisional per-connection bound. A participant sends a few room messages,
 * one offer or answer, and its trickled ICE candidates, which a browser
 * gathers in a burst; one negotiation may carry at most
 * MAX_ICE_CANDIDATES_PER_NEGOTIATION (32) of them. The burst admits a whole
 * negotiation at once with headroom, and the refill bounds sustained
 * traffic. It is an implementation and security bound, not a measured limit.
 */
export const DEFAULT_RATE_LIMIT: RateLimit = { burst: 48, perSecond: 10 };

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
