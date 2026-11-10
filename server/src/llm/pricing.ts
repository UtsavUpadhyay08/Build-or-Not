/**
 * Approximate list prices in USD per 1M tokens [input, output]. Used for the per-idea cost shown
 * in the dashboard and for the eval budget cap. Prices change — verify against each provider's
 * pricing page, or override with MODEL_PRICES='{"model-name":[in,out]}' in .env.
 * Unknown models report cost as null (tokens are still counted).
 */
import type { Usage } from "./types.js";

const DEFAULT_PRICES: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-4-5": [3, 15],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4o-mini": [0.15, 0.6],
  "gemini-2.5-flash": [0.3, 2.5],
  "gemini-2.5-flash-lite": [0.1, 0.4],
  "mock-a": [0, 0],
  "mock-b": [0, 0],
  "mock-c": [0, 0],
};

function loadOverrides(): Record<string, [number, number]> {
  try {
    return process.env.MODEL_PRICES ? JSON.parse(process.env.MODEL_PRICES) : {};
  } catch {
    console.warn("MODEL_PRICES is not valid JSON — ignoring it");
    return {};
  }
}

const PRICES = { ...DEFAULT_PRICES, ...loadOverrides() };

/** Free-tier model ids (OpenRouter ":free", OpenCode Zen "-free") cost nothing. */
const isFreeModel = (model: string) => /:free$|-free$|^big-pickle$/.test(model);

export function costUsd(model: string, usage: Usage): number | null {
  if (isFreeModel(model)) return 0;
  const p = PRICES[model];
  if (!p) return null;
  return (usage.inputTokens * p[0] + usage.outputTokens * p[1]) / 1_000_000;
}

export function hasKnownPrice(model: string): boolean {
  return isFreeModel(model) || model in PRICES;
}
