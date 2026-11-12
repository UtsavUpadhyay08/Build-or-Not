import type { SendPlan } from "./llm/capacity.js";
/** Shared shapes used across the server. Mirrored by hand in client/src/types.ts — keep in sync. */

export type Verdict = "build" | "maybe" | "dont_build";

/** The six dont.build-style sliders, each 1 (low) to 10 (high). */
export interface IdeaSliders {
  reach: number;
  buildCost: number;
  userImportance: number;
  complexity: number;
  value: number;
  risk: number;
}

export interface IdeaBrief {
  title: string;
  description: string;
  targetAudience: string;
  pricingModel: string;
  competitors: string;
  sliders: IdeaSliders;
  /** "startup": a new product. "feature": a new feature for a product that already exists. Missing = startup. */
  kind?: IdeaKind;
  /** Feature mode: what the existing product is (usually the visitor's description.md). */
  productContext?: string;
  /**
   * Private run: left out of every public list, and only the browser holding the owner token can
   * open it (anyone else, link or not, gets "not found"). Missing = public.
   */
  hidden?: boolean;
}

export type IdeaKind = "startup" | "feature";
/** Product descriptions go to all 45 personas, so they're kept short (about 1,500 tokens). */
export const PRODUCT_CONTEXT_MAX = 6000;

export type IdeaStatus = "running" | "completed" | "failed";

export interface IdeaRecord extends IdeaBrief {
  id: string;
  createdAt: string;
  status: IdeaStatus;
  mock: boolean;
  panelMode: "single" | "mixed";
  personaLibraryVersion: string;
  /** Providers the user picked for this run (single: one name; mixed: two or more). Empty = defaults. */
  providers?: string[];
  /** How the run was sized to the keys' limits: how many calls started at once, and how fast the rest followed. */
  sendPlan?: SendPlan;
  /** "free": the site's own key. "own": the visitor's key, used for this run only and never stored. */
  keyMode?: "free" | "own";
  /** sha256 of the submitter's delete token. Never sent to clients (see publicIdea). */
  ownerHash?: string;
  /** The account that ran it, when signed in. Never sent to clients (see publicIdea). */
  userId?: string;
  /** Set only in answers to its owner (never stored): "this one is yours". */
  yours?: boolean;
  error?: string | null;
}

/** What the API shows about an idea: everything except the owner hash. */
export function publicIdea(idea: IdeaRecord): Omit<IdeaRecord, "ownerHash" | "userId"> {
  const { ownerHash: _drop, userId: _account, ...rest } = idea;
  return rest;
}

export interface CallMeta {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  repaired: boolean; // first answer failed validation, re-ask fixed it
}

export interface PersonaVerdict extends CallMeta {
  ideaId: string;
  personaId: string;
  verdict: Verdict;
  score: number; // 1-10
  reasoning: string;
  topConcern: string;
  topAppeal: string;
  /** The smallest change that would raise this persona's score, in their words. "" on old records. */
  fix?: string;
  createdAt: string;
}

/** A persona whose call failed after all retries. Stored so the UI can show the gap honestly. */
export type FailureKind = "rate_limit" | "daily_quota" | "timeout" | "network" | "server_error" | "bad_key" | "no_credit" | "bad_model" | "bad_output" | "cooling" | "unknown";

export interface PersonaFailure {
  ideaId: string;
  personaId: string;
  provider: string;
  model: string;
  error: string;
  /** Plain-language category, so the UI can explain why this persona "went home". */
  kind?: FailureKind;
  status?: number | null;
  /** How many requests were made before giving up (retries included). */
  attempts?: number;
  createdAt: string;
}

export interface ThemeCluster {
  theme: string;
  mentionCount: number;
  example: string;
}

export interface GroupStat {
  key: string;
  n: number;
  meanScore: number;
}

/** How much the panel disagreed — the thing a single prompt can't honestly give you. */
export interface Disagreement {
  scoreStdDev: number; // spread of 1-10 scores
  verdictEntropy: number; // 0 = unanimous, 1 = perfectly split across build/maybe/dont_build
  agreement: number; // share of the most common verdict, 0.33..1
  confidence: "high" | "medium" | "low";
  byCategory: GroupStat[];
  byProvider: GroupStat[];
}

export interface Synthesis {
  ideaId: string;
  overallVerdict: Verdict;
  overallScore: number; // 0-100
  counts: { build: number; maybe: number; dont_build: number };
  judged: number;
  failed: number;
  disagreement: Disagreement;
  topConcerns: ThemeCluster[];
  topAppeals: ThemeCluster[];
  summary: string;
  themesAvailable: boolean; // false if the synthesis LLM call failed — numbers are still valid
  cost: { inputTokens: number; outputTokens: number; usd: number | null };
  createdAt: string;
}

export interface IdeaFullState {
  idea: IdeaRecord;
  verdicts: PersonaVerdict[];
  failures: PersonaFailure[];
  synthesis: Synthesis | null;
  totalPersonas: number;
}
