import { describe, expect, it } from "vitest";
import { ProviderError } from "../core/retry.js";
import { KeyPool } from "./keyPool.js";
import type { CompletionRequest, LLMProvider } from "./types.js";

const req: CompletionRequest = { system: "s", user: "u", schemaName: "submit_verdict", schemaDescription: "", schema: { type: "object" }, maxTokens: 10 };

/** A fake key: answers, or fails with the given status the next `fails` times. */
function key(label: string, behaviour: () => null | ProviderError = () => null) {
  const calls: string[] = [];
  const p: LLMProvider & { calls: string[] } = {
    name: "groq",
    model: "m",
    calls,
    async complete() {
      calls.push(label);
      const err = behaviour();
      if (err) throw err;
      return { data: { key: label }, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return p;
}

describe("KeyPool: several free keys as one provider", () => {
  it("spreads calls evenly across the keys", async () => {
    const ks = [key("a"), key("b"), key("c")];
    const pool = new KeyPool(ks);
    const used = [];
    for (let i = 0; i < 6; i++) used.push(((await pool.complete(req)).data as { key: string }).key);
    expect(used).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("when one key is rate-limited, the same call moves to the next key straight away", async () => {
    let t = 0;
    const a = key("a", () => new ProviderError("Rate limit reached for tokens per minute", "groq", 429, 20_000));
    const b = key("b");
    const pool = new KeyPool([a, b], () => t);
    expect(((await pool.complete(req)).data as { key: string }).key).toBe("b");
    // key a is resting now: the next calls go to b without trying a
    await pool.complete(req);
    expect(a.calls).toHaveLength(1);
    t = 21_000; // rest is over
    await pool.complete(req).catch(() => undefined);
    expect(a.calls.length).toBeGreaterThan(1);
  });

  it("drops a rejected key for good and keeps working with the rest", async () => {
    const bad = key("bad", () => new ProviderError("Invalid API Key", "groq", 401));
    const good = key("good");
    const pool = new KeyPool([bad, good]);
    for (let i = 0; i < 4; i++) await pool.complete(req);
    expect(bad.calls).toHaveLength(1);
    expect(pool.working).toBe(1);
  });

  it("rests a key for an hour when its daily allowance is used up", async () => {
    let t = 0;
    const a = key("a", () => new ProviderError("Rate limit reached ... requests per day (RPD)", "groq", 429, 5_000));
    const b = key("b");
    const pool = new KeyPool([a, b], () => t);
    await pool.complete(req);
    t = 30 * 60_000; // half an hour later: a is still resting
    await pool.complete(req);
    expect(a.calls).toHaveLength(1);
  });

  it("fails as a rate limit (so the normal retry waits) only when every key is at its limit", async () => {
    const limited = () => new ProviderError("too many requests", "groq", 429, 10_000);
    const pool = new KeyPool([key("a", limited), key("b", limited)], () => 0);
    await expect(pool.complete(req)).rejects.toMatchObject({ status: 429 });
    await expect(pool.complete(req)).rejects.toMatchObject({ status: 429, retryAfterMs: 15_000 });
  });

  it("doesn't blame the key for a server error: that goes to the normal retry", async () => {
    const a = key("a", () => new ProviderError("upstream 503", "groq", 503));
    const b = key("b");
    const pool = new KeyPool([a, b]);
    await expect(pool.complete(req)).rejects.toMatchObject({ status: 503 });
    expect(b.calls).toHaveLength(0);
  });
});

describe("GROQ_API_KEYS", () => {
  it("reads one key plus a list, in any separator, without duplicates or placeholders", async () => {
    process.env.TESTPROV_API_KEY = "gsk_one";
    process.env.TESTPROV_API_KEYS = 'gsk_two, gsk_three\n"gsk_four" gsk_one your-key-here';
    const { keysFor } = await import("../config.js");
    expect(keysFor("testprov")).toEqual(["gsk_one", "gsk_two", "gsk_three", "gsk_four"]);
    delete process.env.TESTPROV_API_KEY;
    delete process.env.TESTPROV_API_KEYS;
  });
});
