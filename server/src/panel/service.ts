/** Wires config + providers + store into runPanel. The only place that knows about all three. */
import { config, MOCK_MODE, type PanelMode } from "../config.js";
import { PERSONAS } from "../personas.js";
import { assignProviders, panelProviders, planRun, primaryProvider, providerKey, synthesisProvider } from "../llm/registry.js";
import type { SendPlan } from "../llm/capacity.js";
import type { ManagedProvider } from "../llm/managed.js";
import type { Store } from "../store/store.js";
import type { IdeaBrief } from "../types.js";
import { progressEmitter, releaseEmitter, runPanel } from "./runPanel.js";

const inFlight = new Set<string>();

/**
 * Which providers sit on this council. `names` is what the user picked in the UI (validated by the
 * route); anything no longer usable is dropped, and an empty pick falls back to the defaults.
 */
export function councilFor(mode: PanelMode, names: string[] = []): ManagedProvider[] {
  const usable = panelProviders();
  const picked = names.length ? usable.filter((p) => names.includes(providerKey(p))) : [];
  if (mode === "single") return [picked[0] ?? primaryProvider()];
  return picked.length ? picked : usable;
}

/** Rough size of the idea text that goes into every persona prompt (for token estimates). */
export function ideaChars(idea: IdeaBrief): number {
  return [idea.title, idea.description, idea.targetAudience, idea.pricingModel, idea.competitors].join(" ").length + 300;
}

/** Everything a run needs, decided before it starts. */
export interface PreparedRun {
  council: ManagedProvider[];
  assignments: ManagedProvider[];
  synthesis: ManagedProvider;
  plan: SendPlan;
  /** True when the council is the visitor's own keys: the run must never fall back to the site's keys. */
  own: boolean;
}

/**
 * Pick the council, measure its keys and size the run to them: as many calls as the keys allow
 * start at once, the rest follow at each key's per-minute rate.
 *
 * With `ownProviders` (built from the visitor's keys) the council is drawn only from those, and
 * so is theme synthesis: a visitor's run never touches the site's key, and their key is never
 * used for anything but this run.
 */
export async function prepareRun(idea: IdeaBrief, mode: PanelMode, names: string[] = [], ownProviders?: ManagedProvider[]): Promise<PreparedRun> {
  let council: ManagedProvider[];
  if (ownProviders) {
    const picked = names.length ? ownProviders.filter((p) => names.includes(providerKey(p))) : [];
    council = mode === "single" ? [picked[0] ?? ownProviders[0]] : picked.length >= 2 ? picked : ownProviders;
  } else {
    council = councilFor(mode, names);
  }
  const assignments = mode === "single" || council.length === 1 ? PERSONAS.map(() => council[0]) : assignProviders(PERSONAS, "mixed", council);
  const plan = await planRun(assignments, ideaChars(idea));
  return { council, assignments, synthesis: ownProviders ? council[0] : synthesisProvider(), plan, own: !!ownProviders };
}

export function startPanel(store: Store, ideaId: string, idea: IdeaBrief, prepared: PreparedRun): void {
  if (inFlight.has(ideaId)) return;
  inFlight.add(ideaId);
  const emitter = progressEmitter(ideaId);
  void runPanel(
    {
      store,
      personas: PERSONAS,
      assignments: prepared.assignments,
      synthesisProvider: prepared.synthesis,
      concurrency: prepared.plan.concurrency,
      quorum: config.quorum,
      emit: (e) => emitter.emit("progress", e),
      reroute: (assigned, i) => {
        if (!(assigned as ManagedProvider).unavailableReason) return assigned;
        // Another provider from the same council. Only free-tier runs may fall back to other site keys.
        const council = prepared.council.filter((p) => !p.unavailableReason);
        const healthy = council.length ? council : prepared.own ? [] : panelProviders();
        return healthy.length ? healthy[i % healthy.length] : assigned; // none left: let it fail with the clear message
      },
    },
    ideaId,
    idea,
  ).finally(() => {
    inFlight.delete(ideaId);
    releaseEmitter(ideaId);
  });
}

export function isRunning(ideaId: string): boolean {
  return inFlight.has(ideaId);
}

/**
 * On boot: any idea still marked "running" was interrupted by a restart. Resume it — runPanel
 * skips personas that already have a saved verdict, so only the missing calls are made.
 */
export async function resumeInterrupted(store: Store): Promise<number> {
  const stuck = await store.findIdeasByStatus("running");
  for (const idea of stuck) {
    if (idea.keyMode === "own") {
      await store.updateIdeaStatus(idea.id, "failed", "Interrupted by a server restart. Your own API key is never stored, so this run can't carry on by itself. Ask again with your key.");
      continue;
    }
    if (idea.mock !== MOCK_MODE) {
      await store.updateIdeaStatus(idea.id, "failed", "Interrupted, and can't resume: the server's mock/real mode changed since it started.");
      continue;
    }
    const mode = idea.panelMode ?? "single";
    startPanel(store, idea.id, idea, await prepareRun(idea, mode, idea.providers ?? []));
  }
  return stuck.length;
}
