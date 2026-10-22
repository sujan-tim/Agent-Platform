/**
 * Sign-in rate limiting: slows down password guessing.
 *
 * Two limits, both counted in a sliding window and kept in memory:
 * - per email: failed sign-ins only, so one person mistyping does not lock
 *   out a colleague, and a correct password clears the count;
 * - per network address: every sign-in and sign-up attempt, so one machine
 *   cannot try many accounts or create companies in bulk.
 *
 * In memory means the counts reset when the server restarts and are not
 * shared between servers. That is fine for one server; several servers need
 * a shared store (Redis or the database) behind the same methods.
 */

export interface Limit {
  max: number;
  windowMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: Limit,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until `key` may try again, or 0 if it may try now. */
  retryAfter(key: string): number {
    const times = this.recent(key);
    if (times.length < this.limit.max) return 0;
    return times[0] + this.limit.windowMs - this.now();
  }

  record(key: string): void {
    const times = this.recent(key);
    times.push(this.now());
    this.hits.set(key, times);
    if (this.hits.size > 10_000) this.sweep();
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  private recent(key: string): number[] {
    const since = this.now() - this.limit.windowMs;
    return (this.hits.get(key) ?? []).filter((t) => t > since);
  }

  /** Drops keys with no recent hits so the map cannot grow without bound. */
  private sweep(): void {
    for (const key of [...this.hits.keys()]) {
      if (this.recent(key).length === 0) this.hits.delete(key);
    }
  }
}

/** Failed sign-ins allowed per email. */
export const EMAIL_LIMIT: Limit = { max: 5, windowMs: 15 * 60_000 };
/** Sign-in and sign-up attempts allowed per network address. */
export const ADDRESS_LIMIT: Limit = { max: 30, windowMs: 15 * 60_000 };
