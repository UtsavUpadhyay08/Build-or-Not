/**
 * The key pool inside the real ManagedProvider (retries, circuit breaker), the way the panel uses it.
 * These cover the ways one tired key used to take every other key down with it.
 */
import { describe, expect, it } from "vitest";
import { ProviderError } from "../core/retry.js";
import { TokenBucket } from "../core/tokenBucket.js";
import { KeyPool } from "./keyPool.js";
import { ManagedProvider } from "./managed.js";
import type { CompletionRequest, LLMProvider } from "./types.js";

const req: CompletionRequest = { system: "s", user: "u", schemaName: "submit_verdict", schemaDescription: "", schema: { type: "object" }, maxTokens: 10 };
const retry = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 };
const daily = () => new ProviderError("Rate limit reached for model on tokens per day (TPD): Limit 100000, Used 99999", "groq", 429, 5_000);
const perMinute = () => new ProviderError("Rate limit reached for tokens per minute (TPM)", "groq", 429, 20_000);

function key(label: string, fail: () => ProviderError | null = () => null): LLMProvider & { calls: number } {
  return {
    name: "groq",
    model: "m",
    calls: 0,
    async complete() {
      this.calls++;
      const err = fail();
      if (err) throw err;
      return { data: { key: label }, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}
const managed = (pool: LLMProvider) => new ManagedProvider(pool, new TokenBucket(100, 100), retry);

describe("KeyPool inside ManagedProvider", () => {
  it("one key running out for the day does not switch off the other keys", async () => {
    let t = 0;
    let aTired = true;
    const a = key("a", () => (aTired ? perMinute() : null)); // just busy for a few seconds
    const b = key("b", daily); // done for today
    const p = managed(new KeyPool([a, b], () => t));
    await expect(p.complete(req)).rejects.toThrow();
    expect(p.disabledReason).toBeNull(); // the pool is still usable
    t = 30_000;
    aTired = false;
    expect(((await p.complete(req)).data as { key: string }).key).toBe("a");
  });

  it("keeps answering while some keys are out for the day", async () => {
    const p = managed(new KeyPool([key("a", daily), key("b", daily), key("c")]));
    for (let i = 0; i < 6; i++) expect(((await p.complete(req)).data as { key: string }).key).toBe("c");
    expect(p.disabledReason).toBeNull();
  });

  it("says plainly when every key is used up for today", async () => {
    const p = managed(new KeyPool([key("a", daily), key("b", daily)]));
    const err = await p.complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(String(err.message)).toMatch(/2 groq keys/i);
    expect(err.kind).toBe("daily_quota");
  });

  it("a key that ran out comes back once its rest is over (no restart needed)", async () => {
    let t = 0;
    let spent = true;
    const a = key("a", () => (spent ? daily() : null));
    const pool = new KeyPool([a, key("b", daily)], () => t);
    const p = managed(pool);
    await p.complete(req).catch(() => undefined);
    t = 61 * 60_000;
    spent = false;
    p.disabledReason = null; // what the periodic re-check does
    expect(((await p.complete(req)).data as { key: string }).key).toBe("a");
  });
});
