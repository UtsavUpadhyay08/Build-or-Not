/**
 * Several API keys for one provider (e.g. GROQ_API_KEYS), behaving as one provider.
 *
 * Free tiers limit each key separately, so N keys give about N times the capacity. The pool:
 *   - takes keys in turn (round-robin), so the load is even
 *   - on "too many requests" from one key, rests that key and tries the next one straight away,
 *     inside the same call, instead of making the persona wait
 *   - drops a key for good if the provider rejects it, and rests it for an hour if its daily
 *     allowance is used up
 * Only when every key is resting or dropped does the call fail (and the normal retry/backoff,
 * circuit breaker and "went home" story take over).
 */
import { ProviderError } from "../core/retry.js";
import type { CompletionRequest, CompletionResult, LLMProvider } from "./types.js";
import type { ProviderName } from "../config.js";

interface Slot {
  provider: LLMProvider;
  restUntil: number;
  dropped: string | null;
}

const isDaily = (e: ProviderError) => /per[- ]?day|daily|RPD|TPD|tokens per day|requests per day/i.test(e.message);

export class KeyPool implements LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  private next = 0;
  private readonly slots: Slot[];

  constructor(providers: LLMProvider[], private readonly now: () => number = Date.now) {
    if (!providers.length) throw new Error("KeyPool needs at least one key");
    this.name = providers[0].name;
    this.model = providers[0].model;
    this.slots = providers.map((provider) => ({ provider, restUntil: 0, dropped: null }));
  }

  get size(): number {
    return this.slots.length;
  }
  /** Keys not dropped (rejected keys don't count). */
  get working(): number {
    return this.slots.filter((s) => !s.dropped).length;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    let last: unknown = null;
    for (let tried = 0; tried < this.slots.length; tried++) {
      const slot = this.pick();
      if (!slot) break;
      try {
        return await slot.provider.complete(req);
      } catch (err) {
        last = err;
        if (!(err instanceof ProviderError)) throw err; // bad output etc.: not the key's fault
        if (err.status === 401 || err.status === 403) {
          slot.dropped = err.message;
          continue; // this key is dead; another may work
        }
        if (err.status === 429) {
          slot.restUntil = this.now() + (isDaily(err) ? 60 * 60_000 : Math.max(err.retryAfterMs ?? 0, 15_000));
          continue; // try the next key right away
        }
        throw err; // timeouts, 5xx: let the normal retry logic handle them
      }
    }
    if (last) throw last;
    const soonest = Math.min(...this.slots.filter((s) => !s.dropped).map((s) => s.restUntil));
    const wait = Number.isFinite(soonest) ? Math.max(1000, soonest - this.now()) : null;
    throw new ProviderError(
      this.working ? `${this.name}: all ${this.working} keys are at their limit right now` : `${this.name}: none of the ${this.slots.length} keys were accepted`,
      this.name,
      this.working ? 429 : 401,
      wait,
    );
  }

  /** The next usable key in turn, or null if all are resting or dropped. */
  private pick(): Slot | null {
    const t = this.now();
    for (let k = 0; k < this.slots.length; k++) {
      const s = this.slots[(this.next + k) % this.slots.length];
      if (!s.dropped && s.restUntil <= t) {
        this.next = (this.slots.indexOf(s) + 1) % this.slots.length;
        return s;
      }
    }
    return null;
  }
}
