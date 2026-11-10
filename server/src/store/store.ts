import type { IdeaRecord, IdeaStatus, PersonaFailure, PersonaVerdict, Synthesis } from "../types.js";
import type { EvalJudgment } from "../eval/types.js";

/**
 * Persistence boundary. The app talks to this interface; MongoStore implements it for real and
 * MemoryStore implements it for unit tests (so orchestration tests don't need a database).
 */
export interface Store {
  insertIdea(idea: IdeaRecord): Promise<void>;
  getIdea(id: string): Promise<IdeaRecord | null>;
  listIdeas(limit?: number): Promise<IdeaRecord[]>;
  findIdeasByStatus(status: IdeaStatus): Promise<IdeaRecord[]>;
  updateIdeaStatus(id: string, status: IdeaStatus, error?: string | null): Promise<void>;
  deleteIdea(id: string): Promise<void>;

  /** Idempotent: keyed by (ideaId, personaId). A success always replaces an earlier failure. */
  saveVerdict(v: PersonaVerdict): Promise<void>;
  saveFailure(f: PersonaFailure): Promise<void>;
  getVerdicts(ideaId: string): Promise<PersonaVerdict[]>;
  getFailures(ideaId: string): Promise<PersonaFailure[]>;

  saveSynthesis(s: Synthesis): Promise<void>;
  getSynthesis(ideaId: string): Promise<Synthesis | null>;
  getSyntheses(ideaIds: string[]): Promise<Map<string, Synthesis>>;

  /** Eval results: idempotent upsert keyed by (runId, condition, itemId, personaId) — this is what makes runs resumable. */
  saveEvalJudgments(js: EvalJudgment[]): Promise<void>;
  getEvalJudgments(runId: string): Promise<EvalJudgment[]>;
  evalDoneKeys(runId: string): Promise<Set<string>>;

  /**
   * Daily limits. Atomically take one use of `bucket` if fewer than `limit` are used, and return the
   * new count; null when the limit is already reached. The bucket expires (is deleted) at `expiresAt`.
   */
  takeQuota(bucket: string, limit: number, expiresAt: Date): Promise<number | null>;
  /** Give one use back (the run failed to start). */
  returnQuota(bucket: string): Promise<void>;
  quotaUsed(bucket: string): Promise<number>;

  /**
   * Daily visit log for the owner's stats page: one document per (UTC day, hashed visitor),
   * deleted automatically after 90 days. `inc` adds to counters (views, runs, …); `first` is
   * written only when the document is created (where the visitor came from, first page).
   */
  bumpVisit(day: string, visitor: string, inc: Record<string, number>, first: Record<string, string>, expiresAt: Date): Promise<void>;
  visitsSince(day: string): Promise<VisitDay[]>;
  /** Ideas created at or after `iso` (newest first), for stats. */
  ideasSince(iso: string, limit?: number): Promise<IdeaRecord[]>;

  close(): Promise<void>;
}

export function evalKey(j: Pick<EvalJudgment, "runId" | "condition" | "itemId" | "personaId">): string {
  return `${j.runId}:${j.condition}:${j.itemId}:${j.personaId}`;
}

/** One visitor's activity on one UTC day. The visitor is an HMAC of their IP, never the IP. */
export interface VisitDay {
  day: string;
  visitor: string;
  counts: Record<string, number>;
  ref: string;
  firstPage: string;
}
