/**
 * Integration test against a real MongoDB. Skipped unless MONGODB_TEST_URI is set, e.g.
 *   MONGODB_TEST_URI=mongodb://127.0.0.1:27017/build-or-not-test npm test
 * (CI sets it via a mongo service container.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MongoClient } from "mongodb";
import { MongoStore } from "./mongoStore.js";
import type { IdeaRecord, PersonaVerdict } from "../types.js";

const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)("MongoStore (integration)", () => {
  let store: MongoStore;

  beforeAll(async () => {
    const c = new MongoClient(uri!);
    await c.connect();
    await c.db().dropDatabase();
    await c.close();
    store = await MongoStore.connect(uri!);
  });
  afterAll(async () => store?.close());

  const idea: IdeaRecord = {
    id: "i1", createdAt: new Date().toISOString(), status: "running", mock: true, panelMode: "single", personaLibraryVersion: "1", error: null,
    title: "t", description: "d", targetAudience: "", pricingModel: "", competitors: "", sliders: { reach: 1, buildCost: 1, userImportance: 1, complexity: 1, value: 1, risk: 1 },
  };
  const verdict = (personaId: string): PersonaVerdict => ({
    ideaId: "i1", personaId, verdict: "build", score: 8, reasoning: "r", topConcern: "c", topAppeal: "a", createdAt: new Date().toISOString(),
    provider: "mock", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, repaired: false,
  });

  it("round-trips ideas and status updates", async () => {
    await store.insertIdea(idea);
    await store.updateIdeaStatus("i1", "completed");
    expect((await store.getIdea("i1"))?.status).toBe("completed");
    expect((await store.listIdeas()).map((i) => i.id)).toContain("i1");
  });

  it("verdict writes are idempotent, and a success beats a failure", async () => {
    await store.saveFailure({ ideaId: "i1", personaId: "p1", provider: "mock", model: "m", error: "x", createdAt: "" });
    await store.saveVerdict(verdict("p1"));
    await store.saveVerdict(verdict("p1")); // duplicate write — must not duplicate
    await store.saveFailure({ ideaId: "i1", personaId: "p1", provider: "mock", model: "m", error: "late failure", createdAt: "" });
    expect(await store.getVerdicts("i1")).toHaveLength(1);
    expect(await store.getFailures("i1")).toHaveLength(0);
  });

  it("eval judgments upsert by key", async () => {
    const j = { runId: "r", condition: "panel" as const, itemId: "x", label: 1 as const, personaId: "p", category: "c", ok: true, provider: "mock", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0, createdAt: "" };
    await store.saveEvalJudgments([j, { ...j, personaId: "q" }]);
    await store.saveEvalJudgments([j]);
    expect(await store.getEvalJudgments("r")).toHaveLength(2);
    expect((await store.evalDoneKeys("r")).has("r:panel:x:p")).toBe(true);
  });

  it("delete removes the idea and its judgments", async () => {
    await store.deleteIdea("i1");
    expect(await store.getIdea("i1")).toBeNull();
    expect(await store.getVerdicts("i1")).toHaveLength(0);
  });
});
