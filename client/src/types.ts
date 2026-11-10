/** Mirrors server/src/types.ts by hand — this is a small, standalone app (two independent
 * packages, no shared-types package), so duplication here is a deliberate, cheap tradeoff
 * against monorepo machinery for a project this size. Keep both copies in sync. */

export type Verdict = "build" | "maybe" | "dont_build";

export interface IdeaSliders {
  reach: number;
  buildCost: number;
  userImportance: number;
  complexity: number;
  value: number;
  risk: number;
}

export const SLIDER_FIELDS: { key: keyof IdeaSliders; label: string; low: string; high: string }[] = [
  { key: "reach", label: "How many would use it", low: "Very few", high: "Almost everyone" },
  { key: "buildCost", label: "Cost to build", low: "Quick and cheap", high: "Slow and costly" },
  { key: "userImportance", label: "How important these users are", low: "Minor users", high: "Your most important users" },
  { key: "complexity", label: "Effort to keep it running", low: "Easy", high: "Hard" },
  { key: "value", label: "How much it helps", low: "Nice to have", high: "Fixes a real pain" },
  { key: "risk", label: "Risk it won’t work", low: "Low", high: "High" },
];

export interface IdeaBrief {
  title: string;
  description: string;
  targetAudience: string;
  pricingModel: string;
  competitors: string;
  sliders: IdeaSliders;
}

export type IdeaStatus = "running" | "completed" | "failed";

export type PanelMode = "single" | "mixed";

export interface IdeaRecord extends IdeaBrief {
  id: string;
  createdAt: string;
  status: IdeaStatus;
  mock: boolean;
  panelMode: PanelMode;
  personaLibraryVersion: string;
  providers?: string[];
  sendPlan?: SendPlan;
  /** "free": the site's key. "own": the submitter's own key (never stored). */
  keyMode?: "free" | "own";
  error?: string | null;
}

/** Runs this visitor has left today. */
export interface Quota {
  site: { kind: "free" | "sim"; limit: number; used: number; left: number };
  own: { allowed: boolean; limit: number; used: number; left: number };
  resetsAt: string;
}

/** A key the visitor pasted. Lives in this browser only; sent with their own runs and nowhere else. */
export interface OwnKey {
  provider: string;
  apiKey: string;
  model: string;
  capacity: Capacity;
}

export interface CallMeta {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  repaired: boolean;
}

export type FailureKind = "rate_limit" | "daily_quota" | "timeout" | "network" | "server_error" | "bad_key" | "no_credit" | "bad_model" | "bad_output" | "cooling" | "unknown";

export interface PersonaFailure {
  ideaId: string;
  personaId: string;
  provider: string;
  model: string;
  error: string;
  kind?: FailureKind;
  status?: number | null;
  attempts?: number;
  createdAt: string;
}

export interface PersonaVerdict extends CallMeta {
  ideaId: string;
  personaId: string;
  verdict: Verdict;
  score: number;
  reasoning: string;
  topConcern: string;
  topAppeal: string;
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

export interface Disagreement {
  scoreStdDev: number;
  verdictEntropy: number;
  agreement: number;
  confidence: "high" | "medium" | "low";
  byCategory: GroupStat[];
  byProvider: GroupStat[];
}

export interface Synthesis {
  ideaId: string;
  overallVerdict: Verdict;
  overallScore: number;
  counts: { build: number; maybe: number; dont_build: number };
  judged: number;
  failed: number;
  disagreement: Disagreement;
  topConcerns: ThemeCluster[];
  topAppeals: ThemeCluster[];
  summary: string;
  themesAvailable: boolean;
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

export interface PersonaMeta {
  id: string;
  name: string;
  category: string;
  tagline: string;
}

export interface ProviderMeta {
  /** Stable id used when picking providers for a run. */
  key: string;
  reason?: string | null;
  name: string;
  model: string;
  stats: { calls: number; retries: number; rateLimited: number; failures: number };
  usable: boolean;
  /** The site's key ("env"), the simulated providers ("mock"), or the visitor's own key ("own", browser only). */
  source?: "env" | "mock" | "own";
  capacity?: Capacity | null;
}

/** What a key can take: how many calls start at once and how fast the rest follow. */
export interface Capacity {
  now: number;
  burst: number;
  perMinute: number;
  dailyLeft: number | null;
  tokensPerCall: number;
  source: "measured" | "documented" | "setting" | "simulated" | "forced";
  detail: string;
  checkedAt: string;
}

export interface SendPlan {
  mode: "auto" | "all" | "paced";
  startNow: number;
  concurrency: number;
  startAllSec: number;
  providers: (Capacity & { key: string; name: string; model: string; personas: number; startAllSec: number })[];
  warnings: string[];
}

export interface ProviderHealth {
  name: string;
  model: string;
  keyHint: string;
  status: "ok" | "bad_key" | "bad_model" | "no_credit" | "quota" | "unreachable" | "error";
  message: string;
  note?: string;
}

export interface ApiMeta {
  mock: boolean;
  panelMode: PanelMode;
  sendMode?: "auto" | "all" | "paced";
  /** Whether visitors may run with their own key (ALLOW_OWN_KEYS). */
  ownKeys?: boolean;
  limits?: { freeRunsPerDay: number; simRunsPerDay: number; ownRunsPerDay: number };
  providers: ProviderMeta[];
  health: ProviderHealth[];
  personaCount: number;
  personaLibraryVersion: string;
  personas: PersonaMeta[];
}
