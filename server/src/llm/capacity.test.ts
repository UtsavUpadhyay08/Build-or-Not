import { describe, expect, it } from "vitest";
import { buildSendPlan, estimateTokensPerCall, parseRateHeaders, planCapacity } from "./capacity.js";
import { TokenBucket } from "../core/tokenBucket.js";

const headers = (h: Record<string, string>) => (k: string) => h[k] ?? null;
const opts = { tokensPerCall: 1250, rpmFallback: 6 };

describe("reading rate-limit headers", () => {
  it("Groq: request headers are per day, token headers per minute", () => {
    const info = parseRateHeaders("groq", headers({ "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "998", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "7990" }));
    expect(info).toMatchObject({ rpdLimit: 1000, rpdRemaining: 998, tpmLimit: 8000, tpmRemaining: 7990 });
    expect(info.rpmLimit).toBeUndefined();
  });

  it("OpenAI: request headers are per minute", () => {
    const info = parseRateHeaders("openai", headers({ "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "499", "x-ratelimit-limit-tokens": "200000", "x-ratelimit-remaining-tokens": "199000" }));
    expect(info).toMatchObject({ rpmLimit: 500, rpmRemaining: 499, tpmLimit: 200000 });
  });

  it("Anthropic: its own header names", () => {
    const info = parseRateHeaders("anthropic", headers({ "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "49", "anthropic-ratelimit-input-tokens-limit": "40000", "anthropic-ratelimit-input-tokens-remaining": "40000" }));
    expect(info).toMatchObject({ rpmLimit: 50, rpmRemaining: 49, tpmLimit: 40000 });
  });
});

describe("planning how many calls start at once", () => {
  it("Groq free tier: tokens per minute decide it (8000 / 1250 = 6), not the 30 requests a minute", () => {
    const c = planCapacity("groq", { tpmLimit: 8000, tpmRemaining: 8000, rpdRemaining: 900 }, opts);
    expect(c).toMatchObject({ burst: 6, now: 6, perMinute: 6, dailyLeft: 900, source: "measured" });
    expect(c.detail).toMatch(/8,000 tokens a minute/);
  });

  it("a bigger Groq tier is capped by the documented 30 requests a minute", () => {
    expect(planCapacity("groq", { tpmLimit: 300_000, tpmRemaining: 300_000 }, opts)).toMatchObject({ burst: 30, perMinute: 30 });
  });

  it("only what's left this minute starts immediately", () => {
    const c = planCapacity("groq", { tpmLimit: 8000, tpmRemaining: 2600 }, opts);
    expect(c).toMatchObject({ burst: 6, now: 2 });
  });

  it("a 429 on the probe means nothing starts until it frees up", () => {
    expect(planCapacity("groq", { tpmLimit: 8000, tpmRemaining: 0, retryAfterSec: 7 }, opts)).toMatchObject({ now: 0, burst: 6 });
  });

  it("paid keys with high limits send the whole panel at once", () => {
    expect(planCapacity("openai", { rpmLimit: 500, rpmRemaining: 500, tpmLimit: 200_000, tpmRemaining: 200_000 }, opts)).toMatchObject({ now: 45, burst: 45 });
  });

  it("Gemini reports nothing: the documented free-tier rate is assumed", () => {
    expect(planCapacity("gemini", {}, { ...opts, rpmFallback: 60 })).toMatchObject({ now: 10, perMinute: 10, source: "documented" });
  });

  it("settings win: <NAME>_RPM caps the rate, <NAME>_BURST pins the burst, forced sends all 45", () => {
    expect(planCapacity("groq", { tpmLimit: 300_000 }, { ...opts, rpmSetting: 12 })).toMatchObject({ perMinute: 12 });
    expect(planCapacity("groq", { tpmLimit: 8000, tpmRemaining: 8000 }, { ...opts, burstPin: 3 })).toMatchObject({ burst: 3, now: 3, source: "setting" });
    expect(planCapacity("groq", { tpmLimit: 8000, tpmRemaining: 0 }, { ...opts, burstPin: 45, source: "forced" })).toMatchObject({ now: 45 });
  });

  it("uses the real average tokens per call once there is one", () => {
    expect(estimateTokensPerCall(1500, 900)).toBe(900);
    expect(estimateTokensPerCall(1500)).toBeGreaterThan(1000);
  });
});

describe("send plan for a run", () => {
  it("adds up what starts now and how long until every persona has been sent", () => {
    const groq = planCapacity("groq", { tpmLimit: 8000, tpmRemaining: 8000, rpdRemaining: 900 }, opts);
    const or = planCapacity("openrouter", { rpdRemaining: 10 }, opts);
    const plan = buildSendPlan("auto", [
      { key: "groq", name: "groq", model: "m", personas: 23, cap: groq },
      { key: "openrouter", name: "openrouter", model: "m:free", personas: 22, cap: or },
    ]);
    expect(plan.startNow).toBe(6 + 10);
    expect(plan.providers[0].startAllSec).toBe(170); // 17 more at 6 a minute
    expect(plan.warnings[0]).toMatch(/only 10 requests left today for 22/);
    expect(plan.concurrency).toBe(6 + 20);
  });
});

describe("token bucket reconfigure", () => {
  it("resizes to the measured limits and releases waiters", async () => {
    const b = new TokenBucket(1, 0.1);
    await b.acquire();
    let released = 0;
    const waits = [b.acquire(), b.acquire(), b.acquire()].map((p) => p.then(() => released++));
    await new Promise((r) => setTimeout(r, 5));
    expect(released).toBe(0);
    b.reconfigure(5, 1, 3);
    await Promise.all(waits);
    expect(released).toBe(3);
    expect(b.capacity).toBe(5);
  });
});
