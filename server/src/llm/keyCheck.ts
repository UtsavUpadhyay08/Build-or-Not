/**
 * Startup health check for each configured provider. Free (no tokens), fast, and it checks the
 * key AND the model name:
 *
 *   Anthropic / Gemini   GET the model itself              200 ok · 401/403 bad key · 404 bad model
 *   OpenAI / Groq /      GET {base}/models (list)          401 bad key · model missing from list = bad model
 *   OpenCode             (if *_MODEL is empty, a free model is picked from that list automatically)
 *   OpenRouter           GET /key (its model list is public, so it can't validate a key)
 *
 * Providers that fail are taken off the panel, so a bad key costs one check at boot instead of
 * 45 failed persona calls per idea.
 */
import type { ProviderConfig, ProviderName } from "../config.js";
import { baseUrl } from "./providers.js";
import { COMPAT, compatBase, type CompatName } from "./openaiCompatible.js";

export type HealthStatus = "ok" | "bad_key" | "bad_model" | "no_credit" | "quota" | "unreachable" | "error";

export interface ProviderHealth {
  name: ProviderName;
  model: string;
  keyHint: string; // masked, safe to log/show
  status: HealthStatus;
  message: string;
  /** Set when the model was picked automatically or the provider wants to tell us something (e.g. free-tier limits). */
  note?: string;
}

const ENV_VAR: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  opencode: "OPENCODE_API_KEY",
};
// (No Gemini prefix: Google issues both "AIza…" API keys and newer "AQ.…" keys.)
const NICE: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", groq: "Groq", openrouter: "OpenRouter", opencode: "OpenCode" };
const KEY_PREFIX: Record<string, string> = { anthropic: "sk-ant-", openai: "sk-", groq: "gsk_", openrouter: "sk-or-" };
const isCompat = (n: string): n is CompatName => n in COMPAT;

/** Free models we'd rather use when auto-picking, best first. Matched as substrings of model ids. */
const PREFERRED = ["gpt-oss-120b", "llama-3.3-70b", "deepseek-v4", "deepseek-v3", "deepseek", "qwen3", "llama-4", "glm", "kimi", "gemma", "mistral", "gpt-oss-20b"];
/** Never auto-pick these: wrong job (code, speech, images, embeddings, safety classifiers). */
const UNSUITABLE = /coder|code-|vision|whisper|tts|audio|embed|guard|moderation|image|ocr|distil/i;

/** "sk-ant-a…9xQz (108 chars)" — enough to recognise which key it is, useless to anyone else. */
export function maskKey(key: string): string {
  if (key.length < 12) return `(${key.length} chars — too short to be a real key)`;
  return `${key.slice(0, 7)}…${key.slice(-4)} (${key.length} chars)`;
}

export function classify(name: string, status: number, body: string): HealthStatus {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "bad_key";
  if (name === "gemini" && status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) return "bad_key";
  if (status === 402 || /insufficient_quota|credit balance|billing|insufficient credits/i.test(body)) return "no_credit";
  // Daily caps on free tiers: retrying in 20s can't help, the limit resets tomorrow.
  if (status === 429 && /per[- ]day|daily|free-models-per-day|\bRPD\b|\bTPD\b|tokens per day|requests per day/i.test(body)) return "quota";
  if (status === 404) return "bad_model";
  return "error";
}

export function explain(cfg: Pick<ProviderConfig, "name" | "model" | "apiKey" | "fromSite">, status: HealthStatus, detail: string): string {
  const envVar = ENV_VAR[cfg.name] ?? `${cfg.name.toUpperCase()}_API_KEY`;
  if (cfg.fromSite) {
    // A visitor's own key: plain words, nothing about .env or server settings.
    const P = NICE[cfg.name] ?? cfg.name;
    const prefix = KEY_PREFIX[cfg.name];
    const hint = prefix && cfg.apiKey && !cfg.apiKey.startsWith(prefix) ? ` ${P} keys start with "${prefix}".` : "";
    if (status === "bad_key") return `${P} didn’t accept this key. Check you copied all of it, or make a new one.${hint}`;
    if (status === "bad_model") return `Your key works, but ${P} has no model called "${cfg.model}". Try again and we’ll pick a current one.`;
    if (status === "no_credit") return `Your ${P} key works, but the account has no credit. Add credit, or use a free key (Groq is free).`;
    if (status === "quota") return `Your ${P} key has used up its free limit for today. It resets within 24 hours.`;
    if (status === "unreachable") return `Couldn’t reach ${P} just now. Try again in a minute.`;
  }
  const modelVar = `${cfg.name.toUpperCase()}_MODEL`;
  switch (status) {
    case "ok":
      return "key and model OK";
    case "bad_key": {
      const prefix = KEY_PREFIX[cfg.name];
      const prefixHint = prefix && cfg.apiKey && !cfg.apiKey.startsWith(prefix) ? ` ${cfg.name} keys normally start with "${prefix}". This one doesn't, so it may be a different kind of key or token.` : "";
      return `${cfg.name} rejected the key in ${envVar}. It's wrong, revoked, or from another account. Create a new key and paste it into .env.${prefixHint}`;
    }
    case "bad_model":
      return `The key works, but ${cfg.name} has no model called "${cfg.model}". ${detail || `Set ${modelVar} in .env to a current model name.`}`;
    case "no_credit":
      return `The ${cfg.name} key is valid but the account has no credit. Add billing, or use a free provider.`;
    case "quota":
      return `${cfg.name}'s free daily limit is used up for "${cfg.model}". It resets within 24 hours; other providers take over meanwhile.`;
    case "unreachable":
      return `Couldn't reach ${cfg.name} (${detail}). Check your internet connection, VPN, or firewall.`;
    default:
      return `${cfg.name} returned an unexpected error: ${detail}`;
  }
}

async function get(url: string, headers: Record<string, string>, timeoutMs: number) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json };
}

/** Suitable free models, best first (preferred families in order, then the rest). */
export function rankFree(ids: string[], isFree: (id: string) => boolean = () => true): string[] {
  const free = ids.filter((id) => isFree(id) && !UNSUITABLE.test(id));
  const ranked: string[] = [];
  for (const pref of PREFERRED) for (const id of free) if (id.toLowerCase().includes(pref) && !ranked.includes(id)) ranked.push(id);
  for (const id of free) if (!ranked.includes(id)) ranked.push(id);
  return ranked;
}

export function pickFreeModel(ids: string[], isFree: (id: string) => boolean = () => true): string | null {
  return rankFree(ids, isFree)[0] ?? null;
}

/** Newest stable "flash" model (free tier), avoiding lite/preview/image/tts/live variants when possible. */
export function pickGeminiModel(ids: string[]): string | null {
  const usable = ids.filter((id) => id.startsWith("gemini") && !/tts|image|live|audio|embedding|thinking-exp|robotics|computer-use/.test(id));
  const version = (id: string) => Number(id.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const score = (id: string) => (id.includes("flash") ? 100 : 0) - (id.includes("lite") ? 20 : 0) - (/preview|exp/.test(id) ? 10 : 0) + version(id);
  return [...usable].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * Paid providers: a valid key on an account with no credit passes every free check and then fails
 * every real call. One 1-token request (costs a tiny fraction of a cent) tells the two apart.
 */
async function creditProbe(cfg: ProviderConfig, base: Omit<ProviderHealth, "status" | "message">, timeoutMs: number, note?: string): Promise<ProviderHealth> {
  const req: { url: string; headers: Record<string, string>; body: unknown } =
    cfg.name === "anthropic"
      ? { url: `${baseUrl("anthropic")}/v1/messages`, headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }, body: { model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] } }
      : { url: `${compatBase("openai")}/chat/completions`, headers: { authorization: `Bearer ${cfg.apiKey}` }, body: { model: cfg.model, max_completion_tokens: 16, messages: [{ role: "user", content: "hi" }] } };
  const res = await fetch(req.url, { method: "POST", headers: { "content-type": "application/json", ...req.headers }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(timeoutMs) });
  const text = res.ok ? "" : await res.text().catch(() => "");
  const status = classify(cfg.name, res.status, text);
  // A transient hiccup (429/5xx) doesn't prove the account is broken; keep the provider and let retries handle it.
  if (status === "ok" || status === "error") return { ...base, status: "ok", message: "key and model OK", note };
  return { ...base, status, message: explain(cfg, status, `HTTP ${res.status} ${text.slice(0, 200)}`), note };
}

/**
 * Checks one provider. May set cfg.model when it was left empty (auto-pick) — the caller must
 * build providers AFTER this runs.
 */
export async function checkProvider(cfg: ProviderConfig, timeoutMs = 10_000): Promise<ProviderHealth> {
  const base = () => ({ name: cfg.name, model: cfg.model || "(auto)", keyHint: maskKey(cfg.apiKey) });
  if (cfg.name === "mock") return { ...base(), keyHint: "(mock)", status: "ok", message: "mock provider" };

  try {
    if (cfg.name === "anthropic") {
      const r = await get(`${baseUrl("anthropic")}/v1/models/${encodeURIComponent(cfg.model)}`, { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }, timeoutMs);
      const status = classify(cfg.name, r.status, r.text);
      if (status !== "ok") return { ...base(), status, message: explain(cfg, status, status === "error" ? `HTTP ${r.status} ${r.text.slice(0, 200)}` : "") };
      return creditProbe(cfg, base(), timeoutMs);
    }

    if (cfg.name === "gemini") {
      // List models: validates the key, and lets us replace a retired/empty GEMINI_MODEL with a current Flash model.
      const r = await get(`${baseUrl("gemini")}/v1beta/models?pageSize=200`, { "x-goog-api-key": cfg.apiKey }, timeoutMs);
      const status = classify(cfg.name, r.status, r.text);
      if (status !== "ok") return { ...base(), status, message: explain(cfg, status, `HTTP ${r.status} ${r.text.slice(0, 200)}`) };
      const ids: string[] = (r.json?.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m.name).replace(/^models\//, ""));
      if (cfg.model && ids.includes(cfg.model)) return { ...base(), status: "ok", message: "key and model OK" };
      const picked = pickGeminiModel(ids);
      if (!picked) return { ...base(), status: "bad_model", message: explain(cfg, "bad_model", "Set GEMINI_MODEL in .env to a current model from Google AI Studio.") };
      const was = cfg.model;
      cfg.model = picked;
      return { ...base(), status: "ok", message: "key and model OK", note: was ? `"${was}" isn't available any more; using "${picked}" instead (set GEMINI_MODEL to change it)` : `auto-picked "${picked}" (set GEMINI_MODEL to choose another)` };
    }

    if (!isCompat(cfg.name)) return { ...base(), status: "error", message: `unknown provider ${cfg.name}` };
    const spec = COMPAT[cfg.name];
    const auth = { authorization: `Bearer ${cfg.apiKey}` };
    let note: string | undefined;

    // 1. Key validity
    if (cfg.name === "openrouter") {
      const k = await get(`${compatBase("openrouter")}/key`, auth, timeoutMs);
      const status = classify(cfg.name, k.status, k.text);
      if (status !== "ok") return { ...base(), status, message: explain(cfg, status, `HTTP ${k.status} ${k.text.slice(0, 200)}`) };
      if (k.json?.data?.is_free_tier) note = "OpenRouter free tier: about 50 free-model requests per day (1,000 after a one-time $10 top-up).";
    }
    const list = await get(`${compatBase(cfg.name)}/models`, auth, timeoutMs);
    const listStatus = classify(cfg.name, list.status, list.text);
    if (listStatus !== "ok") return { ...base(), status: listStatus, message: explain(cfg, listStatus, `HTTP ${list.status} ${list.text.slice(0, 200)}`) };

    // 2. Model: auto-pick a free one, or verify the configured one exists
    const ids: string[] = Array.isArray(list.json?.data) ? list.json.data.map((m: any) => String(m.id)) : [];
    const missing = !cfg.model || (ids.length > 0 && !ids.includes(cfg.model));
    if (missing) {
      // Empty, retired or misspelled model: pick a working free one rather than switching the provider off.
      const picked = pickFreeModel(ids, spec.isFree);
      if (!picked) return { ...base(), status: "bad_model", message: explain(cfg, "bad_model", `Set ${cfg.name.toUpperCase()}_MODEL in .env to a model that exists.`) };
      const was = cfg.model;
      cfg.model = picked;
      const why = was ? `"${was}" doesn't exist any more; using free model "${picked}" instead` : `auto-picked free model "${picked}"`;
      note = [`${why} (set ${cfg.name.toUpperCase()}_MODEL to choose another)`, note].filter(Boolean).join(" · ");
    }
    if (cfg.name === "openrouter") {
      // Backups OpenRouter can route to when the main free model is rate-limited upstream (common on free models).
      cfg.fallbacks = rankFree(ids, spec.isFree).filter((id) => id !== cfg.model).slice(0, 2);
    }
    if (cfg.name === "openai") return creditProbe(cfg, { ...base(), model: cfg.model }, timeoutMs, note);
    return { ...base(), status: "ok", message: "key and model OK", note };
  } catch (err) {
    return { ...base(), status: "unreachable", message: explain(cfg, "unreachable", (err as Error).message) };
  }
}
