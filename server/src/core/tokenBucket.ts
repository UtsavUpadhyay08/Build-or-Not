/**
 * Token-bucket rate limiter — one instance per LLM provider.
 *
 * Model: the bucket holds up to `capacity` tokens and refills continuously at `refillPerSec`.
 * Every request spends 1 token (or `cost`). If the bucket is empty, the caller waits.
 *
 *   capacity     = how big a burst we allow (e.g. 10 requests back-to-back)
 *   refillPerSec = the sustained rate (e.g. 50 RPM -> 50/60 ≈ 0.83 tokens/sec)
 *
 * Design choices worth being able to defend:
 *  - FIFO waiters: requests are granted in arrival order, so one persona can't be starved by
 *    others that happened to retry at a lucky moment.
 *  - Lazy refill: we don't run a setInterval. Tokens are recomputed from elapsed time whenever
 *    someone asks, and a single timer is armed only while someone is waiting. No background work
 *    when idle.
 *  - pauseFor(): when a provider returns 429 + Retry-After, ONE worker learns about it, but every
 *    worker using that provider should back off. pauseFor() blocks the whole bucket until then —
 *    shared backpressure instead of 6 workers each discovering the 429 independently.
 *  - Injectable clock + timer so tests run in virtual time (no real sleeping, no flakiness).
 */

export interface Clock {
  now(): number; // ms
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

interface Waiter {
  cost: number;
  resolve: () => void;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private pausedUntil = 0;
  private readonly queue: Waiter[] = [];
  private timer: unknown = null;

  private cap: number;
  private rate: number;

  constructor(
    capacity: number,
    refillPerSec: number,
    private readonly clock: Clock = realClock,
  ) {
    if (capacity <= 0 || refillPerSec <= 0) throw new Error("TokenBucket: capacity and refillPerSec must be > 0");
    this.cap = capacity;
    this.rate = refillPerSec;
    this.tokens = capacity;
    this.lastRefill = clock.now();
  }

  get capacity(): number {
    return this.cap;
  }
  get refillPerSec(): number {
    return this.rate;
  }

  /**
   * Resize the bucket to what the provider says it can take right now (measured before a run):
   * `capacity` calls may start at once, then `refillPerSec` more per second. `tokens` is how many
   * are available this moment (defaults to a full bucket). Waiters are re-evaluated immediately.
   */
  reconfigure(capacity: number, refillPerSec: number, tokens = capacity): void {
    if (capacity <= 0 || refillPerSec <= 0) throw new Error("TokenBucket: capacity and refillPerSec must be > 0");
    this.refill();
    this.cap = capacity;
    this.rate = refillPerSec;
    this.tokens = Math.max(0, Math.min(capacity, tokens));
    this.lastRefill = this.clock.now();
    this.drain();
  }

  /** Resolves once `cost` tokens have been taken. */
  acquire(cost = 1): Promise<void> {
    if (cost > this.capacity) throw new Error(`TokenBucket: cost ${cost} exceeds capacity ${this.capacity}`);
    return new Promise<void>((resolve) => {
      this.queue.push({ cost, resolve });
      this.drain();
    });
  }

  /** Block every caller until `ms` from now (used on 429 Retry-After). Never shortens an existing pause. */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
    this.tokens = 0; // after a 429 the provider is telling us we were over budget — don't burst on resume
    this.lastRefill = this.pausedUntil;
    this.drain();
  }

  /** Current token count (after refill). Exposed for tests/metrics. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  get waiting(): number {
    return this.queue.length;
  }

  private refill(): void {
    const now = this.clock.now();
    if (now <= this.lastRefill) return;
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.cap, this.tokens + elapsedSec * this.rate);
    this.lastRefill = now;
  }

  private drain(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.clock.now();
    if (now < this.pausedUntil) {
      this.arm(this.pausedUntil - now);
      return;
    }
    this.refill();
    // Grant strictly in FIFO order: if the head can't be served, nobody behind it is either.
    while (this.queue.length > 0 && this.tokens >= this.queue[0].cost) {
      const w = this.queue.shift()!;
      this.tokens -= w.cost;
      w.resolve();
    }
    if (this.queue.length > 0) {
      const deficit = this.queue[0].cost - this.tokens;
      this.arm(Math.ceil((deficit / this.rate) * 1000));
    }
  }

  private arm(ms: number): void {
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.drain();
    }, Math.max(1, ms));
  }
}

/** Build a bucket from a requests-per-minute budget. Burst defaults to ~10% of RPM (min 1, max 10). */
export function bucketFromRpm(rpm: number, burst?: number, clock?: Clock): TokenBucket {
  const capacity = burst ?? Math.max(1, Math.min(10, Math.floor(rpm / 10)));
  return new TokenBucket(capacity, rpm / 60, clock);
}
