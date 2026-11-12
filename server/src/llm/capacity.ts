/**
 * "How many persona calls can this key take at once, right now?"
 *
 * Before a run (and when a key is added), each provider on the council is measured:
 *
 *   Groq            1 tiny completion, then its rate-limit headers: tokens per minute (limit and
 *                   remaining) and requests left today. Its per-minute request cap isn't in the
 *                   headers, so the documented 30/min is used for that part.
 *   OpenAI          1 tiny completion: requests and tokens per minute, limit and remaining.
 *   OpenCode        same headers as OpenAI when it sends them, else its RPM setting.
 *   Anthropic       1 tiny message: anthropic-ratelimit-* (requests and input tokens per minute).
 *   OpenRouter      GET /key: free-model requests left today; free models allow 20 a minute.
 *   Gemini          reports no limits, so the free tier's documented ~10 a minute is assumed.
 *
 * The answer sets the provider's token bucket: `burst` calls start the moment the idea is
 * submitted, then `perMinute` more each minute. A wrong guess isn't fatal: a 429 still pauses
 * the bucket and the call retries, and the average real tokens per call (learned from finished
 * calls) replaces the estimate on the next run.
 */
import { ALL_PERSONAS_PROMPT_CHARS } from "./promptSize.js";
import { baseUrl } from "./providers.js";
import { COMPAT, compatBase, type CompatName } from "./openaiCompatible.js";
import type { ProviderConfig } from "../config.js";

export const PANEL_SIZE = 45;

export interface RateInfo {
  rpmLimit?: number;
  rpmRemaining?: number;
  tpmLimit?: number;
  tpmRemaining?: number;
  rpdLimit?: number;
  rpdRemaining?: number;
  /** Seconds until the provider accepts calls again (it answered the probe with a 429). */
  retryAfterSec?: number;
}

export interface Capacity {
  /** Calls that can start the moment the idea is submitted. 0 = the key is at its limit right now. */
  now: number;
  /** Calls that can start at once on a fresh minute (the bucket size). */
  burst: number;
  /** Sustained calls per minute after the first burst. */
  perMinute: number;
  /** Requests left today, when the provider says. */
  dailyLeft: number | null;
  tokensPerCall: number;
  source: "measured" | "documented" | "setting" | "simulated" | "forced";
  /** One or two plain sentences: what was measured and what it means. */
  detail: string;
  checkedAt: string;
}

/** Request caps the providers document but don't put in their response headers. */
const DOCUMENTED_RPM: Partial<Record<string, number>> = { groq: 30, openrouter: 20, gemini: 10 };
const LABEL: Record<string, string> = { groq: "Groq", openrouter: "OpenRouter", opencode: "OpenCode", gemini: "Gemini", anthropic: "Anthropic", openai: "OpenAI", mock: "The simulated model" };

/** Reasoning models (gpt-oss, deepseek…) spend output tokens thinking; this is a deliberately safe guess. */
export const OUTPUT_TOKENS_GUESS = 700;

/** Tokens one persona call uses: its prompt (the idea included) plus the answer. */
export function estimateTokensPerCall(ideaChars = 1500, observedAvg?: number | null): number {
  if (observedAvg && observedAvg > 0) return Math.round(observedAvg);
  const promptChars = ALL_PERSONAS_PROMPT_CHARS / PANEL_SIZE + ideaChars;
  return Math.round(promptChars / 4 + OUTPUT_TOKENS_GUESS); // ~4 characters per token
}

const int = (v: string | null | undefined): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
};

/** Read whichever rate-limit headers this provider sends. Pure: easy to test against captured headers. */
export function parseRateHeaders(name: string, header: (h: string) => string | null): RateInfo {
  const info: RateInfo = { retryAfterSec: int(header("retry-after")) };
  if (name === "anthropic") {
    info.rpmLimit = int(header("anthropic-ratelimit-requests-limit"));
    info.rpmRemaining = int(header("anthropic-ratelimit-requests-remaining"));
    info.tpmLimit = int(header("anthropic-ratelimit-input-tokens-limit") ?? header("anthropic-ratelimit-tokens-limit"));
    info.tpmRemaining = int(header("anthropic-ratelimit-input-tokens-remaining") ?? header("anthropic-ratelimit-tokens-remaining"));
    return info;
  }
  const reqLimit = int(header("x-ratelimit-limit-requests"));
  const reqLeft = int(header("x-ratelimit-remaining-requests"));
  info.tpmLimit = int(header("x-ratelimit-limit-tokens"));
  info.tpmRemaining = int(header("x-ratelimit-remaining-tokens"));
  if (name === "groq") {
    // Groq: the request headers are per DAY; the token headers are per minute.
    info.rpdLimit = reqLimit;
    info.rpdRemaining = reqLeft;
  } else {
    info.rpmLimit = reqLimit;
    info.rpmRemaining = reqLeft;
  }
  return info;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const minDefined = (...xs: (number | undefined)[]) => {
  const ys = xs.filter((x): x is number => x !== undefined && Number.isFinite(x));
  return ys.length ? Math.min(...ys) : undefined;
};

export interface PlanOptions {
  tokensPerCall: number;
  /** Requests per minute the user set in .env (caps the measured rate). */
  rpmSetting?: number;
  /** Fallback per-minute rate when the provider reports nothing and documents nothing. */
  rpmFallback: number;
  /** <NAME>_BURST from .env: pins the burst. */
  burstPin?: number;
  source?: Capacity["source"];
}

/** Turn what the provider reported into a send plan. Pure. */
export function planCapacity(name: string, info: RateInfo, o: PlanOptions): Capacity {
  const P = LABEL[name] ?? name;
  const per = Math.max(1, o.tokensPerCall);
  const documented = DOCUMENTED_RPM[name];
  const rpm = minDefined(info.rpmLimit, o.rpmSetting, info.rpmLimit === undefined ? documented : undefined) ?? o.rpmFallback;
  const byTokens = info.tpmLimit !== undefined ? Math.floor(info.tpmLimit / per) : undefined;
  const perMinute = Math.max(1, minDefined(rpm, byTokens) ?? rpm); // the burst is capped at one panel; the rate is not
  const burst = Math.max(1, Math.min(PANEL_SIZE, o.burstPin ?? perMinute));

  const tokensNow = info.tpmRemaining !== undefined ? Math.floor(info.tpmRemaining / per) : undefined;
  let now = Math.min(burst, minDefined(info.rpmRemaining, tokensNow, info.rpdRemaining) ?? burst);
  if (info.retryAfterSec !== undefined && info.retryAfterSec > 0) now = 0;
  if (o.source === "forced") now = burst; // PANEL_ALL_AT_ONCE=true: send regardless of what's left
  now = Math.max(0, now);

  const measured = info.tpmLimit !== undefined || info.rpmLimit !== undefined || info.rpdRemaining !== undefined;
  const source: Capacity["source"] = o.source ?? (o.burstPin ? "setting" : measured ? "measured" : documented ? "documented" : "setting");

  const parts: string[] = [];
  if (o.source === "forced") parts.push(`Sending all ${burst} at once (PANEL_ALL_AT_ONCE=true), whatever ${P}'s limits say.`);
  if (o.source === "simulated") parts.push(`Simulated AI: ${perMinute} questions a minute.`);
  if (info.tpmLimit !== undefined) {
    parts.push(`${P} lets this key use ${fmt(info.tpmLimit)} tokens a minute. Each persona’s question uses about ${fmt(per)}, so that’s ${byTokens} question${byTokens === 1 ? "" : "s"} a minute.`);
  }
  if (info.rpmLimit !== undefined) parts.push(`${P} allows ${fmt(info.rpmLimit)} requests a minute.`);
  else if (documented && source !== "simulated") parts.push(`${P} doesn’t say how many requests a minute it allows, so we use its published limit of ${documented}.`);
  if (o.rpmSetting) parts.push(`Capped at ${o.rpmSetting} a minute by ${name.toUpperCase()}_RPM.`);
  if (o.burstPin) parts.push(`Burst pinned to ${o.burstPin} by ${name.toUpperCase()}_BURST.`);
  if (now === 0) parts.push(info.retryAfterSec ? `It’s at its limit right now (free again in ${info.retryAfterSec} seconds).` : "It’s at its limit right now. Questions start as soon as it frees up.");
  else if (now < burst) parts.push(`Part of this minute is already used, so ${now} can start right away.`);
  if (info.rpdRemaining !== undefined) parts.push(`${fmt(info.rpdRemaining)} requests left today.`);
  if (!parts.length) parts.push(`${P} doesn’t share its limits, so we send ${perMinute} a minute.`);

  return {
    now,
    burst,
    perMinute,
    dailyLeft: info.rpdRemaining ?? null,
    tokensPerCall: per,
    source,
    detail: parts.join(" "),
    checkedAt: new Date().toISOString(),
  };
}

/** Everything a send plan for one run needs to know about one provider. */
export interface ProviderPlan extends Capacity {
  key: string;
  name: string;
  model: string;
  personas: number;
  /** Seconds until the last of this provider's personas can START (not finish). */
  startAllSec: number;
}

export interface SendPlan {
  mode: "auto" | "all" | "paced";
  /** Calls that start the moment the idea is submitted. */
  startNow: number;
  /** Pool size for the run. */
  concurrency: number;
  /** Seconds until every persona has been sent (the slowest provider). */
  startAllSec: number;
  providers: ProviderPlan[];
  /** Plain-language warnings, e.g. not enough requests left today. */
  warnings: string[];
  /** Other ideas being judged on the same shared keys when this one started (they take turns). */
  sharedWith?: number;
}

/**
 * Adjust a plan for other runs already using the same shared keys. The queue takes turns between
 * runs, so with N others each run gets about 1/(N+1) of the capacity: fewer calls start right
 * away and sending takes about N+1 times as long. Pure.
 */
export function shareSendPlan(plan: SendPlan, others: number): SendPlan {
  if (others <= 0) return plan;
  const k = others + 1;
  return {
    ...plan,
    sharedWith: others,
    startNow: plan.startNow > 0 ? Math.max(1, Math.floor(plan.startNow / k)) : 0,
    startAllSec: Math.ceil(Math.max(plan.startAllSec, 1) * k),
    providers: plan.providers.map((p) => ({ ...p, startAllSec: Math.ceil(Math.max(p.startAllSec, 1) * k) })),
  };
}

/** Combine per-provider capacity with how many personas each provider got. Pure. */
export function buildSendPlan(mode: SendPlan["mode"], items: { key: string; name: string; model: string; personas: number; cap: Capacity }[]): SendPlan {
  const warnings: string[] = [];
  const providers = items.map(({ cap, ...rest }) => {
    const first = Math.min(rest.personas, cap.now);
    const left = rest.personas - first;
    // After the first wave, the bucket refills at perMinute; anything beyond burst-per-minute queues.
    const startAllSec = left <= 0 ? 0 : Math.ceil((left / cap.perMinute) * 60);
    if (cap.dailyLeft !== null && cap.dailyLeft < rest.personas) {
      warnings.push(`${LABEL[rest.name] ?? rest.name} has only ${cap.dailyLeft} requests left today for ${rest.personas} personas. The rest won’t get to vote.`);
    }
    return { ...rest, ...cap, startAllSec };
  });
  const startNow = providers.reduce((s, p) => s + Math.min(p.personas, p.now), 0);
  const concurrency = Math.max(1, Math.min(PANEL_SIZE, providers.reduce((s, p) => s + Math.min(p.personas, p.burst), 0)));
  return { mode, startNow, concurrency, startAllSec: Math.max(0, ...providers.map((p) => p.startAllSec)), providers, warnings };
}

// ---------- live probes ----------

async function timed(url: string, init: RequestInit, timeoutMs: number) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Ask the provider for its current limits. Throws only on network failure; an HTTP error still
 * returns whatever headers came back (a 429 tells us exactly what we need).
 */
export async function probeRateInfo(cfg: ProviderConfig, timeoutMs = 8000): Promise<{ info: RateInfo; status: number }> {
  const hdr = (res: Response) => (h: string) => res.headers.get(h);

  if (cfg.name === "openrouter") {
    const res = await timed(`${compatBase("openrouter")}/key`, { headers: { authorization: `Bearer ${cfg.apiKey}` } }, timeoutMs);
    const json: any = await res.json().catch(() => null);
    const d = json?.data ?? {};
    const freeLeft = int(d.free_model_daily_requests?.remaining);
    const isFreeModel = cfg.model.endsWith(":free");
    return { status: res.status, info: { rpdRemaining: isFreeModel ? freeLeft : undefined, rpdLimit: isFreeModel ? int(d.free_model_daily_requests?.limit) : undefined } };
  }

  if (cfg.name === "anthropic") {
    const res = await timed(
      `${baseUrl("anthropic")}/v1/messages`,
      { method: "POST", headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }) },
      timeoutMs,
    );
    await res.text().catch(() => "");
    return { status: res.status, info: parseRateHeaders("anthropic", hdr(res)) };
  }

  if (cfg.name in COMPAT) {
    const spec = COMPAT[cfg.name as CompatName];
    const tokenField = cfg.name === "openai" ? "max_completion_tokens" : "max_tokens";
    const body = { model: cfg.model, messages: [{ role: "user", content: "hi" }], [tokenField]: 16, ...(spec.extraBody?.(cfg.model) ?? {}) };
    const res = await timed(
      `${compatBase(cfg.name as CompatName)}/chat/completions`,
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}`, ...(spec.headers ?? {}) }, body: JSON.stringify(body) },
      timeoutMs,
    );
    await res.text().catch(() => "");
    return { status: res.status, info: parseRateHeaders(cfg.name, hdr(res)) };
  }

  return { status: 200, info: {} }; // gemini, mock: nothing to read
}

/**
 * Which keys share one account. Groq (and most providers) count limits per ACCOUNT, not per key, so
 * five keys made in one account give no more capacity than one. Counting them five times made the
 * pool send five times too much at once, and every key got rate-limited together.
 *
 * Keys are probed one after another, so a later key on the same account sees the earlier probe's
 * request already counted: same daily limit, and 1-3 fewer requests left. Keys on separate accounts
 * show unrelated counts (or the same count, when both are fresh). A wrong guess only makes the pool
 * slower, never makes it fail.
 *
 * Returns a group number per key (keys in one group share an account), in probe order.
 */
export function sharedAccountGroups(infos: (RateInfo | null)[]): number[] {
  const groups: number[] = [];
  const lastOf: { info: RateInfo; group: number }[] = [];
  infos.forEach((info, i) => {
    let group = -1;
    if (info && info.rpdLimit !== undefined && info.rpdRemaining !== undefined) {
      for (let g = lastOf.length - 1; g >= 0; g--) {
        const prev = lastOf[g].info;
        const drop = (prev.rpdRemaining ?? NaN) - info.rpdRemaining;
        if (prev.rpdLimit === info.rpdLimit && drop >= 1 && drop <= 3) {
          group = lastOf[g].group;
          lastOf[g].info = info;
          break;
        }
      }
    }
    if (group === -1) {
      group = i;
      if (info) lastOf.push({ info, group });
    }
    groups.push(group);
  });
  return groups;
}
