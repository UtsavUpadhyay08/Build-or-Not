/**
 * Turns stored eval judgments into the results: per-condition metrics, paired comparisons with
 * bootstrap confidence intervals, the panel-size curve, and a per-provider breakdown.
 */
import { mean, successProbability } from "../panel/aggregate.js";
import type { Condition, EvalJudgment } from "./types.js";
import { CONDITION_LABELS } from "./types.js";
import { auc, bootstrapAucDiff, brier, ece, panelDiversity, panelSizeCurve } from "./metrics.js";

export interface ConditionResult {
  condition: Condition;
  items: number;
  auc: number;
  brier: number;
  ece: number;
  scoreStdDev: number;
  verdictEntropy: number;
  concernDiversity: number;
  failureRate: number;
  costPerItemUsd: number;
  sizeCurve: { k: number; auc: number }[];
  byProvider: { provider: string; auc: number; items: number }[];
}

export interface EvalReport {
  runId: string;
  generatedAt: string;
  totalItems: number;
  conditions: ConditionResult[];
  comparisons: { a: Condition; b: Condition; items: number; diff: number; lo: number; hi: number }[];
}

type ItemAgg = { itemId: string; label: 0 | 1; ok: EvalJudgment[]; all: EvalJudgment[] };

function groupByItem(js: EvalJudgment[]): Map<string, ItemAgg> {
  const m = new Map<string, ItemAgg>();
  for (const j of js) {
    let g = m.get(j.itemId);
    if (!g) m.set(j.itemId, (g = { itemId: j.itemId, label: j.label, ok: [], all: [] }));
    g.all.push(j);
    if (j.ok && j.score !== undefined && j.verdict) g.ok.push(j);
  }
  return m;
}

const SIZES = [1, 3, 5, 9, 15, 25, 35, 45];

export function buildReport(runId: string, judgments: EvalJudgment[], quorum = 0.8, personaCount = 45): EvalReport {
  const conditions = (["baseline", "panel", "mixed"] as Condition[]).filter((c) => judgments.some((j) => j.condition === c));
  const usable = new Map<Condition, Map<string, ItemAgg>>();

  const results: ConditionResult[] = conditions.map((condition) => {
    const js = judgments.filter((j) => j.condition === condition);
    const items = [...groupByItem(js).values()].filter((g) => g.ok.length >= quorum * personaCount);
    usable.set(condition, new Map(items.map((g) => [g.itemId, g])));

    const labels = items.map((g) => g.label);
    const probs = items.map((g) => successProbability(g.ok as any));
    const div = items.map((g) => panelDiversity(g.ok as any));

    const providers = [...new Set(js.map((j) => `${j.provider}/${j.model}`))];
    const byProvider =
      providers.length > 1
        ? providers.map((prov) => {
            const sub = items.map((g) => g.ok.filter((j) => `${j.provider}/${j.model}` === prov)).filter((s) => s.length > 0);
            const subLabels = items.filter((g) => g.ok.some((j) => `${j.provider}/${j.model}` === prov)).map((g) => g.label);
            return { provider: prov, items: sub.length, auc: auc(sub.map((s) => successProbability(s as any)), subLabels) };
          })
        : [];

    return {
      condition,
      items: items.length,
      auc: auc(probs, labels),
      brier: brier(probs, labels),
      ece: ece(probs, labels),
      scoreStdDev: div.length ? mean(div.map((d) => d.scoreStdDev)) : NaN,
      verdictEntropy: div.length ? mean(div.map((d) => d.verdictEntropy)) : NaN,
      concernDiversity: div.length ? mean(div.map((d) => d.concernDiversity)) : NaN,
      failureRate: js.length ? js.filter((j) => !j.ok).length / js.length : 0,
      costPerItemUsd: items.length ? js.reduce((s, j) => s + (j.costUsd ?? 0), 0) / new Set(js.map((j) => j.itemId)).size : 0,
      sizeCurve: panelSizeCurve(
        items.map((g) => g.ok.map((j) => j.score!)),
        labels,
        SIZES.filter((k) => k <= personaCount),
      ),
      byProvider,
    };
  });

  const pairs: [Condition, Condition][] = [
    ["panel", "baseline"],
    ["mixed", "baseline"],
    ["mixed", "panel"],
  ];
  const comparisons = pairs
    .filter(([a, b]) => usable.has(a) && usable.has(b))
    .map(([a, b]) => {
      const A = usable.get(a)!;
      const B = usable.get(b)!;
      const shared = [...A.keys()].filter((id) => B.has(id)); // paired: only items both conditions completed
      const labels = shared.map((id) => A.get(id)!.label);
      const r = bootstrapAucDiff(
        shared.map((id) => successProbability(A.get(id)!.ok as any)),
        shared.map((id) => successProbability(B.get(id)!.ok as any)),
        labels,
      );
      return { a, b, items: shared.length, ...r };
    });

  return { runId, generatedAt: new Date().toISOString(), totalItems: new Set(judgments.map((j) => j.itemId)).size, conditions: results, comparisons };
}

const f = (n: number, dp = 3) => (Number.isFinite(n) ? n.toFixed(dp) : "n/a");

export function reportMarkdown(r: EvalReport): string {
  const L: string[] = [];
  L.push(`# Build or Not eval — ${r.runId}`, "", `Generated ${r.generatedAt}. ${r.totalItems} items with known outcomes.`, "");
  L.push("## Headline", "");
  L.push("| Condition | Items | AUC ↑ | Brier ↓ | ECE ↓ | Score SD | Verdict entropy | Concern diversity | Failure rate | $ / item |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of r.conditions) {
    L.push(
      `| ${CONDITION_LABELS[c.condition]} | ${c.items} | ${f(c.auc)} | ${f(c.brier)} | ${f(c.ece)} | ${f(c.scoreStdDev, 2)} | ${f(c.verdictEntropy)} | ${f(c.concernDiversity)} | ${(c.failureRate * 100).toFixed(1)}% | $${f(c.costPerItemUsd, 4)} |`,
    );
  }
  L.push("", "AUC 0.5 = coin flip. Brier 0.25 = always predicting 50%. Diversity columns: higher = the personas actually disagreed / said different things.", "");

  if (r.comparisons.length) {
    L.push("## Is the difference real? (paired bootstrap, 95% CI)", "");
    L.push("| Comparison | Paired items | ΔAUC | 95% CI | Verdict |", "|---|---|---|---|---|");
    for (const c of r.comparisons) {
      const sig = c.lo > 0 ? `**${c.a} better**` : c.hi < 0 ? `**${c.b} better**` : "not distinguishable from noise";
      L.push(`| ${c.a} vs ${c.b} | ${c.items} | ${f(c.diff)} | [${f(c.lo)}, ${f(c.hi)}] | ${sig} |`);
    }
    L.push("");
  }

  L.push("## Why 45? AUC by panel size", "", "Computed by subsampling stored judgments — no extra API calls.", "");
  const ks = r.conditions[0]?.sizeCurve.map((p) => p.k) ?? [];
  L.push(`| Condition | ${ks.map((k) => `k=${k}`).join(" | ")} |`, `|---|${ks.map(() => "---").join("|")}|`);
  for (const c of r.conditions) L.push(`| ${c.condition} | ${c.sizeCurve.map((p) => f(p.auc)).join(" | ")} |`);
  L.push("");

  const mixed = r.conditions.find((c) => c.byProvider.length);
  if (mixed) {
    L.push("## Inside the mixed panel: each provider's personas alone", "", "If mixed beats every single provider here, the gain comes from diversity, not from one strong model.", "");
    L.push("| Provider | Items | AUC |", "|---|---|---|");
    for (const p of mixed.byProvider) L.push(`| ${p.provider} | ${p.items} | ${f(p.auc)} |`);
    L.push("");
  }

  L.push(
    "## Threats to validity",
    "",
    "- **Memorization**: models may know some companies' outcomes. Names/domains are stripped and YC top companies excluded, but leakage can't be ruled out. It affects all conditions on the same items, so differences between conditions are more trustworthy than absolute AUC.",
    "- **Hindsight in descriptions**: surviving companies update their descriptions; dead ones don't. Writing quality can leak the label.",
    "- **Label definition**: 'alive' counts zombies as successes and acqui-hires as exits. Re-run with `--label exit` as a sensitivity check.",
    "- **Same personas, same aggregation** across conditions: the only manipulated variable is whether judgments are produced independently.",
  );
  return L.join("\n");
}
