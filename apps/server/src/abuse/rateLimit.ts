/** The result of a rate-limit check. */
export interface RateLimitResult {
  /** Whether the event is within the limit. */
  allowed: boolean;
  /** Events remaining in the window after this one. */
  remaining: number;
  /** When the window frees up, in milliseconds from now. Zero when allowed. */
  retryAfterMs: number;
}

/** Options for {@link SlidingWindowRateLimiter}. */
export interface RateLimiterOptions {
  /** The time source. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * A sliding-window rate limiter.
 *
 * Each key keeps the timestamps of its recent events. A check prunes events
 * older than the window, then admits the event when fewer than `limit` remain.
 * State is in-process, which matches the single-process v1 deployment.
 */
export class SlidingWindowRateLimiter {
  private readonly now: () => number;
  private readonly events = new Map<string, number[]>();

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Record an event for `key` and report whether it is within `limit` events
   * per `windowMs`. A denied event is not recorded.
   */
  check(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = this.now();
    const cutoff = now - windowMs;
    const recent = (this.events.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

    if (limit <= 0 || recent.length >= limit) {
      const oldest = recent[0] ?? now;
      this.events.set(key, recent);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, oldest + windowMs - now),
      };
    }

    recent.push(now);
    this.events.set(key, recent);
    return { allowed: true, remaining: limit - recent.length, retryAfterMs: 0 };
  }

  /** Drop all state for a key. */
  reset(key: string): void {
    this.events.delete(key);
  }

  /** Drop all state. */
  clear(): void {
    this.events.clear();
  }
}
