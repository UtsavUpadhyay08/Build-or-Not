import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auc, bootstrapAucDiff, brier, ece, lexicalDiversity, panelSizeCurve } from "./metrics.js";
import { anonymize, balancedSample, batchYear, loadYC, parseCsv } from "./datasets.js";
import { buildJobs, runEval } from "./runEval.js";
import { buildReport, reportMarkdown } from "./report.js";
import { MemoryStore } from "../store/memoryStore.js";
import { PERSONAS } from "../personas.js";
import { MockProvider } from "../llm/mock.js";
import type { EvalItem } from "./types.js";

describe("metrics", () => {
  it("AUC: perfect, inverted, random-ish and ties", () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5);
    // hand-computed: pairs (pos>neg): 0.4>0.3 yes, 0.4>0.6 no, 0.7>0.3 yes, 0.7>0.6 yes -> 3/4
    expect(auc([0.3, 0.4, 0.6, 0.7], [0, 1, 0, 1])).toBe(0.75);
    expect(auc([1, 2], [1, 1])).toBeNaN();
  });

  it("Brier and ECE", () => {
    expect(brier([1, 0], [1, 0])).toBe(0);
    expect(brier([0.5, 0.5], [1, 0])).toBe(0.25);
    expect(ece([0.9, 0.9, 0.1, 0.1], [1, 1, 0, 0])).toBeCloseTo(0.1, 10);
  });

  it("lexical diversity", () => {
    expect(lexicalDiversity(["pricing is too high", "pricing is too high"])).toBe(0);
    expect(lexicalDiversity(["pricing worries", "onboarding friction"])).toBe(1);
  });

  it("bootstrap CI contains the point estimate, and excludes 0 for a clearly better predictor", () => {
    const labels: (0 | 1)[] = Array.from({ length: 60 }, (_, i) => (i % 2) as 0 | 1);
    const good = labels.map((l, i) => l * 0.6 + ((i * 7) % 10) / 25);
    const noise = labels.map((_, i) => ((i * 13) % 17) / 17);
    const r = bootstrapAucDiff(good, noise, labels, 500);
    expect(r.lo).toBeLessThanOrEqual(r.diff);
    expect(r.hi).toBeGreaterThanOrEqual(r.diff);
    expect(r.lo).toBeGreaterThan(0);
  });

  it("panel size curve rises when individual judges are noisy but informative", () => {
    // Each item: 45 judges = label signal + independent noise. Averaging more judges should help.
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const labels: (0 | 1)[] = Array.from({ length: 80 }, (_, i) => (i % 2) as 0 | 1);
    const perItem = labels.map((l) => Array.from({ length: 45 }, () => 5 + l * 1.0 + (rnd() - 0.5) * 8));
    const curve = panelSizeCurve(perItem, labels, [1, 9, 45], 50);
    expect(curve[0].auc).toBeLessThan(curve[1].auc);
    expect(curve[1].auc).toBeLessThan(curve[2].auc);
  });
});

describe("datasets", () => {
  it("parses quoted CSV with commas, escaped quotes and newlines", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi""\nbye"\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"\nbye'],
    ]);
  });

  it("batch years", () => {
    expect(batchYear("W15")).toBe(2015);
    expect(batchYear("Summer 2012")).toBe(2012);
    expect(batchYear("IK12")).toBe(2012);
    expect(batchYear(undefined)).toBeNull();
  });

  it("anonymizes company name, slug and domain", () => {
    const t = anonymize("Acmely helps teams. Visit acmely.io — acmely-labs is great.", { name: "Acmely", slug: "acmely-labs", website: "https://www.acmely.io" });
    expect(t.toLowerCase()).not.toContain("acmely");
  });

  it("loads YC with label rules, year window, and drops top companies", () => {
    const desc = "x".repeat(100);
    const data = [
      { name: "A", slug: "a", one_liner: desc, batch: "W15", status: "Inactive" },
      { name: "B", slug: "b", one_liner: desc, batch: "W15", status: "Active" },
      { name: "C", slug: "c", one_liner: desc, batch: "W15", status: "Acquired" },
      { name: "D", slug: "d", one_liner: desc, batch: "W24", status: "Inactive" }, // too recent
      { name: "E", slug: "e", one_liner: desc, batch: "W15", status: "Public", top_company: true }, // famous
    ];
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yc-")), "yc.json");
    fs.writeFileSync(file, JSON.stringify(data));
    expect(loadYC(file, { labelMode: "alive", fromYear: 2012, toYear: 2020 }).map((i) => [i.id, i.label])).toEqual([["yc-a", 0], ["yc-b", 1], ["yc-c", 1]]);
    expect(loadYC(file, { labelMode: "exit", fromYear: 2012, toYear: 2020 }).map((i) => i.id)).toEqual(["yc-a", "yc-c"]);
  });

  it("balanced sample is balanced and reproducible", () => {
    const items: EvalItem[] = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, text: "t", label: (i < 30 ? 1 : 0) as 0 | 1, meta: {} }));
    const s1 = balancedSample(items, 20, 42);
    expect(s1.filter((i) => i.label === 1)).toHaveLength(10);
    expect(balancedSample(items, 20, 42).map((i) => i.id)).toEqual(s1.map((i) => i.id));
    expect(() => balancedSample(items, 60, 1)).toThrow(/Not enough/);
  });
});

describe("runEval", () => {
  const items: EvalItem[] = Array.from({ length: 4 }, (_, i) => ({ id: `it${i}`, text: `idea ${i}`, label: (i % 2) as 0 | 1, meta: {} }));
  const personas = PERSONAS.slice(0, 6);
  const providers = ["mock-a", "mock-b", "mock-c"].map((m) => new MockProvider(m, 0, 0));

  it("runs all three conditions, then resumes without redoing anything", async () => {
    const store = new MemoryStore();
    const opts = { store, runId: "r1", items, personas, conditions: ["baseline", "panel", "mixed"] as const, primary: providers[0], mixedProviders: providers, concurrency: 4, budgetUsd: 100, log: () => {} };
    const first = await runEval({ ...opts, conditions: [...opts.conditions] });
    expect(first.jobs).toBe(4 * (1 + 6 + 6));
    expect((await store.getEvalJudgments("r1")).length).toBe(4 * 6 * 3);

    const again = await runEval({ ...opts, conditions: [...opts.conditions] });
    expect(again.jobs).toBe(0);
  });

  it("mixed condition rotates providers; job order is item-major", () => {
    const jobs = buildJobs({ runId: "r", items: items.slice(0, 2), personas, conditions: ["baseline", "mixed"], primary: providers[0], mixedProviders: providers }, new Set());
    expect(jobs[0].kind).toBe("baseline");
    const mixed = jobs.filter((j) => j.kind === "persona").slice(0, 6) as any[];
    expect(mixed.map((j) => j.provider.model)).toEqual(["mock-a", "mock-b", "mock-c", "mock-a", "mock-b", "mock-c"]);
    expect(jobs.slice(0, 7).every((j) => j.item.id === "it0")).toBe(true);
  });

  it("stops at the budget cap and leaves remaining work for a resume", async () => {
    const store = new MemoryStore();
    const priced = new MockProvider("claude-haiku-4-5", 0, 0); // real price table entry -> nonzero cost
    const r = await runEval({ store, runId: "b", items, personas, conditions: ["panel"], primary: priced, mixedProviders: [priced], concurrency: 1, budgetUsd: 0.001, log: () => {} });
    expect(r.stoppedForBudget).toBe(true);
    expect((await store.getEvalJudgments("b")).length).toBeLessThan(items.length * personas.length);
  });

  it("builds a report with comparisons and markdown", async () => {
    const store = new MemoryStore();
    await runEval({ store, runId: "rep", items, personas, conditions: ["baseline", "panel", "mixed"], primary: providers[0], mixedProviders: providers, concurrency: 4, budgetUsd: 100, log: () => {} });
    const report = buildReport("rep", await store.getEvalJudgments("rep"), 0.8, personas.length);
    expect(report.conditions.map((c) => c.condition)).toEqual(["baseline", "panel", "mixed"]);
    expect(report.comparisons).toHaveLength(3);
    expect(report.conditions.every((c) => c.items === items.length)).toBe(true); // baseline must parse too
    expect(report.comparisons.every((c) => c.items === items.length)).toBe(true);
    expect(report.conditions.find((c) => c.condition === "mixed")!.byProvider).toHaveLength(3);
    expect(reportMarkdown(report)).toContain("Threats to validity");
  });
});
