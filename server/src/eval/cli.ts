/**
 * Eval CLI.
 *
 *   npm run eval -- fetch-yc
 *   npm run eval -- run --run-id yc-200 --n 200 --budget-usd 15
 *   npm run eval -- run --run-id yc-200 --n 200 --budget-usd 25   # resumes, same items (same seed)
 *   npm run eval -- report --run-id yc-200
 *
 * Options for `run`:
 *   --dataset yc|csv           (default yc)
 *   --file <path>              dataset file (default eval-data/yc.json)
 *   --n <int>                  balanced sample size (default 100)
 *   --seed <int>               sampling seed (default 42) — keep it fixed to resume the same items
 *   --conditions a,b,c         subset of baseline,panel,mixed (default: all that are possible)
 *   --label alive|exit         YC label definition (default alive)
 *   --from 2012 --to 2020      YC batch year window
 *   --budget-usd <num>         hard stop (default 5)
 *   --concurrency <int>        (default PANEL_CONCURRENCY)
 *   CSV only: --text-cols a,b --label-col state --positive successful --negative failed [--id-col ID]
 */
import "../env.js";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { config, MOCK_MODE } from "../config.js";
import { PERSONAS } from "../personas.js";
import { hasUsableProvider, panelProviders, primaryProvider, runHealthChecks } from "../llm/registry.js";
import { MongoStore } from "../store/mongoStore.js";
import { balancedSample, downloadYC, loadCsv, loadYC, type LabelMode } from "./datasets.js";
import { runEval } from "./runEval.js";
import { buildReport, reportMarkdown } from "./report.js";
import type { Condition } from "./types.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = path.join(serverRoot, "eval-data");
const reportDir = path.join(serverRoot, "eval-reports");

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values: a } = parseArgs({
    args: rest,
    options: {
      "run-id": { type: "string" },
      dataset: { type: "string", default: "yc" },
      file: { type: "string" },
      n: { type: "string", default: "100" },
      seed: { type: "string", default: "42" },
      conditions: { type: "string" },
      label: { type: "string", default: "alive" },
      from: { type: "string", default: "2012" },
      to: { type: "string", default: "2020" },
      "budget-usd": { type: "string", default: "5" },
      concurrency: { type: "string" },
      "text-cols": { type: "string" },
      "label-col": { type: "string" },
      positive: { type: "string" },
      negative: { type: "string" },
      "id-col": { type: "string" },
    },
  });

  if (command === "fetch-yc") {
    fs.mkdirSync(dataDir, { recursive: true });
    const dest = path.join(dataDir, "yc.json");
    const n = await downloadYC(dest);
    console.log(`Saved ${n} YC companies to ${dest}`);
    return;
  }

  if (command !== "run" && command !== "report") {
    console.log("Usage: npm run eval -- <fetch-yc | run | report> [options]  (see src/eval/cli.ts for options)");
    process.exit(1);
  }

  const runId = a["run-id"];
  if (!runId) throw new Error("--run-id is required");
  const store = await MongoStore.connect(config.mongoUri);

  try {
    if (command === "run") {
      const items =
        a.dataset === "csv"
          ? loadCsv(required(a.file, "--file"), {
              textCols: required(a["text-cols"], "--text-cols").split(","),
              labelCol: required(a["label-col"], "--label-col"),
              positive: required(a.positive, "--positive").toLowerCase().split(","),
              negative: required(a.negative, "--negative").toLowerCase().split(","),
              idCol: a["id-col"],
            })
          : loadYC(a.file ?? path.join(dataDir, "yc.json"), { labelMode: a.label as LabelMode, fromYear: Number(a.from), toYear: Number(a.to) });

      const sample = balancedSample(items, Number(a.n), Number(a.seed));
      if (!MOCK_MODE) {
        for (const h of await runHealthChecks()) console.log(`  [${h.status === "ok" ? "OK  " : "FAIL"}] ${h.name}/${h.model} key ${h.keyHint}${h.status === "ok" ? "" : " — " + h.message}`);
        if (!hasUsableProvider()) throw new Error("No working provider — fix the keys in .env first (nothing was spent).");
      }
      const providers = panelProviders();
      let conditions = (a.conditions?.split(",") ?? ["baseline", "panel", "mixed"]) as Condition[];
      if (conditions.includes("mixed") && providers.length < 2) {
        console.log("Skipping 'mixed': it needs at least two providers configured (set two of ANTHROPIC/OPENAI/GEMINI keys).");
        conditions = conditions.filter((c) => c !== "mixed");
      }
      if (MOCK_MODE) console.log("NOTE: MOCK MODE — scores are random placeholders; expect AUC ≈ 0.5. This only tests the pipeline.");
      console.log(`Dataset: ${items.length} eligible items -> balanced sample of ${sample.length} (seed ${a.seed}).`);

      const result = await runEval({
        store,
        runId,
        items: sample,
        personas: PERSONAS,
        conditions,
        primary: primaryProvider(),
        mixedProviders: providers,
        concurrency: Number(a.concurrency ?? config.concurrency),
        budgetUsd: Number(a["budget-usd"]),
      });
      console.log(`Done: ${result.jobs} jobs, $${result.spentUsd.toFixed(3)} spent, ${result.failures} failed${result.stoppedForBudget ? " (stopped at budget cap)" : ""}.`);
      for (const p of providers) console.log(`  ${p.name}/${p.model}: ${p.stats.calls} calls, ${p.stats.retries} retries, ${p.stats.rateLimited} rate-limited, ${p.stats.failures} gave up`);
    }

    const judgments = await store.getEvalJudgments(runId);
    if (judgments.length === 0) throw new Error(`No judgments stored for run "${runId}".`);
    const report = buildReport(runId, judgments, config.quorum, PERSONAS.length);
    fs.mkdirSync(reportDir, { recursive: true });
    const base = path.join(reportDir, runId.replace(/[^\w.-]/g, "_"));
    fs.writeFileSync(`${base}.md`, reportMarkdown(report));
    fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${base}.md\n`);
    for (const c of report.conditions) console.log(`  ${c.condition.padEnd(8)} AUC ${c.auc.toFixed(3)}  Brier ${c.brier.toFixed(3)}  items ${c.items}`);
  } finally {
    await store.close();
  }
}

function required(v: string | undefined, name: string): string {
  if (!v) throw new Error(`${name} is required for this dataset`);
  return v;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
