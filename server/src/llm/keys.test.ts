import { describe, it, expect } from "vitest";
import { cleanKey } from "../config.js";
import { classify, maskKey } from "./keyCheck.js";
import { ManagedProvider } from "./managed.js";
import { TokenBucket } from "../core/tokenBucket.js";
import { ProviderError } from "../core/retry.js";
import type { CompletionRequest, LLMProvider } from "./types.js";
import { MemoryStore } from "../store/memoryStore.js";
import { PERSONAS } from "../personas.js";
import { runPanel } from "../panel/runPanel.js";

const req: CompletionRequest = { system: "s", user: "u", schemaName: "submit_verdict", schemaDescription: "", schema: { type: "object" }, maxTokens: 10 };
const good = { verdict: "build", score: 8, reasoning: "r", topConcern: "c", topAppeal: "a" };

class Fake implements LLMProvider {
  calls = 0;
  constructor(readonly name: "anthropic" | "openai", readonly model: string, private readonly respond: () => unknown) {}
  async complete() {
    this.calls++;
    const out = this.respond();
    if (out instanceof Error) throw out;
    return { data: out, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const managed = (inner: LLMProvider) => new ManagedProvider(inner, new TokenBucket(100, 100), { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 });

describe("API key hygiene", () => {
  it("cleans keys: whitespace, CRLF, quotes, placeholders", () => {
    expect(cleanKey("  sk-ant-abc\r")).toBe("sk-ant-abc");
    expect(cleanKey('"sk-ant-abc"')).toBe("sk-ant-abc");
    expect(cleanKey("'sk-ant-abc' ")).toBe("sk-ant-abc");
    expect(cleanKey("your-key-here")).toBe("");
    expect(cleanKey("sk-...")).toBe("");
    expect(cleanKey(undefined)).toBe("");
  });

  it("masks keys so they can be logged", () => {
    const m = maskKey("sk-ant-api03-SECRETSECRETSECRET-9xQz");
    expect(m).toMatch(/^sk-ant-…9xQz \(\d+ chars\)$/);
    expect(m).not.toContain("SECRET");
  });

  it("classifies provider responses", () => {
    expect(classify("anthropic", 200, "")).toBe("ok");
    expect(classify("anthropic", 401, "invalid x-api-key")).toBe("bad_key");
    expect(classify("gemini", 400, '{"reason":"API_KEY_INVALID"}')).toBe("bad_key");
    expect(classify("openai", 404, "model not found")).toBe("bad_model");
    expect(classify("openai", 429, '{"code":"insufficient_quota"}')).toBe("no_credit");
  });
});

describe("circuit breaker", () => {
  it("after one rejected-key error, later calls fail instantly without hitting the network", async () => {
    const inner = new Fake("anthropic", "m", () => new ProviderError("anthropic: HTTP 401 invalid x-api-key", "anthropic", 401));
    const p = managed(inner);
    await expect(p.complete(req)).rejects.toThrow(/rejected the key in ANTHROPIC_API_KEY/);
    await expect(p.complete(req)).rejects.toThrow(/rejected the key/);
    await expect(p.complete(req)).rejects.toThrow(/rejected the key/);
    expect(inner.calls).toBe(1); // 401 isn't retried, and the breaker stops the next two
    expect(p.disabledReason).toBeTruthy();
  });

  it("transient errors never open the breaker", async () => {
    const inner = new Fake("anthropic", "m", () => new ProviderError("503", "anthropic", 503));
    const p = managed(inner);
    await expect(p.complete(req)).rejects.toThrow();
    expect(p.disabledReason).toBeNull();
  });

  it("a mid-run key failure reroutes remaining personas to the healthy provider instead of failing quorum", async () => {
    const store = new MemoryStore();
    await store.insertIdea({ id: "i", createdAt: "", status: "running", mock: false, panelMode: "mixed", personaLibraryVersion: "1", error: null, title: "t", description: "d", targetAudience: "", pricingModel: "", competitors: "", sliders: { reach: 5, buildCost: 5, userImportance: 5, complexity: 5, value: 5, risk: 5 } });
    const bad = managed(new Fake("anthropic", "a", () => new ProviderError("401", "anthropic", 401)));
    const ok = managed(new Fake("openai", "o", () => good));
    const synth = managed(new Fake("openai", "o", () => ({ topConcerns: [], topAppeals: [], summary: "s" })));
    const healthy = () => [bad, ok].filter((p) => !p.disabledReason);
    const s = await runPanel(
      {
        store,
        personas: PERSONAS,
        assignments: PERSONAS.map((_, i) => (i % 2 ? ok : bad)),
        synthesisProvider: synth,
        concurrency: 1, // sequential, so the breaker opens on the first anthropic call
        quorum: 0.8,
        reroute: (assigned, i) => ((assigned as ManagedProvider).disabledReason ? healthy()[i % healthy().length] ?? assigned : assigned),
      },
      "i",
      { title: "t", description: "d", targetAudience: "", pricingModel: "", competitors: "", sliders: { reach: 5, buildCost: 5, userImportance: 5, complexity: 5, value: 5, risk: 5 } },
    );
    expect(s).not.toBeNull();
    expect(s!.failed).toBe(1); // only the call that discovered the bad key
    expect(s!.judged).toBe(44);
  });
});

// ---------- free OpenAI-compatible providers ----------
import { vi, afterEach } from "vitest";
import { extractJson, OpenAICompatibleProvider, _resetModeCache } from "./openaiCompatible.js";
import { pickFreeModel } from "./keyCheck.js";

describe("free providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetModeCache();
  });

  it("extracts JSON from think-tags, code fences and chatty prose", () => {
    expect(extractJson('<think>hmm</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":{"b":2}} Hope that helps.')).toEqual({ a: { b: 2 } });
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson("no json here")).toBe("no json here"); // left for zod to reject -> re-ask
  });

  it("auto-picks a sensible free model and skips unsuitable ones", () => {
    const or = (id: string) => id.endsWith(":free");
    expect(pickFreeModel(["x/paid", "qwen/qwen3-coder:free", "meta-llama/llama-3.3-70b-instruct:free"], or)).toBe("meta-llama/llama-3.3-70b-instruct:free");
    expect(pickFreeModel(["whisper-large-v3", "llama-guard-4", "openai/gpt-oss-120b"])).toBe("openai/gpt-oss-120b");
    expect(pickFreeModel(["x/paid"], or)).toBeNull();
  });

  it("treats a free tier's DAILY cap as permanent for the day (not retried)", () => {
    expect(classify("openrouter", 429, "Rate limit exceeded: free-models-per-day")).toBe("quota");
    expect(classify("groq", 429, "Rate limit reached on tokens per day (TPD)")).toBe("quota");
    expect(classify("groq", 429, "Rate limit reached on tokens per minute (TPM)")).toBe("error"); // transient -> retried
  });

  it("downgrades json_schema -> json_object -> prompt, and remembers what worked", async () => {
    const seen: (string | undefined)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push(body.response_format?.type);
      if (body.response_format) return new Response(JSON.stringify({ error: { message: "No endpoints found that support response_format" } }), { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok {"verdict":"build"}' } }], usage: {} }), { status: 200 });
    });
    const p = new OpenAICompatibleProvider("openrouter", "m:free", "k");
    expect((await p.complete(req)).data).toEqual({ verdict: "build" });
    expect(seen).toEqual(["json_schema", "json_object", undefined]);
    await p.complete(req);
    expect(seen.slice(3)).toEqual([undefined]); // second call goes straight to the mode that worked
  });

  it("a real 404 for a missing model still surfaces as an error after downgrading", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }));
    await expect(new OpenAICompatibleProvider("groq", "nope", "k").complete(req)).rejects.toThrow(/404/);
  });
});

// ---------- run-2 fixes: retired models, no-credit accounts, upstream rate limits ----------
import { pickGeminiModel, rankFree } from "./keyCheck.js";

describe("retired models and flaky free tiers", () => {
  it("picks the newest stable Gemini Flash, skipping lite/tts/preview", () => {
    expect(pickGeminiModel(["gemini-3.8-flash-lite", "gemini-3.8-flash-tts", "gemini-3.8-flash", "gemini-3.5-pro", "gemini-3.9-flash-preview"])).toBe("gemini-3.8-flash");
    expect(pickGeminiModel([])).toBeNull();
  });

  it("recognises 'no credit' from Anthropic and OpenAI", () => {
    expect(classify("anthropic", 400, "Your credit balance is too low to access the Anthropic API")).toBe("no_credit");
    expect(classify("openai", 429, '{"code":"insufficient_quota"}')).toBe("no_credit");
  });

  it("ranks free models so OpenRouter gets sensible fallbacks", () => {
    const or = (id: string) => id.endsWith(":free");
    expect(rankFree(["a/gemma:free", "meta-llama/llama-3.3-70b-instruct:free", "x/paid", "q/qwen3-coder:free"], or)).toEqual(["meta-llama/llama-3.3-70b-instruct:free", "a/gemma:free"]);
  });

  it("cools down a provider after repeated transient failures, so personas get rerouted", async () => {
    const inner = new Fake("openai", "m", () => new ProviderError("upstream rate-limited", "openai", 429));
    const p = new ManagedProvider(inner, new TokenBucket(100, 100), { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });
    for (let i = 0; i < ManagedProvider.COOL_AFTER; i++) await expect(p.complete(req)).rejects.toThrow();
    expect(p.unavailableReason).toMatch(/paused/);
    expect(p.disabledReason).toBeNull(); // temporary, not permanent
    const before = inner.calls;
    await expect(p.complete(req)).rejects.toThrow(/paused/);
    expect(inner.calls).toBe(before); // no network call while cooling
  });
});
