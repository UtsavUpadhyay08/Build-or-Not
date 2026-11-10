/**
 * Wraps a raw provider with the two things every call needs:
 *   1. its provider's token bucket (rate limiting), acquired before EVERY attempt, retries included
 *   2. retry with exponential backoff + jitter for transient errors
 *
 * On a 429 the whole bucket is paused, so every other worker using this provider backs off too.
 * Also counts calls/retries/failures per provider — shown in the eval report.
 */
import { config } from "../config.js";
import { TokenBucket, bucketFromRpm } from "../core/tokenBucket.js";
import { defaultIsRetryable, ProviderError, withRetry } from "../core/retry.js";
import type { CompletionRequest, CompletionResult, LLMProvider } from "./types.js";
import { classify, explain } from "./keyCheck.js";

export interface ProviderStats {
  calls: number;
  retries: number;
  rateLimited: number;
  failures: number;
}

export class ManagedProvider implements LLMProvider {
  readonly stats: ProviderStats = { calls: 0, retries: 0, rateLimited: 0, failures: 0 };
  /**
   * Circuit breaker for PERMANENT failures. If the provider rejects our key (or the model doesn't
   * exist), every later call will fail identically — so the first such failure opens the breaker and
   * all remaining calls fail instantly with a clear message, instead of 44 more doomed HTTP requests.
   * Set by the startup key check too. Transient errors (429/5xx) never open it; retries handle those.
   */
  disabledReason: string | null = null;
  disabledStatus: string | null = null;

  /**
   * Cool-down for TRANSIENT trouble: free models are often "temporarily rate-limited upstream" for
   * minutes at a time. If several personas in a row fail on this provider even after retries, stop
   * sending it work for a while (the panel reroutes to other providers), then let it back in.
   * This is the half-open half of a circuit breaker; disabledReason above is the permanent half.
   */
  private consecutiveFailures = 0;
  private coolingUntil = 0;
  static readonly COOL_AFTER = 3;
  static readonly COOL_MS = 3 * 60_000;

  /** Why this provider shouldn't get work right now (permanent or cooling down), or null if it's usable. */
  get unavailableReason(): string | null {
    if (this.disabledReason) return this.disabledReason;
    if (Date.now() < this.coolingUntil) return `${this.name} kept failing (${this.lastTransient}); paused for a few minutes while other providers take over.`;
    return null;
  }
  private lastTransient = "";

  /**
   * Average real tokens per persona call (prompt + answer), learned from finished calls. Replaces the
   * up-front estimate when measuring how many calls this key can take at once.
   */
  private tokenSamples = 0;
  private tokenAvg = 0;
  get avgTokensPerCall(): number | null {
    return this.tokenSamples >= 3 ? this.tokenAvg : null;
  }
  private recordUsage(total: number, schemaName: string) {
    if (schemaName !== "submit_verdict" || !(total > 0)) return; // persona calls only, not synthesis
    this.tokenSamples++;
    // Running mean for the first 20 calls, then an exponential average that follows model changes.
    const w = Math.max(1 / this.tokenSamples, 1 / 20);
    this.tokenAvg += (total - this.tokenAvg) * w;
  }

  constructor(
    private readonly inner: LLMProvider,
    readonly bucket: TokenBucket,
    private readonly retry = config.retry,
  ) {}

  get name() {
    return this.inner.name;
  }
  get model() {
    return this.inner.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.disabledReason) throw tag(new ProviderError(this.disabledReason, this.name, 401), this.disabledStatus ?? "bad_key", 0);
    const cooling = this.unavailableReason;
    if (cooling) throw tag(new ProviderError(cooling, this.name, 503), "cooling", 0);
    let attempts = 0;
    try {
      const out = await withRetry(
        async () => {
          attempts++;
          await this.bucket.acquire(1, req.fairKey);
          this.stats.calls++;
          return this.inner.complete(req);
        },
        {
          ...this.retry,
          signal: req.signal,
          // A free tier's DAILY cap returns 429 like a normal rate limit, but waiting 20s won't help.
          isRetryable: (err) => defaultIsRetryable(err) && !(err instanceof ProviderError && err.status !== null && classify(this.name, err.status, err.message) === "quota"),
          onRetry: ({ delayMs, error }) => {
            this.stats.retries++;
            if (error instanceof ProviderError && error.status === 429) {
              this.stats.rateLimited++;
              this.bucket.pauseFor(delayMs);
            }
          },
        },
      );
      this.consecutiveFailures = 0;
      this.recordUsage(out.usage.inputTokens + out.usage.outputTokens, req.schemaName);
      return out;
    } catch (err) {
      this.stats.failures++;
      if (err instanceof ProviderError && err.retryable && !req.signal?.aborted) {
        this.lastTransient = err.status ? `HTTP ${err.status}` : "network errors";
        if (++this.consecutiveFailures >= ManagedProvider.COOL_AFTER) {
          this.coolingUntil = Date.now() + ManagedProvider.COOL_MS;
          this.consecutiveFailures = 0;
        }
      }
      if (err instanceof ProviderError && err.status !== null && this.name !== "mock") {
        const status = classify(this.name, err.status, err.message);
        if (status === "bad_key" || status === "bad_model" || status === "no_credit" || status === "quota") {
          this.disabledStatus ??= status;
          this.disabledReason ??= explain({ name: this.name, model: this.model, apiKey: "" }, status, err.message);
          throw tag(new ProviderError(this.disabledReason, this.name, err.status), status, attempts);
        }
      }
      if (err && typeof err === "object") (err as any).attempts ??= attempts;
      throw err;
    }
  }
}

/** Attach a failure kind and attempt count so the UI can explain, in plain words, why a persona failed. */
function tag(err: ProviderError, kind: string, attempts: number): ProviderError {
  const e = err as ProviderError & { kind?: string; attempts?: number };
  e.kind = kind === "quota" ? "daily_quota" : kind;
  e.attempts = attempts;
  return e;
}

/**
 * Buckets are keyed by provider NAME, not model: rate limits are per account/provider, so two
 * Anthropic models (e.g. persona + synthesis) must share one bucket.
 */
const buckets = new Map<string, TokenBucket>();

export function bucketFor(providerName: string, rpm: number, burst?: number): TokenBucket {
  let b = buckets.get(providerName);
  if (!b) {
    b = bucketFromRpm(rpm, burst);
    buckets.set(providerName, b);
  }
  return b;
}
