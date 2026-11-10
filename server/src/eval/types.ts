export type Condition = "baseline" | "panel" | "mixed";

export const CONDITION_LABELS: Record<Condition, string> = {
  baseline: "Single prompt, all personas in one call",
  panel: "Independent panel, one model",
  mixed: "Independent panel, models mixed",
};

/** One labeled idea from a dataset with a known outcome. */
export interface EvalItem {
  id: string;
  text: string; // anonymized description shown to the judges
  label: 0 | 1; // 1 = success (by the dataset's definition), 0 = failure
  meta: Record<string, string>;
}

/** One persona's judgment of one item under one condition. Keyed by (runId, condition, itemId, personaId). */
export interface EvalJudgment {
  runId: string;
  condition: Condition;
  itemId: string;
  label: 0 | 1;
  personaId: string;
  category: string;
  ok: boolean;
  verdict?: "build" | "maybe" | "dont_build";
  score?: number;
  topConcern?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error?: string;
  createdAt: string;
}
