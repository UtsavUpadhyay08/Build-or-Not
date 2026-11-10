/**
 * Evaluation metrics. All pure functions, all unit-tested against hand-computed values.
 *
 *  AUC     — probability a random success is scored above a random failure. 0.5 = coin flip.
 *            Computed via Mann-Whitney U with average ranks for ties (O(n log n)).
 *  Brier   — mean squared error of the predicted probability. 0 = perfect, 0.25 = always saying 0.5.
 *  ECE     — expected calibration error: within bins of predicted probability, how far is the
 *            average prediction from the actual success rate?
 *  Diversity — does the panel actually produce different opinions? Score SD, verdict entropy, and
 *            lexical diversity of concerns (1 - mean pairwise Jaccard similarity of word sets).
 */
import { mean, stdDev, verdictEntropy, countVerdicts, type Scored } from "../panel/aggregate.js";
import { seededRandom } from "./datasets.js";

export function auc(scores: readonly number[], labels: readonly (0 | 1)[]): number {
  const n = scores.length;
  const nPos = labels.filter((l) => l === 1).length;
  const nNeg = n - nPos;
  if (nPos === 0 || nNeg === 0) return NaN;

  const idx = [...scores.keys()].sort((a, b) => scores[a] - scores[b]);
  const ranks = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based average rank for the tie group
    for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
    i = j + 1;
  }
  let rankSumPos = 0;
  for (let i = 0; i < n; i++) if (labels[i] === 1) rankSumPos += ranks[i];
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

export function brier(probs: readonly number[], labels: readonly (0 | 1)[]): number {
  if (probs.length === 0) return NaN;
  return mean(probs.map((p, i) => (p - labels[i]) ** 2));
}

export function ece(probs: readonly number[], labels: readonly (0 | 1)[], bins = 10): number {
  const n = probs.length;
  if (n === 0) return NaN;
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = probs.map((p, i) => i).filter((i) => probs[i] >= lo && (b === bins - 1 ? probs[i] <= hi : probs[i] < hi));
    if (inBin.length === 0) continue;
    const conf = mean(inBin.map((i) => probs[i]));
    const acc = mean(inBin.map((i) => labels[i]));
    total += (inBin.length / n) * Math.abs(conf - acc);
  }
  return total;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 1 - mean pairwise Jaccard similarity. 0 = everyone said the same words, 1 = no overlap at all. */
export function lexicalDiversity(texts: readonly string[]): number {
  const sets = texts.map(words);
  if (sets.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) {
      sum += jaccard(sets[i], sets[j]);
      pairs++;
    }
  return 1 - sum / pairs;
}

export function panelDiversity(js: readonly (Scored & { topConcern?: string })[]) {
  return {
    scoreStdDev: stdDev(js.map((j) => j.score)),
    verdictEntropy: verdictEntropy(countVerdicts(js)),
    concernDiversity: lexicalDiversity(js.map((j) => j.topConcern ?? "")),
  };
}

/**
 * Paired bootstrap CI for AUC(a) - AUC(b) over the SAME items. Resample items with replacement,
 * recompute both AUCs, take the 2.5/97.5 percentiles of the difference. If the interval excludes
 * 0, the difference is unlikely to be noise from which items happened to be sampled.
 */
export function bootstrapAucDiff(a: readonly number[], b: readonly number[], labels: readonly (0 | 1)[], iterations = 2000, seed = 7): { diff: number; lo: number; hi: number } {
  const rand = seededRandom(seed);
  const n = labels.length;
  const diffs: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const s: number[] = Array.from({ length: n }, () => Math.floor(rand() * n));
    const la = s.map((i) => labels[i]);
    const d = auc(s.map((i) => a[i]), la) - auc(s.map((i) => b[i]), la);
    if (!Number.isNaN(d)) diffs.push(d);
  }
  diffs.sort((x, y) => x - y);
  const q = (p: number) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor(p * diffs.length)))];
  return { diff: auc(a, labels) - auc(b, labels), lo: q(0.025), hi: q(0.975) };
}

/**
 * "Why 45?" curve without spending a single extra API call: for panel size k, score every item
 * using only a random k of its persona judgments, compute AUC, and average over many random draws.
 */
export function panelSizeCurve(
  perItemScores: readonly number[][], // perItemScores[item] = 1-10 scores from each persona that judged it
  labels: readonly (0 | 1)[],
  sizes: readonly number[],
  draws = 200,
  seed = 11,
): { k: number; auc: number }[] {
  const rand = seededRandom(seed);
  return sizes.map((k) => {
    const aucs: number[] = [];
    for (let d = 0; d < draws; d++) {
      const preds = perItemScores.map((scores) => {
        if (scores.length <= k) return mean(scores);
        // partial Fisher-Yates: k distinct random picks
        const pool = [...scores];
        for (let i = 0; i < k; i++) {
          const j = i + Math.floor(rand() * (pool.length - i));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return mean(pool.slice(0, k));
      });
      const a = auc(preds, labels);
      if (!Number.isNaN(a)) aucs.push(a);
    }
    return { k, auc: aucs.length ? mean(aucs) : NaN };
  });
}
