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

/** A short name for a product description: its first heading, else its first line. */
export function productName(md: string | undefined): string {
  const lines = (md ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l));
  const name = (heading ?? lines[0] ?? "").replace(/^#+\s*/, "").replace(/[*_`]/g, "");
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

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
  f: { label: "DIDN’T VOTE", bg: "#E0E7FF", fg: "#3730A3", bright: "#A5B4FC", solid: "#818CF8" },
};

export const VERDICT_WORD: Record<Verdict, string> = { build: "Build it", maybe: "Maybe", dont_build: "Don’t build" };

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
  const tries = `${n} ${n === 1 ? "try" : "tries"}`;
  const retried = n > 1 ? `Waited and tried again ${n - 1} more time${n - 1 === 1 ? "" : "s"}. Still no answer.` : "Didn’t try again: it would have failed the same way.";
  const leave = "Went home, so the others weren’t kept waiting.";
  const kind: FailureKind = f.kind ?? "unknown";
  switch (kind) {
    case "rate_limit":
      return {
        short: `${P} was busy (too many requests). Failed after ${tries}.`,
        plain: `${name} didn’t get to answer. ${P} only takes so many requests a minute, and the limit was hit on their turn.`,
        steps: [`Asked ${P}. It said “too many requests”.`, retried, leave],
        fix: "Wait a minute and ask again, or use a second AI model so others can take over.",
      };
    case "daily_quota":
      return {
        short: `${P}’s free limit for today ran out.`,
        plain: `${P}’s free plan has a daily limit, and it ran out before ${name} could answer. It resets within 24 hours.`,
        steps: [`Asked ${P}. It said the daily limit was used up.`, "Didn’t try again: waiting a few seconds won’t help.", leave],
        fix: "Try again tomorrow, or use another free AI model.",
      };
    case "timeout":
    case "network":
      return {
        short: kind === "timeout" ? `${P} took too long to reply. Failed after ${tries}.` : `Couldn’t reach ${P}. Failed after ${tries}.`,
        plain: kind === "timeout" ? `${P} took more than 60 seconds to answer for ${name}. It was probably busy.` : `The connection to ${P} dropped while asking ${name}.`,
        steps: [kind === "timeout" ? `Asked ${P}. No reply after 60 seconds.` : `Asked ${P}. The connection failed.`, retried, leave],
        fix: "This is usually temporary. Asking again later normally works.",
      };
    case "server_error":
      return {
        short: `${P} had a problem on its side. Failed after ${tries}.`,
        plain: `${P} had an error of its own (code ${f.status ?? "5xx"}) while ${name} was answering. Nothing you did caused it.`,
        steps: [`Asked ${P}. It replied with an error (code ${f.status ?? "5xx"}).`, retried, leave],
        fix: "This is usually temporary. Asking again later normally works.",
      };
    case "bad_key":
      return {
        short: `${P} didn’t accept the API key.`,
        plain: `${P} said the API key isn’t valid, so ${name} couldn’t be asked.`,
        steps: [`Asked ${P}. The key was refused.`, `Stopped using ${P} for this run, so no more questions were wasted.`, leave],
        fix: `Check the ${P} key, or make a new one.`,
      };
    case "no_credit":
      return {
        short: `The ${P} account has no credit left.`,
        plain: `The ${P} key works, but the account has no credit, so ${P} wouldn’t answer for ${name}.`,
        steps: [`Asked ${P}. It said there’s no credit.`, `Stopped using ${P} for this run.`, leave],
        fix: `Add credit to your ${P} account, or use a free AI model.`,
      };
    case "bad_model":
      return {
        short: `${P} doesn’t have the model “${f.model}”.`,
        plain: `The AI model “${f.model}” doesn’t exist on ${P} any more, so ${name} couldn’t be asked.`,
        steps: [`Asked ${P} for “${f.model}”. That model wasn’t found.`, `Stopped using ${P} for this run.`, leave],
        fix: "Pick a different model, or leave the model setting empty so a current one is chosen.",
      };
    case "bad_output":
      return {
        short: "Their answer came back broken, twice.",
        plain: `${name} did answer, but the answer was missing parts we need (like a score).`,
        steps: ["Got an answer, but parts were missing or wrong.", "Asked again and pointed out what was wrong. Still broken.", "Went home rather than guess what they meant."],
        fix: "This is rare. Trying a different AI model usually fixes it.",
      };
    case "cooling":
      return {
        short: `${P} was paused after failing several times in a row.`,
        plain: `${P} failed 3 personas in a row, so it was paused for a few minutes. No other AI model was free to take ${name}’s turn.`,
        steps: [`${P} had already failed 3 personas in a row.`, "It was paused for a few minutes so no more questions were wasted.", leave],
        fix: "Use a second AI model, so there’s a backup when one is paused.",
      };
    default:
      return {
        short: "Their question failed.",
        plain: `Something went wrong while asking ${name}: ${f.error.slice(0, 160)}`,
        steps: [`Asked ${P}. It failed.`, leave],
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
  const head = c.now < c.burst ? `${c.now} questions at once right now (usually ${c.burst})` : `${c.burst} questions at once`;
  const rate = c.burst >= 45 ? "" : `, then ${c.perMinute} a minute`;
  const daily = c.dailyLeft !== null ? ` · ${c.dailyLeft.toLocaleString("en-US")} requests left today` : "";
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
  if (startNow === 0) return `The AI is at its limit right now. Questions start as soon as it frees up, and all ${total} are sent ${formatWait(allSentSec)}.`;
  return `${startNow} questions go out now. The other ${total - startNow} follow as fast as the AI allows: all sent ${formatWait(allSentSec)}.`;
}

export function planFromServer(plan: SendPlan, total = 45): string {
  const base = planSentence(plan.startNow, total, plan.startAllSec);
  const n = plan.sharedWith ?? 0;
  if (n <= 0) return base;
  const others = n === 1 ? "1 other idea is" : `${n} other ideas are`;
  return `${others} being judged on the free key right now, so they take turns. ${base}`;
}
