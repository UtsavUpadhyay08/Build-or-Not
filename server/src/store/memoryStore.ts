/** In-memory Store for unit tests. Same semantics as MongoStore (idempotent upserts, success beats failure). */
import type { IdeaRecord, IdeaStatus, PersonaFailure, PersonaVerdict, Synthesis } from "../types.js";
import type { EvalJudgment } from "../eval/types.js";
import { evalKey, type Store, type VisitDay } from "./store.js";

export class MemoryStore implements Store {
  ideas = new Map<string, IdeaRecord>();
  judgments = new Map<string, { ok: true; data: PersonaVerdict } | { ok: false; data: PersonaFailure }>();
  syntheses = new Map<string, Synthesis>();
  evals = new Map<string, EvalJudgment>();

  async insertIdea(idea: IdeaRecord) {
    this.ideas.set(idea.id, structuredClone(idea));
  }
  async getIdea(id: string) {
    return this.ideas.get(id) ?? null;
  }
  async listIdeas() {
    return [...this.ideas.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async findIdeasByStatus(status: IdeaStatus) {
    return [...this.ideas.values()].filter((i) => i.status === status);
  }
  async updateIdeaStatus(id: string, status: IdeaStatus, error: string | null = null) {
    const i = this.ideas.get(id);
    if (i) Object.assign(i, { status, error });
  }
  async deleteIdea(id: string) {
    this.ideas.delete(id);
    this.syntheses.delete(id);
    for (const k of this.judgments.keys()) if (k.startsWith(id + ":")) this.judgments.delete(k);
  }
  async saveVerdict(v: PersonaVerdict) {
    this.judgments.set(`${v.ideaId}:${v.personaId}`, { ok: true, data: v });
  }
  async saveFailure(f: PersonaFailure) {
    const k = `${f.ideaId}:${f.personaId}`;
    if (this.judgments.get(k)?.ok) return;
    this.judgments.set(k, { ok: false, data: f });
  }
  async getVerdicts(ideaId: string) {
    return [...this.judgments.entries()].filter(([k, j]) => k.startsWith(ideaId + ":") && j.ok).map(([, j]) => j.data as PersonaVerdict);
  }
  async getFailures(ideaId: string) {
    return [...this.judgments.entries()].filter(([k, j]) => k.startsWith(ideaId + ":") && !j.ok).map(([, j]) => j.data as PersonaFailure);
  }
  async saveSynthesis(s: Synthesis) {
    this.syntheses.set(s.ideaId, s);
  }
  async getSynthesis(id: string) {
    return this.syntheses.get(id) ?? null;
  }
  async getSyntheses(ids: string[]) {
    return new Map(ids.filter((id) => this.syntheses.has(id)).map((id) => [id, this.syntheses.get(id)!]));
  }
  async saveEvalJudgments(js: EvalJudgment[]) {
    for (const j of js) this.evals.set(evalKey(j), j);
  }
  async getEvalJudgments(runId: string) {
    return [...this.evals.values()].filter((j) => j.runId === runId);
  }
  async evalDoneKeys(runId: string) {
    return new Set([...this.evals.keys()].filter((k) => k.startsWith(runId + ":")));
  }
  async close() {}

  private quotas = new Map<string, { n: number; expiresAt: number }>();
  private quota(bucket: string) {
    const q = this.quotas.get(bucket);
    if (q && q.expiresAt <= Date.now()) this.quotas.delete(bucket);
    return this.quotas.get(bucket);
  }
  async takeQuota(bucket: string, limit: number, expiresAt: Date) {
    const q = this.quota(bucket) ?? { n: 0, expiresAt: expiresAt.getTime() };
    if (q.n >= limit) return null;
    q.n++;
    this.quotas.set(bucket, q);
    return q.n;
  }
  async returnQuota(bucket: string) {
    const q = this.quota(bucket);
    if (q && q.n > 0) q.n--;
  }
  async quotaUsed(bucket: string) {
    return this.quota(bucket)?.n ?? 0;
  }

  private visits = new Map<string, VisitDay & { expiresAt: number }>();
  async bumpVisit(day: string, visitor: string, inc: Record<string, number>, first: Record<string, string>, expiresAt: Date) {
    const id = `${day}:${visitor}`;
    const v = this.visits.get(id) ?? { day, visitor, counts: {}, ref: first.ref ?? "", firstPage: first.firstPage ?? "", expiresAt: expiresAt.getTime() };
    for (const [k, n] of Object.entries(inc)) v.counts[k] = (v.counts[k] ?? 0) + n;
    this.visits.set(id, v);
  }
  async visitsSince(day: string) {
    return [...this.visits.values()].filter((v) => v.day >= day && v.expiresAt > Date.now()).map(({ expiresAt: _e, ...v }) => v);
  }
  async ideasSince(iso: string, limit = 5000) {
    return [...this.ideas.values()].filter((i) => i.createdAt >= iso).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
}
