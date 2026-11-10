/**
 * Orchestrates one panel run:
 *
 *   1. Work out which personas still need a verdict (resumability: anything already saved is skipped,
 *      so a run interrupted by a server restart picks up where it left off).
 *   2. Assign each persona a provider (single model, or round-robin across providers in mixed mode).
 *   3. Fan out through the bounded worker pool. Each call goes through its provider's token bucket
 *      and retry policy (ManagedProvider). Each result is persisted the moment it arrives and
 *      pushed to SSE listeners.
 *   4. Quorum: if fewer than PANEL_QUORUM of personas succeeded, the run fails honestly rather than
 *      publishing a verdict from, say, 12 of 45 voices.
 *   5. Aggregate numbers locally (score, verdict, disagreement) and ask one LLM call for themes.
 *      If that call fails, the numeric verdict is still published (themesAvailable: false).
 */
import { redactSecrets } from "../llm/redact.js";
import { EventEmitter } from "node:events";
import { runPool } from "../core/workerPool.js";
import type { Persona } from "../personas.js";
import type { LLMProvider } from "../llm/types.js";
import { callStructured } from "../llm/structured.js";
import { costUsd } from "../llm/pricing.js";
import type { Store } from "../store/store.js";
import type { FailureKind, IdeaBrief, PersonaFailure, PersonaVerdict, Synthesis } from "../types.js";
import { ProviderError } from "../core/retry.js";
import { StructuredOutputError } from "../llm/structured.js";
import { judgePersona } from "./judge.js";
import { computeDisagreement, computeOverallScore, computeOverallVerdict, countVerdicts, meetsQuorum } from "./aggregate.js";
import { describeIdea, SYNTHESIS_SCHEMA, SYNTHESIS_SYSTEM, synthesisZ } from "./prompts.js";

export type ProgressEvent =
  | { type: "verdict"; verdict: PersonaVerdict; completed: number; total: number }
  | { type: "failure"; failure: PersonaFailure; completed: number; total: number }
  | { type: "synthesizing" }
  | { type: "done"; synthesis: Synthesis }
  | { type: "error"; message: string };

export interface PanelDeps {
  store: Store;
  personas: readonly Persona[];
  /** Provider for each persona, same order as `personas`. */
  assignments: readonly LLMProvider[];
  synthesisProvider: LLMProvider;
  concurrency: number;
  quorum: number;
  emit?: (e: ProgressEvent) => void;
  signal?: AbortSignal;
  /**
   * Called right before each persona's call with its assigned provider. Lets the service swap in a
   * healthy provider if the assigned one's circuit breaker opened mid-run (e.g. key revoked).
   * The verdict records which provider actually answered.
   */
  reroute?: (assigned: LLMProvider, index: number) => LLMProvider;
}

export async function runPanel(deps: PanelDeps, ideaId: string, idea: IdeaBrief): Promise<Synthesis | null> {
  const { store, personas, assignments, emit = () => {} } = deps;
  const total = personas.length;

  try {
    const already = new Set((await store.getVerdicts(ideaId)).map((v) => v.personaId));
    const todo = personas.map((p, i) => ({ persona: p, provider: assignments[i], index: i })).filter(({ persona }) => !already.has(persona.id));
    let completed = already.size;

    await runPool(
      todo,
      async ({ persona, provider: assigned, index }) => {
        let provider = assigned;
        try {
          provider = deps.reroute ? deps.reroute(assigned, index) : assigned;
          const out = await judgePersona(provider, persona, idea, total, { signal: deps.signal });
          const verdict: PersonaVerdict = { ideaId, personaId: persona.id, createdAt: new Date().toISOString(), ...out };
          await store.saveVerdict(verdict);
          emit({ type: "verdict", verdict, completed: ++completed, total });
        } catch (err) {
          const failure: PersonaFailure = {
            ideaId,
            personaId: persona.id,
            provider: provider?.name ?? "unknown",
            model: provider?.model ?? "unknown",
            error: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500),
            ...describeFailure(err),
            createdAt: new Date().toISOString(),
          };
          await store.saveFailure(failure);
          emit({ type: "failure", failure, completed: ++completed, total });
          throw err; // surfaces as "rejected" in the pool result; the run itself carries on
        }
      },
      { concurrency: deps.concurrency, signal: deps.signal },
    );

    const verdicts = await store.getVerdicts(ideaId);
    if (!meetsQuorum(verdicts.length, total, deps.quorum)) {
      throw new Error(
        `Only ${verdicts.length} of ${total} personas responded (quorum is ${Math.round(deps.quorum * 100)}%). ` +
          `Not publishing a verdict from a partial panel — resubmit or check provider status.`,
      );
    }

    emit({ type: "synthesizing" });
    const synthesis = await synthesize(deps, ideaId, idea, verdicts, total - verdicts.length);
    await store.saveSynthesis(synthesis);
    await store.updateIdeaStatus(ideaId, "completed");
    emit({ type: "done", synthesis });
    return synthesis;
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    await store.updateIdeaStatus(ideaId, "failed", redactSecrets(message)).catch(() => {});
    emit({ type: "error", message });
    return null;
  }
}

async function synthesize(deps: PanelDeps, ideaId: string, idea: IdeaBrief, verdicts: PersonaVerdict[], failed: number): Promise<Synthesis> {
  const personaById = new Map(deps.personas.map((p) => [p.id, p]));
  const counts = countVerdicts(verdicts);
  const overallScore = computeOverallScore(verdicts);
  const disagreement = computeDisagreement(
    verdicts,
    (v) => personaById.get(v.personaId)?.category ?? "?",
    (v) => `${v.provider}/${v.model}`,
  );

  const transcript = verdicts
    .map((v) => {
      const p = personaById.get(v.personaId);
      return `- ${p?.name ?? v.personaId} [${p?.category ?? "?"}] verdict=${v.verdict} score=${v.score}/10\n  concern: ${v.topConcern}\n  appeal: ${v.topAppeal}`;
    })
    .join("\n");

  let themes = { topConcerns: [] as Synthesis["topConcerns"], topAppeals: [] as Synthesis["topAppeals"], summary: "", themesAvailable: false };
  let synthUsage = { inputTokens: 0, outputTokens: 0 };
  let synthCost: number | null = 0;
  try {
    const res = await callStructured(
      deps.synthesisProvider,
      {
        system: SYNTHESIS_SYSTEM,
        user:
          `Idea:\n${describeIdea(idea)}\n\nPanel stats: ${verdicts.length} responded, ${failed} failed. ` +
          `Score SD ${disagreement.scoreStdDev}, verdict entropy ${disagreement.verdictEntropy} (0=unanimous, 1=even split).\n\nVerdicts:\n${transcript}`,
        schemaName: "submit_synthesis",
        schemaDescription: "Submit the recurring themes across all persona verdicts.",
        schema: SYNTHESIS_SCHEMA,
        maxTokens: 1500,
        signal: deps.signal,
      },
      synthesisZ,
    );
    themes = { ...res.value, themesAvailable: true };
    synthUsage = res.usage;
    synthCost = costUsd(deps.synthesisProvider.model, res.usage);
  } catch (err) {
    themes.summary = `Theme extraction failed (${err instanceof Error ? err.message.slice(0, 160) : "unknown error"}). The verdict, score and disagreement figures above are computed directly from the persona responses and are unaffected.`;
  }

  const costs = [...verdicts.map((v) => v.costUsd), synthCost];
  return {
    ideaId,
    overallVerdict: computeOverallVerdict(counts, overallScore),
    overallScore,
    counts,
    judged: verdicts.length,
    failed,
    disagreement,
    ...themes,
    cost: {
      inputTokens: verdicts.reduce((s, v) => s + v.inputTokens, 0) + synthUsage.inputTokens,
      outputTokens: verdicts.reduce((s, v) => s + v.outputTokens, 0) + synthUsage.outputTokens,
      usd: costs.some((c) => c === null) ? null : costs.reduce<number>((s, c) => s + (c ?? 0), 0),
    },
    createdAt: new Date().toISOString(),
  };
}

// ---------- live progress fan-out to SSE subscribers ----------

const emitters = new Map<string, EventEmitter>();

export function progressEmitter(ideaId: string): EventEmitter {
  let e = emitters.get(ideaId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(50);
    emitters.set(ideaId, e);
  }
  return e;
}

export function existingEmitter(ideaId: string): EventEmitter | undefined {
  return emitters.get(ideaId);
}

export function releaseEmitter(ideaId: string, afterMs = 60_000): void {
  setTimeout(() => emitters.delete(ideaId), afterMs).unref?.();
}

/** Turn an error into a plain category the UI can explain ("went home because …"). */
export function describeFailure(err: unknown): { kind: FailureKind; status: number | null; attempts: number } {
  const e = err as { kind?: FailureKind; attempts?: number };
  const attempts = e?.attempts ?? 1;
  if (err instanceof StructuredOutputError) return { kind: "bad_output", status: null, attempts: 2 };
  if (!(err instanceof ProviderError)) return { kind: "unknown", status: null, attempts };
  if (e.kind) return { kind: e.kind, status: err.status, attempts };
  const s = err.status;
  const kind: FailureKind =
    s === null ? (/timed out/i.test(err.message) ? "timeout" : "network")
    : s === 429 ? (/per[- ]day|daily|free-models-per-day|\bTPD\b|\bRPD\b/i.test(err.message) ? "daily_quota" : "rate_limit")
    : s === 401 || s === 403 ? "bad_key"
    : s === 402 ? "no_credit"
    : s === 404 ? "bad_model"
    : s >= 500 ? "server_error"
    : "unknown";
  return { kind, status: s, attempts };
}
