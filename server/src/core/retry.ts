/**
 * Retry with exponential backoff and FULL jitter.
 *
 *   delay(attempt) = random(0, min(maxDelay, base * 2^attempt))
 *
 * Why jitter: if 6 workers all hit a 429 at the same instant and all wait exactly 2s, they all
 * retry at the same instant and collide again. Randomizing the wait spreads them out
 * (see AWS's "Exponential Backoff and Jitter" analysis — full jitter does the least total work).
 *
 * Why classify errors: retrying a 400 (bad request) or 401 (bad key) just wastes time and money —
 * it will fail identically. Only transient failures are retried: 408/429/5xx, timeouts, network
 * resets. If the server sends Retry-After, we honour it instead of guessing.
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | null, // null = network/timeout, no HTTP response
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    if (this.status === null) return true; // timeout / connection reset
    return this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

export interface RetryOptions {
  maxAttempts: number; // total attempts including the first
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable?: (err: unknown) => boolean;
  /** Called before each wait — used to pause the provider's whole token bucket on 429. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
}

export const defaultIsRetryable = (err: unknown): boolean => (err instanceof ProviderError ? err.retryable : false);

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoffDelay(attempt: number, base: number, max: number, random: () => number = Math.random): number {
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const isLast = attempt === opts.maxAttempts - 1;
      if (isLast || !isRetryable(err)) throw err;

      const hinted = err instanceof ProviderError ? err.retryAfterMs : null;
      const delayMs = hinted !== null ? Math.min(hinted, opts.maxDelayMs) : backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, random);
      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
  throw lastError; // unreachable, keeps TS happy
}

/** Parse an HTTP Retry-After header (seconds, or an HTTP date) into ms. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
