/**
 * Pure aggregation math — no I/O, fully unit-tested. Shared by the live app and the eval module,
 * so "what the dashboard shows" and "what the benchmark measures" are computed identically.
 */
import type { Disagreement, GroupStat, Verdict } from "../types.js";

export interface Scored {
  verdict: Verdict;
  score: number; // 1-10
}

export type Counts = { build: number; maybe: number; dont_build: number };

export function countVerdicts(vs: readonly Scored[]): Counts {
  const c: Counts = { build: 0, maybe: 0, dont_build: 0 };
  for (const v of vs) c[v.verdict]++;
  return c;
}

/** Mean of 1-10 scores rescaled to 0-100. */
export function computeOverallScore(vs: readonly Scored[]): number {
  if (vs.length === 0) return 0;
  const avg = mean(vs.map((v) => v.score));
  return Math.round(((avg - 1) / 9) * 100);
}

/** Same thing as a probability in [0,1] — what the eval module scores with AUC/Brier. */
export function successProbability(vs: readonly Scored[]): number {
  if (vs.length === 0) return 0.5;
  return (mean(vs.map((v) => v.score)) - 1) / 9;
}

export function computeOverallVerdict(counts: Counts, overallScore: number): Verdict {
  const total = counts.build + counts.maybe + counts.dont_build;
  if (total === 0) return "maybe";
  if (counts.build / total >= 0.55 && overallScore >= 55) return "build";
  if (counts.dont_build / total >= 0.45 || overallScore < 35) return "dont_build";
  return "maybe";
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation. */
export function stdDev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Shannon entropy of the verdict distribution, normalized by log(3): 0 = unanimous, 1 = even three-way split. */
export function verdictEntropy(counts: Counts): number {
  const total = counts.build + counts.maybe + counts.dont_build;
  if (total === 0) return 0;
  let h = 0;
  for (const n of Object.values(counts)) {
    if (n === 0) continue;
    const p = n / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(3);
}

export function groupStats<T extends Scored>(vs: readonly T[], keyOf: (v: T) => string): GroupStat[] {
  const groups = new Map<string, number[]>();
  for (const v of vs) {
    const k = keyOf(v);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(v.score);
  }
  return [...groups.entries()].map(([key, scores]) => ({ key, n: scores.length, meanScore: round(mean(scores), 2) })).sort((a, b) => b.meanScore - a.meanScore);
}

export function computeDisagreement<T extends Scored>(vs: readonly T[], categoryOf: (v: T) => string, providerOf: (v: T) => string): Disagreement {
  const counts = countVerdicts(vs);
  const total = vs.length || 1;
  const entropy = verdictEntropy(counts);
  const sd = stdDev(vs.map((v) => v.score));
  const agreement = Math.max(counts.build, counts.maybe, counts.dont_build) / total;
  // Thresholds are heuristics, documented so they can be argued with: a 1-10 score SD above ~2.5
  // or near-even verdict splits mean the headline verdict shouldn't be trusted on its own.
  const confidence: Disagreement["confidence"] = entropy < 0.55 && sd < 1.8 ? "high" : entropy > 0.85 || sd > 2.5 ? "low" : "medium";
  return {
    scoreStdDev: round(sd, 2),
    verdictEntropy: round(entropy, 3),
    agreement: round(agreement, 3),
    confidence,
    byCategory: groupStats(vs, categoryOf),
    byProvider: groupStats(vs, providerOf),
  };
}

/** Did enough of the panel answer for the verdict to mean anything? */
export function meetsQuorum(judged: number, total: number, quorum: number): boolean {
  return total > 0 && judged / total >= quorum;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
