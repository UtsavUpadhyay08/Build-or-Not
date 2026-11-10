/**
 * Shared game-side helpers: persona display names, district colours, verdict styling and the
 * plain-language explanations for personas that "went home" (failed calls).
 */
import type { ApiMeta, Capacity, FailureKind, PersonaFailure, PersonaMeta, SendPlan, Verdict } from "../types";

export type Stage = "idle" | "assembly" | "thinking" | "deciding" | "result" | "failed";
export type V = "b" | "m" | "d" | "f";

export const toV = (v: Verdict): V => (v === "build" ? "b" : v === "maybe" ? "m" : "d");

/** "Sam, the Screen-Reader User" → { short: "Sam", role: "the Screen-Reader User" } */
export function splitName(full: string): { short: string; role: string } {
  const i = full.indexOf(", ");
  if (i < 0) return { short: full, role: "" };
  return { short: full.slice(0, i), role: full.slice(i + 2) };
}

export interface District {
  category: string;
  label: string;
  color: string;
  dark: string;
  x: number;
  y: number;
}

/** Positions in the 1280×736 village. Order matches the persona library's category order. */
export const DISTRICTS: District[] = [
  { category: "End User", label: "End Users", color: "#3B6FD8", dark: "#2A55B8", x: 40, y: 16 },
  { category: "Business & Investor", label: "Business & Investors", color: "#7C4DDB", dark: "#6136BD", x: 1024, y: 16 },
  { category: "Critic & Adversarial", label: "Critics", color: "#64748B", dark: "#475569", x: 40, y: 500 },
  { category: "Niche & Edge Case", label: "Niche & Edge Cases", color: "#0E9C99", dark: "#0A7472", x: 1024, y: 500 },
  { category: "Internal & Operational", label: "Internal & Ops", color: "#D97706", dark: "#A85C05", x: 532, y: 4 },
];

export function districtOf(category: string): District {
  return DISTRICTS.find((d) => d.category === category) ?? DISTRICTS[0];
}

export const SKIN = ["#F6D2B3", "#E2B48C", "#C68E62", "#8D5B3A", "#F1C9A5"];
export const skinFor = (index: number) => SKIN[(index * 7) % SKIN.length];

/** [label, light bg, dark fg, bright (on dark bg), solid] */
export const VSTYLE: Record<V, { label: string; bg: string; fg: string; bright: string; solid: string }> = {
  b: { label: "BUILD", bg: "#DCF2E3", fg: "#14532D", bright: "#4ADE80", solid: "#22A05A" },
  m: { label: "MAYBE", bg: "#ECE8E2", fg: "#44403C", bright: "#D6D3D1", solid: "#A8A29E" },
  d: { label: "DON’T BUILD", bg: "#FDE1CF", fg: "#7C2D12", bright: "#FB923C", solid: "#F97316" },
  f: { label: "WENT HOME", bg: "#E0E7FF", fg: "#3730A3", bright: "#A5B4FC", solid: "#818CF8" },
};

export const VERDICT_WORD: Record<Verdict, string> = { build: "Build it", maybe: "Mixed verdict", dont_build: "Don’t build" };

const PROVIDER_LABEL: Record<string, string> = { groq: "Groq", openrouter: "OpenRouter", opencode: "OpenCode", gemini: "Gemini", anthropic: "Anthropic", openai: "OpenAI", mock: "the simulated model" };
export const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p;

export interface FailureStory {
  short: string; // one line for the bubble / empty-seat card
  plain: string; // a sentence or two for the review panel
  steps: string[]; // what actually happened, in order
  fix?: string; // what the user can do about it
}

/** Capitalise the start of every sentence (provider labels like "the simulated model" can start one). */
const caps = (s: string) => s.replace(/(^|[.!?]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/** Explain a failed persona in plain words, from the failure category the server recorded. */
export function explainFailure(f: PersonaFailure, name: string): FailureStory {
  const s = rawStory(f, name);
  return { short: caps(s.short), plain: caps(s.plain), steps: s.steps.map(caps), fix: s.fix && caps(s.fix) };
}

function rawStory(f: PersonaFailure, name: string): FailureStory {
  const P = providerLabel(f.provider);
  const n = Math.max(1, f.attempts ?? 1);
  const retried = n > 1 ? `Waited and retried ${n - 1} more time${n - 1 === 1 ? "" : "s"}, with growing pauses: no luck.` : "Not retried: trying again straight away would fail the same way.";
  const leave = "Walked home, so the rest of the council wasn’t held up and the empty seat stays visible.";
  const kind: FailureKind = f.kind ?? "unknown";
  switch (kind) {
    case "rate_limit":
      return {
        short: `${P}’s per-minute limit was hit on their turn; ${n} attempt${n === 1 ? "" : "s"} failed.`,
        plain: `${name} never got to answer. ${P} limits how much it will process per minute, and the council hit that limit just as their turn came.`,
        steps: [`Asked ${P} for a verdict: refused, too many requests (HTTP 429).`, retried, leave],
        fix: "Ask again in a minute, lower the requests-per-minute setting, or add a second provider so others can take over.",
      };
    case "daily_quota":
      return {
        short: `${P}’s free daily allowance ran out.`,
        plain: `${P}’s free plan has a daily cap, and it was used up before ${name} could answer. It resets within 24 hours.`,
        steps: [`Asked ${P} for a verdict: refused, daily limit reached.`, "Not retried: waiting a few seconds can’t fix a daily cap.", leave],
        fix: "Try again tomorrow, or add another free provider so it can take over.",
      };
    case "timeout":
    case "network":
      return {
        short: kind === "timeout" ? `${P} didn’t reply in time; ${n} attempt${n === 1 ? "" : "s"} failed.` : `Couldn’t reach ${P}; ${n} attempt${n === 1 ? "" : "s"} failed.`,
        plain: kind === "timeout" ? `${P} was too slow to answer for ${name} (over 60 seconds), probably because it was busy.` : `The connection to ${P} failed while asking ${name}.`,
        steps: [kind === "timeout" ? `Asked ${P} for a verdict: no reply within 60 seconds.` : `Asked ${P} for a verdict: the connection failed.`, retried, leave],
        fix: "Usually temporary. Asking again later normally works.",
      };
    case "server_error":
      return {
        short: `${P} had a server error; ${n} attempt${n === 1 ? "" : "s"} failed.`,
        plain: `${P} itself had a problem (HTTP ${f.status ?? "5xx"}) while ${name} was answering. That’s on their side, not yours.`,
        steps: [`Asked ${P} for a verdict: server error (HTTP ${f.status ?? "5xx"}).`, retried, leave],
        fix: "Usually temporary. Asking again later normally works.",
      };
    case "bad_key":
      return {
        short: `${P} rejected the API key.`,
        plain: `${P} refused the API key, so ${name} (and anyone else on ${P}) couldn’t be asked.`,
        steps: [`Asked ${P} for a verdict: key rejected.`, `${P} was switched off for the rest of this run, so no more calls were wasted on it.`, leave],
        fix: `Create a new ${P} key, put it in .env and restart the server.`,
      };
    case "no_credit":
      return {
        short: `The ${P} account has no credit.`,
        plain: `The ${P} key is valid, but the account has no credit left, so ${P} refused to answer for ${name}.`,
        steps: [`Asked ${P} for a verdict: refused, no credit.`, `${P} was switched off for the rest of this run.`, leave],
        fix: `Add billing to ${P}, or use a free provider.`,
      };
    case "bad_model":
      return {
        short: `${P} doesn’t have the model “${f.model}”.`,
        plain: `The model name configured for ${P} doesn’t exist (it may have been retired), so ${name} couldn’t be asked.`,
        steps: [`Asked ${P}’s “${f.model}” for a verdict: model not found.`, `${P} was switched off for the rest of this run.`, leave],
        fix: "Clear the model setting in .env so the server picks a current one.",
      };
    case "bad_output":
      return {
        short: "Their answer came back garbled twice.",
        plain: `${name} did answer, but not in the format the panel needs (for example, a missing score or an invalid verdict).`,
        steps: ["Got an answer, but it didn’t match the required format.", "Asked again, quoting exactly what was wrong: still invalid.", "Walked home rather than guess what they meant."],
        fix: "Rare with good models. A different model or provider usually fixes it.",
      };
    case "cooling":
      return {
        short: `${P} was paused after repeated failures.`,
        plain: `${P} failed several personas in a row, so it was paused for a few minutes. No other provider on this council was free to take ${name}’s turn.`,
        steps: [`${P} had already failed 3 personas in a row.`, "It was paused for a few minutes to stop wasting calls.", leave],
        fix: "Add a second provider to the council so paused providers have a backup.",
      };
    default:
      return {
        short: "Their call failed.",
        plain: `Something went wrong asking ${name}: ${f.error.slice(0, 160)}`,
        steps: [`Asked ${P} for a verdict: it failed.`, leave],
      };
  }
}

export function sortByArrival<T extends { createdAt: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function personaIndex(personas: PersonaMeta[]): Map<string, number> {
  return new Map(personas.map((p, i) => [p.id, i]));
}

// ---------- send plan: how many calls a key takes at once ----------

export function formatWait(sec: number): string {
  if (sec <= 0) return "straight away";
  if (sec < 60) return "in under a minute";
  const m = Math.round(sec / 60);
  return `in about ${m} min`;
}

/** "6 at once, then 6 a minute · 999 left today" */
export function capacityLine(c: Capacity): string {
  const head = c.now < c.burst ? `${c.now} at once right now (${c.burst} on a fresh minute)` : `${c.burst} at once`;
  const rate = c.burst >= 45 ? "" : `, then ${c.perMinute} a minute`;
  const daily = c.dailyLeft !== null ? ` · ${c.dailyLeft.toLocaleString("en-US")} left today` : "";
  return `${head}${rate}${daily}`;
}

/** Split 45 personas over the council's providers, the same round-robin the server uses. */
function shares(keys: string[], total: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < total; i++) m.set(keys[i % keys.length], (m.get(keys[i % keys.length]) ?? 0) + 1);
  return m;
}

/** Client-side preview of a run from the last measurement (the server re-measures on submit). */
export function previewPlan(meta: ApiMeta | null, keys: string[], total = 45): { startNow: number; allSentSec: number; text: string } | null {
  if (!meta || keys.length === 0) return null;
  let startNow = 0;
  let allSentSec = 0;
  for (const [key, n] of shares(keys, total)) {
    const c = meta.providers.find((p) => p.key === key)?.capacity;
    if (!c) return null;
    const first = Math.min(n, c.now);
    startNow += first;
    allSentSec = Math.max(allSentSec, n > first ? Math.ceil(((n - first) / c.perMinute) * 60) : 0);
  }
  return { startNow, allSentSec, text: planSentence(startNow, total, allSentSec) };
}

export function planSentence(startNow: number, total: number, allSentSec: number): string {
  if (startNow >= total) return `All ${total} questions go out at once.`;
  if (startNow === 0) return `These keys are at their limit right now; questions start as they free up and all ${total} are sent ${formatWait(allSentSec)}.`;
  return `${startNow} questions go out at once; the other ${total - startNow} follow as the keys allow, all sent ${formatWait(allSentSec)}.`;
}

export function planFromServer(plan: SendPlan, total = 45): string {
  return planSentence(plan.startNow, total, plan.startAllSec);
}
