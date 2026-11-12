/**
 * Several API keys for one provider (e.g. GROQ_API_KEYS), behaving as one provider.
 *
 * Free tiers limit each key separately, so N keys give about N times the capacity. The pool:
 *   - takes keys in turn (round-robin), so the load is even
 *   - on "too many requests" from one key, rests that key and tries the next one straight away,
 *     inside the same call, instead of making the persona wait
 *   - drops a key for good if the provider rejects it (or its account has no credit), and rests it
 *     for an hour if its daily allowance is used up
 *
 * What one key says is never reported as the pool's answer. A single key's "used up for today"
 * used to reach ManagedProvider as-is, which then switched off the whole provider (every key) until
 * a restart. Now, when no key can take the call, the pool reports its own state:
 *   - some key only needs a short rest    -> 429 "at their limit right now" (normal retry waits)
 *   - every usable key is done for today  -> 429 "used up today's free limit" (classified as quota)
 *   - every key was rejected              -> 401
 */
import { ProviderError } from "../core/retry.js";
import type { CompletionRequest, CompletionResult, LLMProvider } from "./types.js";
import type { ProviderName } from "../config.js";

interface Slot {
  provider: LLMProvider;
  restUntil: number;
  /** True while the rest is for a daily cap (as opposed to a per-minute one). */
  restDaily: boolean;
  dropped: string | null;
}

export const DAILY_REST_MS = 60 * 60_000;
const SHORT_REST_MS = 15_000;

const isDaily = (e: ProviderError) => /per[- ]?day|daily|RPD|TPD|tokens per day|requests per day/i.test(e.message);
/** Key-level failures: this key can't be used, the others may well be fine. */
const isDeadKey = (e: ProviderError) => e.status === 401 || e.status === 403 || e.status === 402 || /insufficient_quota|credit balance|insufficient credits/i.test(e.message);

export class KeyPool implements LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  private next = 0;
  private readonly slots: Slot[];

  constructor(providers: LLMProvider[], private readonly now: () => number = Date.now) {
    if (!providers.length) throw new Error("KeyPool needs at least one key");
    this.name = providers[0].name;
    this.model = providers[0].model;
    this.slots = providers.map((provider) => ({ provider, restUntil: 0, restDaily: false, dropped: null }));
  }

  get size(): number {
    return this.slots.length;
  }
  /** Keys not dropped (rejected keys don't count). */
  get working(): number {
    return this.slots.filter((s) => !s.dropped).length;
  }
  /** Keys that could take a call right now. */
  get ready(): number {
    const t = this.now();
    return this.slots.filter((s) => !s.dropped && s.restUntil <= t).length;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    for (let tried = 0; tried < this.slots.length; tried++) {
      const slot = this.pick();
      if (!slot) break;
      try {
        return await slot.provider.complete(req);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err; // bad output etc.: not the key's fault
        if (isDeadKey(err)) {
          slot.dropped = err.message;
          continue; // this key is dead; another may work
        }
        if (err.status === 429) {
          const day = isDaily(err);
          slot.restDaily = day;
          slot.restUntil = this.now() + (day ? DAILY_REST_MS : Math.max(err.retryAfterMs ?? 0, SHORT_REST_MS));
          continue; // try the next key right away
        }
        throw err; // timeouts, 5xx: let the normal retry logic handle them
      }
    }
    throw this.exhausted();
  }

  /** The pool's own error once no key could take the call. Never one key's error passed through. */
  private exhausted(): ProviderError {
    const live = this.slots.filter((s) => !s.dropped);
    if (!live.length) {
      return new ProviderError(`${this.name}: none of the ${this.slots.length} keys were accepted (${this.slots[0].dropped ?? "rejected"})`, this.name, 401);
    }
    const t = this.now();
    const wait = Math.max(1000, Math.min(...live.map((s) => s.restUntil)) - t);
    const n = live.length === 1 ? `the 1 ${this.name} key` : `all ${live.length} ${this.name} keys`;
    if (live.every((s) => s.restDaily && s.restUntil > t)) {
      // Worded so classify() files it as "quota": the provider steps aside for a while, other providers take over.
      return new ProviderError(`${n} have used up their free limit for today (tokens per day). They're tried again within the hour.`, this.name, 429, wait);
    }
    return new ProviderError(`${n} are at their limit right now; the soonest is free in ${Math.ceil(wait / 1000)}s.`, this.name, 429, wait);
  }

  /** The next usable key in turn, or null if all are resting or dropped. */
  private pick(): Slot | null {
    const t = this.now();
    for (let k = 0; k < this.slots.length; k++) {
      const i = (this.next + k) % this.slots.length;
      const s = this.slots[i];
      if (!s.dropped && s.restUntil <= t) {
        this.next = (i + 1) % this.slots.length;
        return s;
      }
    }
    return null;
  }
}
