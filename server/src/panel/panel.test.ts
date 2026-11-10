import { describe, it, expect } from "vitest";
import { PERSONAS } from "../personas.js";
import { MemoryStore } from "../store/memoryStore.js";
import { ProviderError } from "../core/retry.js";
import { callStructured } from "../llm/structured.js";
import type { CompletionRequest, CompletionResult, LLMProvider } from "../llm/types.js";
import type { IdeaBrief, IdeaRecord } from "../types.js";
import { computeDisagreement, computeOverallScore, computeOverallVerdict, countVerdicts, meetsQuorum, stdDev, verdictEntropy, type Scored } from "./aggregate.js";
import { runPanel, type ProgressEvent } from "./runPanel.js";
import { verdictZ } from "./prompts.js";

const v = (verdict: Scored["verdict"], score: number): Scored => ({ verdict, score });

describe("persona library", () => {
  it("has 45 unique personas, 5 categories x 9", () => {
    expect(PERSONAS).toHaveLength(45);
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(45);
    const byCat = new Map<string, number>();
    for (const p of PERSONAS) byCat.set(p.category, (byCat.get(p.category) ?? 0) + 1);
    expect([...byCat.values()]).toEqual([9, 9, 9, 9, 9]);
  });

  it("is ordered by category, so round-robin over 3 providers gives each provider 3 per category", () => {
    const counts = new Map<string, number>();
    PERSONAS.forEach((p, i) => counts.set(`${i % 3}|${p.category}`, (counts.get(`${i % 3}|${p.category}`) ?? 0) + 1));
    expect([...counts.values()].every((n) => n === 3)).toBe(true);
  });
});

describe("aggregation", () => {
  it("counts, scores and verdicts", () => {
    expect(countVerdicts([v("build", 8), v("build", 7), v("maybe", 5), v("dont_build", 2)])).toEqual({ build: 2, maybe: 1, dont_build: 1 });
    expect(computeOverallScore([v("build", 10), v("build", 10)])).toBe(100);
    expect(computeOverallScore([v("dont_build", 1)])).toBe(0);
    expect(computeOverallScore([])).toBe(0);
    expect(computeOverallVerdict({ build: 30, maybe: 10, dont_build: 5 }, 70)).toBe("build");
    expect(computeOverallVerdict({ build: 10, maybe: 14, dont_build: 21 }, 40)).toBe("dont_build");
    expect(computeOverallVerdict({ build: 5, maybe: 30, dont_build: 10 }, 20)).toBe("dont_build");
    expect(computeOverallVerdict({ build: 15, maybe: 20, dont_build: 10 }, 50)).toBe("maybe");
    expect(computeOverallVerdict({ build: 0, maybe: 0, dont_build: 0 }, 0)).toBe("maybe");
  });

  it("verdict entropy: 0 when unanimous, 1 for an even three-way split", () => {
    expect(verdictEntropy({ build: 45, maybe: 0, dont_build: 0 })).toBe(0);
    expect(verdictEntropy({ build: 15, maybe: 15, dont_build: 15 })).toBeCloseTo(1, 10);
  });

  it("std dev and confidence labels", () => {
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
    const unanimous = Array.from({ length: 10 }, () => ({ ...v("build", 8), cat: "a", prov: "p" }));
    expect(computeDisagreement(unanimous, (x) => x.cat, (x) => x.prov).confidence).toBe("high");
    const split = [1, 10, 1, 10, 5, 5].map((s) => ({ ...v(s > 7 ? "build" : s < 4 ? "dont_build" : "maybe", s), cat: "a", prov: "p" }));
    expect(computeDisagreement(split, (x) => x.cat, (x) => x.prov).confidence).toBe("low");
  });

  it("quorum", () => {
    expect(meetsQuorum(36, 45, 0.8)).toBe(true);
    expect(meetsQuorum(35, 45, 0.8)).toBe(false);
  });
});

// ---------- fake providers for orchestration tests ----------

class ScriptedProvider implements LLMProvider {
  readonly name = "mock" as const;
  calls = 0;
  constructor(readonly model: string, private readonly respond: (req: CompletionRequest, n: number) => unknown) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    await new Promise((r) => setTimeout(r, 1));
    const out = this.respond(req, this.calls);
    if (out instanceof Error) throw out;
    return { data: out, usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

const good = { verdict: "build", score: 8, reasoning: "r", topConcern: "c", topAppeal: "a" };
const synth = { topConcerns: [], topAppeals: [], summary: "s" };
const idea: IdeaBrief = { title: "t", description: "d", targetAudience: "", pricingModel: "", competitors: "", sliders: { reach: 5, buildCost: 5, userImportance: 5, complexity: 5, value: 5, risk: 5 } };

async function seedIdea(store: MemoryStore, id = "idea1") {
  const rec: IdeaRecord = { ...idea, id, createdAt: new Date().toISOString(), status: "running", mock: true, panelMode: "single", personaLibraryVersion: "1", error: null };
  await store.insertIdea(rec);
}

describe("validate-and-re-ask", () => {
  it("re-asks once with the validation errors and accepts the fix", async () => {
    const p = new ScriptedProvider("m", (req, n) => (n === 1 ? { verdict: "definitely", score: "eleven" } : good));
    let secondPrompt = "";
    const wrapped: LLMProvider = { name: p.name, model: p.model, complete: async (req) => ((secondPrompt = req.user), p.complete(req)) };
    const res = await callStructured(wrapped, { system: "", user: "u", schemaName: "submit_verdict", schemaDescription: "", schema: { type: "object" }, maxTokens: 10 }, verdictZ);
    expect(res.repaired).toBe(true);
    expect(res.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
    expect(secondPrompt).toContain("did not match the required schema");
  });

  it("clamps out-of-range scores rather than rejecting them", () => {
    expect(verdictZ.parse({ ...good, score: 14 }).score).toBe(10);
    expect(verdictZ.parse({ ...good, score: "7" }).score).toBe(7);
  });

  it("throws after a second invalid answer", async () => {
    const p = new ScriptedProvider("m", () => ({ nope: true }));
    await expect(callStructured(p, { system: "", user: "u", schemaName: "x", schemaDescription: "", schema: { type: "object" }, maxTokens: 10 }, verdictZ)).rejects.toThrow(/after re-ask/);
    expect(p.calls).toBe(2);
  });
});

describe("runPanel", () => {
  const personas = PERSONAS;

  it("publishes a verdict when a few personas fail (partial failure above quorum)", async () => {
    const store = new MemoryStore();
    await seedIdea(store);
    const failing = new Set(personas.slice(0, 3).map((p) => p.id));
    const provider = new ScriptedProvider("m", (req) => (req.schemaName === "submit_synthesis" ? synth : [...failing].some((id) => req.system.includes(personas.find((p) => p.id === id)!.brief)) ? new ProviderError("down", "mock", 500) : good));
    const events: ProgressEvent[] = [];
    const s = await runPanel({ store, personas, assignments: personas.map(() => provider), synthesisProvider: provider, concurrency: 8, quorum: 0.8, emit: (e) => events.push(e) }, "idea1", idea);
    expect(s?.judged).toBe(42);
    expect(s?.failed).toBe(3);
    expect((await store.getFailures("idea1")).length).toBe(3);
    expect((await store.getIdea("idea1"))?.status).toBe("completed");
    expect(events.filter((e) => e.type === "failure")).toHaveLength(3);
  });

  it("refuses to publish below quorum", async () => {
    const store = new MemoryStore();
    await seedIdea(store);
    const provider = new ScriptedProvider("m", (req, n) => (req.schemaName === "submit_synthesis" ? synth : n % 2 ? new ProviderError("x", "mock", 500) : good));
    const s = await runPanel({ store, personas, assignments: personas.map(() => provider), synthesisProvider: provider, concurrency: 1, quorum: 0.8 }, "idea1", idea);
    expect(s).toBeNull();
    const rec = await store.getIdea("idea1");
    expect(rec?.status).toBe("failed");
    expect(rec?.error).toMatch(/at least 80% need to/);
  });

  it("resumes: personas with a saved verdict are not called again", async () => {
    const store = new MemoryStore();
    await seedIdea(store);
    const first = new ScriptedProvider("m", (req) => (req.schemaName === "submit_synthesis" ? synth : good));
    await runPanel({ store, personas: personas.slice(0, 20), assignments: personas.slice(0, 20).map(() => first), synthesisProvider: first, concurrency: 4, quorum: 0 }, "idea1", idea);

    const second = new ScriptedProvider("m", (req) => (req.schemaName === "submit_synthesis" ? synth : good));
    await runPanel({ store, personas, assignments: personas.map(() => second), synthesisProvider: second, concurrency: 4, quorum: 0.8 }, "idea1", idea);
    expect(second.calls).toBe(25 + 1); // 25 missing personas + 1 synthesis
    expect((await store.getVerdicts("idea1")).length).toBe(45);
  });

  it("still publishes the numeric verdict if theme synthesis fails", async () => {
    const store = new MemoryStore();
    await seedIdea(store);
    const provider = new ScriptedProvider("m", (req) => (req.schemaName === "submit_synthesis" ? new ProviderError("401", "mock", 401) : good));
    const s = await runPanel({ store, personas, assignments: personas.map(() => provider), synthesisProvider: provider, concurrency: 8, quorum: 0.8 }, "idea1", idea);
    expect(s?.themesAvailable).toBe(false);
    expect(s?.overallVerdict).toBe("build");
  });

  it("records which provider judged each persona (mixed mode)", async () => {
    const store = new MemoryStore();
    await seedIdea(store);
    const ps = ["a", "b", "c"].map((m) => new ScriptedProvider(m, (req) => (req.schemaName === "submit_synthesis" ? synth : good)));
    const s = await runPanel({ store, personas, assignments: personas.map((_, i) => ps[i % 3]), synthesisProvider: ps[0], concurrency: 8, quorum: 0.8 }, "idea1", idea);
    expect(s?.disagreement.byProvider.map((g) => g.n).sort()).toEqual([15, 15, 15]);
  });
});

// ---------- plain-language failure categories (shown as "why they went home") ----------
import { describeFailure } from "./runPanel.js";
import { StructuredOutputError } from "../llm/structured.js";

describe("describeFailure", () => {
  it("classifies provider errors into kinds the UI can explain", () => {
    expect(describeFailure(new ProviderError("x", "groq", 429)).kind).toBe("rate_limit");
    expect(describeFailure(new ProviderError("Rate limit exceeded: free-models-per-day", "openrouter", 429)).kind).toBe("daily_quota");
    expect(describeFailure(new ProviderError("groq: request failed (timed out after 60000ms)", "groq", null)).kind).toBe("timeout");
    expect(describeFailure(new ProviderError("x", "groq", 503)).kind).toBe("server_error");
    expect(describeFailure(new ProviderError("x", "groq", 401)).kind).toBe("bad_key");
    expect(describeFailure(new StructuredOutputError("bad", { inputTokens: 0, outputTokens: 0 })).kind).toBe("bad_output");
    expect(describeFailure(new Error("boom")).kind).toBe("unknown");
  });

  it("keeps the kind and attempt count the managed provider attached", () => {
    const e = Object.assign(new ProviderError("paused", "groq", 503), { kind: "cooling", attempts: 0 });
    expect(describeFailure(e)).toEqual({ kind: "cooling", status: 503, attempts: 0 });
    const r = Object.assign(new ProviderError("x", "groq", 429), { attempts: 4 });
    expect(describeFailure(r).attempts).toBe(4);
  });
});

// ---------- PANEL_ALL_AT_ONCE: every persona call in flight together ----------
import { bucketFromRpm } from "../core/tokenBucket.js";
import { ManagedProvider } from "../llm/managed.js";

describe("all at once", () => {
  it("starts all 45 persona calls together when concurrency and burst are 45", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: LLMProvider = {
      name: "mock",
      model: "m",
      async complete(req) {
        if (req.schemaName === "submit_synthesis") return { data: synth, usage: { inputTokens: 1, outputTokens: 1 } };
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return { data: good, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    // A slow 6/min bucket (like Groq's free tier) but with a burst of 45: nothing waits for a refill.
    const p = new ManagedProvider(slow, bucketFromRpm(6, 45), { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });
    const store = new MemoryStore();
    await seedIdea(store);
    const t0 = Date.now();
    const s = await runPanel({ store, personas: PERSONAS, assignments: PERSONAS.map(() => p), synthesisProvider: slow, concurrency: 45, quorum: 0.8 }, "idea1", idea);
    expect(s?.judged).toBe(45);
    expect(peak).toBe(45);
    expect(Date.now() - t0).toBeLessThan(1000); // one 30ms wave, not 45 paced calls
  });

  it("paces calls by default: a 6/min bucket lets only 1 through at once", () => {
    const b = bucketFromRpm(6);
    expect(b.capacity).toBe(1);
    expect(bucketFromRpm(6, 45).capacity).toBe(45);
  });
});
