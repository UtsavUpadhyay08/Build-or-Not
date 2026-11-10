/**
 * Batch runner for the experiment. Three conditions on the SAME items, same personas, same
 * aggregation — the only thing that changes is how the judgments are produced:
 *
 *   baseline : ONE call; the model role-plays all personas at once (they can see each other)
 *   panel    : one independent call per persona, single model
 *   mixed    : one independent call per persona, personas spread round-robin across providers
 *
 * Engineering properties (what makes 200 items x 91 calls survivable):
 *  - Resumable: every judgment is upserted under a deterministic key (runId:condition:item:persona).
 *    Re-running the same command skips what's already stored. Ctrl-C at any point loses nothing.
 *  - Budget cap: running USD total; once it crosses --budget-usd, the abort signal stops new work.
 *  - Item-major job order: jobs are interleaved per item across conditions, so a run stopped halfway
 *    still has complete, comparable items for every condition instead of all of one and none of another.
 *  - Same pool / token buckets / retry as the live app — the eval is a load test of that machinery too.
 */
import { runPool } from "../core/workerPool.js";
import type { Persona } from "../personas.js";
import type { LLMProvider } from "../llm/types.js";
import { callStructured } from "../llm/structured.js";
import { costUsd, hasKnownPrice } from "../llm/pricing.js";
import { judgePersona } from "../panel/judge.js";
import { describeIdea, PANEL_SCHEMA, panelZ, singlePromptSystem } from "../panel/prompts.js";
import type { Store } from "../store/store.js";
import { evalKey } from "../store/store.js";
import type { IdeaBrief } from "../types.js";
import type { Condition, EvalItem, EvalJudgment } from "./types.js";

export interface EvalRunOptions {
  store: Store;
  runId: string;
  items: EvalItem[];
  personas: readonly Persona[];
  conditions: Condition[];
  /** Provider used for baseline and panel conditions. */
  primary: LLMProvider;
  /** Providers rotated through in the mixed condition. */
  mixedProviders: LLMProvider[];
  concurrency: number;
  budgetUsd: number;
  log?: (msg: string) => void;
}

type Job = { kind: "baseline"; item: EvalItem } | { kind: "persona"; condition: "panel" | "mixed"; item: EvalItem; persona: Persona; provider: LLMProvider };

export function toBrief(item: EvalItem): IdeaBrief {
  return {
    title: "Startup idea (company name withheld)",
    description: item.text,
    targetAudience: item.meta.industries ? `Industry: ${item.meta.industries}` : "",
    pricingModel: "",
    competitors: "",
    sliders: { reach: 5, buildCost: 5, userImportance: 5, complexity: 5, value: 5, risk: 5 }, // not shown (includeSliders: false)
  };
}

export function buildJobs(o: Pick<EvalRunOptions, "items" | "personas" | "conditions" | "primary" | "mixedProviders" | "runId">, done: Set<string>): Job[] {
  const jobs: Job[] = [];
  for (const item of o.items) {
    for (const condition of o.conditions) {
      if (condition === "baseline") {
        const key = evalKey({ runId: o.runId, condition, itemId: item.id, personaId: o.personas[0].id });
        if (!done.has(key)) jobs.push({ kind: "baseline", item });
        continue;
      }
      o.personas.forEach((persona, i) => {
        if (done.has(evalKey({ runId: o.runId, condition, itemId: item.id, personaId: persona.id }))) return;
        const provider = condition === "mixed" ? o.mixedProviders[i % o.mixedProviders.length] : o.primary;
        jobs.push({ kind: "persona", condition, item, persona, provider });
      });
    }
  }
  return jobs;
}

export async function runEval(o: EvalRunOptions): Promise<{ jobs: number; spentUsd: number; stoppedForBudget: boolean; failures: number }> {
  const log = o.log ?? console.log;
  const done = await o.store.evalDoneKeys(o.runId);
  const jobs = buildJobs(o, done);
  log(`run "${o.runId}": ${o.items.length} items x [${o.conditions.join(", ")}] — ${done.size} judgments already stored, ${jobs.length} jobs to do.`);

  for (const p of [o.primary, ...o.mixedProviders]) {
    if (!hasKnownPrice(p.model)) log(`warning: no price known for ${p.model}; its cost counts as $0 against the budget. Set MODEL_PRICES in .env.`);
  }

  const controller = new AbortController();
  let spent = 0;
  let finished = 0;
  let failures = 0;
  let stoppedForBudget = false;
  const charge = (usd: number | null) => {
    spent += usd ?? 0;
    if (spent >= o.budgetUsd && !stoppedForBudget) {
      stoppedForBudget = true;
      log(`budget cap $${o.budgetUsd.toFixed(2)} reached ($${spent.toFixed(3)} spent) — stopping new work. Re-run with a higher --budget-usd to continue where this left off.`);
      controller.abort(new Error("budget"));
    }
  };

  const now = () => new Date().toISOString();

  await runPool(
    jobs,
    async (job) => {
      if (job.kind === "baseline") {
        let out: EvalJudgment[];
        try {
          out = await runBaseline(o, job.item, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) return; // budget stop — leave undone for resume
          failures++;
          out = o.personas.map((p) => failed(o.runId, "baseline", job.item, p, o.primary, err));
        }
        charge(out.reduce<number>((s, j) => s + (j.costUsd ?? 0), 0));
        await o.store.saveEvalJudgments(out);
      } else {
        let j: EvalJudgment;
        try {
          const r = await judgePersona(job.provider, job.persona, toBrief(job.item), o.personas.length, { includeSliders: false, signal: controller.signal });
          j = {
            runId: o.runId,
            condition: job.condition,
            itemId: job.item.id,
            label: job.item.label,
            personaId: job.persona.id,
            category: job.persona.category,
            ok: true,
            verdict: r.verdict,
            score: r.score,
            topConcern: r.topConcern,
            provider: r.provider,
            model: r.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            costUsd: r.costUsd,
            createdAt: now(),
          };
        } catch (err) {
          if (controller.signal.aborted) return; // budget stop — leave it undone so a resume picks it up
          failures++;
          j = failed(o.runId, job.condition, job.item, job.persona, job.provider, err);
        }
        charge(j.costUsd);
        await o.store.saveEvalJudgments([j]);
      }
      finished++;
      if (finished % 25 === 0 || finished === jobs.length) log(`  ${finished}/${jobs.length} jobs · $${spent.toFixed(3)} spent · ${failures} failed`);
    },
    { concurrency: o.concurrency, signal: controller.signal },
  );

  return { jobs: finished, spentUsd: spent, stoppedForBudget, failures };
}

async function runBaseline(o: EvalRunOptions, item: EvalItem, signal: AbortSignal): Promise<EvalJudgment[]> {
  const res = await callStructured(
    o.primary,
    {
      system: singlePromptSystem(o.personas),
      user: `Here is the idea:\n\n${describeIdea(toBrief(item), { includeSliders: false })}\n\nGive every persona's verdict.`,
      schemaName: "submit_panel",
      schemaDescription: "Submit one judgment per persona.",
      schema: PANEL_SCHEMA,
      maxTokens: 12_000,
      signal,
    },
    panelZ,
  );
  const byId = new Map(res.value.judgments.map((j) => [j.personaId, j]));
  const totalCost = costUsd(o.primary.model, res.usage);
  // One call's cost/tokens are attributed evenly across personas so per-condition totals add up.
  const share = (n: number) => n / o.personas.length;
  return o.personas.map((p) => {
    const j = byId.get(p.id);
    return {
      runId: o.runId,
      condition: "baseline" as const,
      itemId: item.id,
      label: item.label,
      personaId: p.id,
      category: p.category,
      ok: !!j,
      verdict: j?.verdict,
      score: j?.score,
      topConcern: j?.topConcern,
      error: j ? undefined : "persona missing from single-prompt output",
      provider: o.primary.name,
      model: o.primary.model,
      inputTokens: share(res.usage.inputTokens),
      outputTokens: share(res.usage.outputTokens),
      costUsd: totalCost === null ? null : share(totalCost),
      createdAt: new Date().toISOString(),
    };
  });
}

function failed(runId: string, condition: Condition, item: EvalItem, p: Persona, provider: LLMProvider, err: unknown): EvalJudgment {
  return {
    runId,
    condition,
    itemId: item.id,
    label: item.label,
    personaId: p.id,
    category: p.category,
    ok: false,
    error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    provider: provider.name,
    model: provider.model,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    createdAt: new Date().toISOString(),
  };
}
