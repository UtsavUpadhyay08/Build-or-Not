/**
 * All runtime configuration, read once from the environment (env.ts loads .env first).
 * Everything here has a working default, so `npm run dev` with an empty .env runs in mock mode.
 */

export type ProviderName = "anthropic" | "openai" | "gemini" | "groq" | "openrouter" | "opencode" | "mock";
export type PanelMode = "single" | "mixed";

export interface ProviderConfig {
  name: ProviderName;
  apiKey: string;
  model: string;
  rpm: number; // requests per minute budget for this provider's token bucket
  /** How many calls may start back-to-back before the RPM pacing kicks in. Unset = ~10% of RPM. */
  burst?: number;
  /** The key was pasted on the site rather than read from .env (changes how errors are worded). */
  fromSite?: boolean;
  /**
   * Several keys for this provider (the site owner's free keys). apiKey is the first. Calls are
   * spread across them and their limits add up; a key that's rejected or used up is skipped.
   */
  apiKeys?: string[];
  /** OpenRouter only: backup free models it may route to when the first is rate-limited upstream. Filled by the key check. */
  fallbacks?: string[];
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * How persona calls are released when an idea is submitted (PANEL_ALL_AT_ONCE):
 *   unset / auto  measure each key's real limits (rate-limit headers, key info) and send as many at
 *                 once as the key allows right now, then pace the rest to its per-minute limit
 *   true          send all 45 at once, whatever the limits say
 *   false         old fixed pacing: PANEL_CONCURRENCY in flight, bursts of ~10% of *_RPM
 * <NAME>_BURST (e.g. GROQ_BURST=5) pins one provider's burst and wins over all of these.
 */
export type SendMode = "auto" | "all" | "paced";
const rawSend = process.env.PANEL_ALL_AT_ONCE?.trim().toLowerCase() ?? "";
export const SEND_MODE: SendMode = /^(1|true|yes|on|all)$/.test(rawSend) ? "all" : /^(0|false|no|off|paced)$/.test(rawSend) ? "paced" : "auto";
const ALL_AT_ONCE_BURST = 45; // one full panel
export function burstFor(name: string): number | undefined {
  const own = Number(process.env[`${name.toUpperCase()}_BURST`]);
  if (Number.isFinite(own) && own >= 1) return Math.floor(own);
  return SEND_MODE === "all" ? ALL_AT_ONCE_BURST : undefined;
}
/** Fallback requests-per-minute when a provider's limits can't be measured (or PANEL_ALL_AT_ONCE=false). */
const RPM_DEFAULT: Record<string, number> = { anthropic: 50, openai: 60, gemini: 60, groq: 6, opencode: 10, openrouter: 15, mock: 600 };
export function defaultRpm(name: string): number {
  return num(`${name.toUpperCase()}_RPM`, RPM_DEFAULT[name] ?? 10);
}
/** Default model per provider; empty = pick a current free one automatically. */
export function defaultModel(name: string): string {
  if (name === "anthropic") return str("ANTHROPIC_MODEL", str("PERSONA_MODEL", "claude-haiku-4-5"));
  if (name === "openai") return str("OPENAI_MODEL", "gpt-4.1-mini");
  return str(`${name.toUpperCase()}_MODEL`, "");
}

/** True when the user set <NAME>_RPM themselves (then it caps the measured rate too). */
export function rpmIsSet(name: string): boolean {
  return Number(process.env[`${name.toUpperCase()}_RPM`]) > 0;
}

function str(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/**
 * Read an API key defensively: trim whitespace/CR (Windows line endings), strip accidental
 * surrounding quotes, and treat obvious placeholders as "not set".
 */
export function cleanKey(raw: string | undefined): string {
  let k = (raw ?? "").trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1).trim();
  if (/^(your|sk-\.\.\.|<|xxx|changeme|todo)/i.test(k) || k.includes("...")) return "";
  return k;
}

/**
 * Every key set for one provider: <NAME>_API_KEY plus <NAME>_API_KEYS (several keys, separated by
 * commas, spaces or new lines), duplicates removed, in that order.
 */
export function keysFor(name: string): string[] {
  const up = name.toUpperCase();
  const list = [process.env[`${up}_API_KEY`], ...(process.env[`${up}_API_KEYS`] ?? "").split(/[\s,;]+/)].map(cleanKey).filter(Boolean);
  return [...new Set(list)];
}

function buildProviderConfigs(): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  const anthropicKey = keysFor("anthropic")[0] ?? "";
  const openaiKey = keysFor("openai")[0] ?? "";
  const geminiKey = keysFor("gemini")[0] ?? "";
  const groqKey = keysFor("groq")[0] ?? "";
  const openrouterKey = keysFor("openrouter")[0] ?? "";
  const opencodeKey = keysFor("opencode")[0] ?? "";
  if (anthropicKey) {
    out.push({
      name: "anthropic",
      apiKey: anthropicKey,
      // PERSONA_MODEL kept as a fallback name so older .env files keep working.
      model: str("ANTHROPIC_MODEL", str("PERSONA_MODEL", "claude-haiku-4-5")),
      rpm: defaultRpm("anthropic"),
    });
  }
  if (openaiKey) {
    out.push({ name: "openai", apiKey: openaiKey, model: str("OPENAI_MODEL", "gpt-4.1-mini"), rpm: defaultRpm("openai") });
  }
  if (geminiKey) {
    out.push({ name: "gemini", apiKey: geminiKey, model: str("GEMINI_MODEL", ""), rpm: defaultRpm("gemini") });
  }
  // Free OpenAI-compatible providers. Leave *_MODEL empty to auto-pick a free model at startup.
  // Default RPMs are deliberately low to fit free tiers (Groq's binding limit is ~8k tokens/min ≈ 6 calls/min).
  if (groqKey) out.push({ name: "groq", apiKey: groqKey, model: str("GROQ_MODEL", ""), rpm: defaultRpm("groq") });
  if (opencodeKey) out.push({ name: "opencode", apiKey: opencodeKey, model: str("OPENCODE_MODEL", ""), rpm: defaultRpm("opencode") });
  if (openrouterKey) out.push({ name: "openrouter", apiKey: openrouterKey, model: str("OPENROUTER_MODEL", ""), rpm: defaultRpm("openrouter") });
  for (const p of out) {
    p.burst = burstFor(p.name);
    // Several keys for one provider (e.g. GROQ_API_KEYS): one provider, calls spread over all of them.
    const keys = keysFor(p.name);
    if (keys.length > 1) p.apiKeys = keys;
  }
  return out;
}

/**
 * PROVIDERS=groq (or groq,gemini …) limits the panel to those providers even if other keys are set.
 * Handy for running on one free provider without deleting keys from .env.
 */
const only = (process.env.PROVIDERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
/** Keys from .env (filtered by PROVIDERS). Keys pasted on the site are layered on top at runtime. */
export const envProviders: readonly ProviderConfig[] = buildProviderConfigs().filter((p) => only.length === 0 || only.includes(p.name));
const forceMock = process.env.MOCK === "1" || process.env.MOCK === "true";

/** Live binding: flips to false the moment a working key is added on the site (see setRealProviders). */
export let MOCK_MODE = forceMock || envProviders.length === 0;

/**
 * Mock mode still exercises the real machinery (pool, buckets, retries, quorum): we create
 * three fake providers so "mixed" mode works too, with configurable latency and failure rate.
 */
const mockProviders: ProviderConfig[] = ["mock-a", "mock-b", "mock-c"].map((model) => ({
  name: "mock" as const,
  apiKey: "",
  model,
  rpm: num("MOCK_RPM", 600),
  burst: burstFor("mock"),
}));

export const config = {
  port: num("PORT", 4100),
  mongoUri: str("MONGODB_URI", "mongodb://127.0.0.1:27017/build-or-not"),

  providers: (MOCK_MODE ? mockProviders : [...envProviders]) as ProviderConfig[],
  /** "single": every persona uses one provider. "mixed": personas are spread round-robin across all configured providers. */
  panelMode: (str("PANEL_MODE", "single") === "mixed" ? "mixed" : "single") as PanelMode,
  /** Which provider "single" mode uses. Defaults to the first configured one. */
  panelProvider: process.env.PANEL_PROVIDER as ProviderName | undefined,
  /** Global cap on in-flight persona calls (per-provider rate is limited separately by token buckets). */
  /** In-flight cap for "paced" sends (and the eval CLI). "auto" and "all" size it from the measured burst. */
  concurrency: Math.floor(num("PANEL_CONCURRENCY", num("PERSONA_CONCURRENCY", 8))),
  sendMode: SEND_MODE,
  /** Fraction of personas that must succeed for a verdict to be published. */
  quorum: Math.min(1, num("PANEL_QUORUM", 0.8)),
  /** Public-site limits. Counted per visitor IP (hashed) per UTC day, stored in MongoDB so restarts don't reset them. */
  limits: {
    /** Runs a visitor may start on the site's own key (the free tier). */
    freeRunsPerDay: Math.max(0, Math.floor(num("FREE_RUNS_PER_DAY", 3))),
    /** Runs on the simulated models when the site has no key of its own (costs nothing, still capped). */
    simRunsPerDay: Math.max(0, Math.floor(num("SIM_RUNS_PER_DAY", 20))),
    /** Runs a visitor may start with their own key (their quota, but our server's time). */
    ownRunsPerDay: Math.max(0, Math.floor(num("OWN_RUNS_PER_DAY", 20))),
    /** "Fill it in with AI" drafts per visitor per day (one small call each). */
    draftsPerDay: Math.max(0, Math.floor(num("DRAFTS_PER_DAY", 10))),
    /** Key checks per visitor per hour, so the site can't be used to test stolen keys in bulk. */
    keyChecksPerHour: Math.max(1, Math.floor(num("KEY_CHECKS_PER_HOUR", 10))),
    /** All API requests per visitor per minute. */
    apiPerMinute: Math.max(10, Math.floor(num("API_REQUESTS_PER_MINUTE", 120))),
  },
  /** Visitors may paste their own key (used for their run only, never stored). */
  allowOwnKeys: !/^(0|false|no|off)$/i.test(process.env.ALLOW_OWN_KEYS?.trim() ?? ""),
  /** Hops of reverse proxy in front of the app (Render: 1). Needed to see the real visitor IP. */
  trustProxy: Math.max(0, Math.floor(num("TRUST_PROXY", 0))),
  /** Secret mixed into hashed IPs. Set it on the host; changing it resets everyone's daily counts. */
  ipHashSecret: process.env.IP_HASH_SECRET?.trim() || "",
  /** Only needed if the client is served from a different origin than the API. */
  corsOrigin: process.env.CORS_ORIGIN?.trim() || "",

  synthesis: {
    provider: process.env.SYNTHESIS_PROVIDER as ProviderName | undefined,
    model: process.env.SYNTHESIS_MODEL, // optional override of the synthesis provider's model
  },

  retry: {
    maxAttempts: Math.floor(num("RETRY_MAX_ATTEMPTS", 4)),
    baseDelayMs: num("RETRY_BASE_MS", 500),
    maxDelayMs: num("RETRY_MAX_MS", 20_000),
  },
  requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 60_000),

  mock: {
    latencyMs: num("MOCK_LATENCY_MS", 150),
    /** 0..1 — probability a mock call throws a transient 429/503. Set e.g. 0.15 to watch retries + partial failure work. */
    failureRate: Math.min(1, Math.max(0, Number(process.env.MOCK_FAILURE_RATE) || 0)),
    /** 0..1 — probability a mock call returns schema-violating output, to exercise validate-and-re-ask. */
    malformedRate: Math.min(1, Math.max(0, Number(process.env.MOCK_MALFORMED_RATE) || 0)),
  },
};

/** Swap the real provider list (.env keys + keys pasted on the site). No real keys = mock mode. */
export function setRealProviders(list: ProviderConfig[]): void {
  MOCK_MODE = forceMock || list.length === 0;
  config.providers = MOCK_MODE ? mockProviders : list;
}
