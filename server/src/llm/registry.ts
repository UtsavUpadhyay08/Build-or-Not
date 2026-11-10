/**
 * Builds the set of managed (rate-limited + retrying) providers, decides which provider judges
 * which persona, and works out how fast each key can be driven.
 *
 * Two kinds of provider:
 *   - the site's own keys (from the host's environment): shared, the "free tier"
 *   - a visitor's own keys (privateCouncil): built per run, used only for that run, never stored
 */
import { burstFor, cleanKey, config, defaultModel, defaultRpm, MOCK_MODE, rpmIsSet, type PanelMode, type ProviderConfig } from "../config.js";
import { bucketFor, ManagedProvider } from "./managed.js";
import { bucketFromRpm, TokenBucket } from "../core/tokenBucket.js";
import { redactSecrets } from "./redact.js";
import { createProvider } from "./providers.js";
import { checkProvider, type ProviderHealth } from "./keyCheck.js";
import { buildSendPlan, estimateTokensPerCall, planCapacity, probeRateInfo, type Capacity, type RateInfo, type SendPlan } from "./capacity.js";

/** Stable id the UI uses to pick providers. Mock mode has three "mock" providers, told apart by model. */
export function providerKey(p: { name: string; model: string }): string {
  return p.name === "mock" ? p.model : p.name;
}

// ---------- managed providers, reused as long as their config and model are unchanged ----------

const managed = new WeakMap<ProviderConfig, { model: string; p: ManagedProvider }>();
const cfgOf = new WeakMap<ManagedProvider, ProviderConfig>();

function manage(cfg: ProviderConfig, modelOverride?: string): ManagedProvider {
  // Mock "providers" each get their own bucket so mixed mode behaves like three accounts.
  const bucketKey = cfg.name === "mock" ? cfg.model : cfg.name;
  const p = new ManagedProvider(createProvider(cfg, modelOverride), bucketFor(bucketKey, cfg.rpm, cfg.burst));
  cfgOf.set(p, cfg);
  return p;
}

/** Every configured provider, healthy or not (for stats / display). */
export function allProviders(): ManagedProvider[] {
  return config.providers.map((cfg) => {
    const hit = managed.get(cfg);
    if (hit && hit.model === cfg.model) return hit.p;
    const p = manage(cfg);
    managed.set(cfg, { model: cfg.model, p });
    return p;
  });
}

/** Providers that passed the key check and haven't tripped their circuit breaker. */
export function panelProviders(): ManagedProvider[] {
  return allProviders().filter((p) => !p.unavailableReason);
}

export function hasUsableProvider(): boolean {
  return panelProviders().length > 0;
}

// ---------- key checks ----------

let health: ProviderHealth[] = [];
export function providerHealth(): ProviderHealth[] {
  // Reflect breakers tripped after startup too.
  return health
    .filter((h) => config.providers.some((c) => c.name === h.name))
    .map((h) => {
      const p = allProviders().find((x) => x.name === h.name);
      return p?.disabledReason && h.status === "ok" ? { ...h, status: (p.disabledStatus ?? "bad_key") as ProviderHealth["status"], message: p.disabledReason, note: undefined } : h;
    });
}

/** Check keys (all of them by default) and switch off whatever fails. Results replace earlier ones per provider. */
export async function runHealthChecks(cfgs: ProviderConfig[] = config.providers): Promise<ProviderHealth[]> {
  // checkProvider may fill in an empty model (auto-pick a free one), so look providers up afterwards.
  const results = await Promise.all(cfgs.map((cfg) => checkProvider(cfg)));
  synthesisCache = null;
  synthesisDisabled = null;
  const all = allProviders();
  results.forEach((h, i) => {
    const cfg = cfgs[i];
    const p = all[config.providers.indexOf(cfg)];
    if (!p) return;
    p.disabledReason = null;
    p.disabledStatus = null;
    if (h.status !== "ok" && h.status !== "unreachable") p.disabledReason = h.message;
    else if (!cfg.model) p.disabledReason = `${cfg.name}: couldn't reach it to pick a free model. Set ${cfg.name.toUpperCase()}_MODEL in .env.`;
  });
  const fresh = results.map((h, i) => ({ ...h, model: cfgs[i].model || h.model }));
  health = [...health.filter((h) => !fresh.some((f) => f.name === h.name) && !h.message.startsWith("(synthesis)")), ...fresh];

  // The synthesis model can differ from the persona model (e.g. Sonnet vs Haiku): check it as well.
  const synth = synthesisConfig();
  const synthProviderOk = synth && health.some((h) => h.name === synth.cfg.name && h.status === "ok");
  if (synth && synthProviderOk && !health.some((h) => h.name === synth.cfg.name && h.model === synth.model)) {
    const h = await checkProvider({ ...synth.cfg, model: synth.model });
    if (h.status !== "ok" && h.status !== "unreachable") {
      synthesisDisabled = h.message;
      health.push({ ...h, message: `(synthesis) ${h.message} Falling back to the persona model for theme extraction.` });
    }
  }
  return fresh;
}

// ---------- a visitor's own keys: a private council for one run ----------

export const OWN_KEY_PROVIDERS = ["groq", "openrouter", "gemini", "opencode", "openai", "anthropic"] as const;
export type OwnKeyProvider = (typeof OWN_KEY_PROVIDERS)[number];
export interface OwnKey {
  provider: OwnKeyProvider;
  apiKey: string;
  model?: string;
}

/** Providers built from a visitor's keys. Marked so nothing shared (capacity cache, meta) ever records them. */
const privateProviders = new WeakSet<ManagedProvider>();
export const isPrivate = (p: ManagedProvider) => privateProviders.has(p);

/**
 * Check a visitor's keys and build providers from them that belong to this request only:
 * fresh rate-limit buckets (not the shared per-provider ones), not added to config.providers,
 * not cached. When the run ends nothing references them and the keys are garbage-collected.
 * Keys that fail the check are reported, not used.
 */
export async function privateCouncil(keys: OwnKey[]): Promise<{ providers: ManagedProvider[]; problems: { provider: string; message: string }[] }> {
  const seen = new Set<string>();
  const unique = keys.filter((k) => !seen.has(k.provider) && seen.add(k.provider));
  const results = await Promise.all(
    unique.map(async (k) => {
      const cfg: ProviderConfig = { name: k.provider, apiKey: cleanKey(k.apiKey), model: k.model?.trim() || defaultModel(k.provider), rpm: defaultRpm(k.provider), fromSite: true };
      const h = await checkProvider(cfg); // may fill in an empty model with a current free one
      if (h.status !== "ok") return { problem: { provider: k.provider, message: redactSecrets(h.message, [cfg.apiKey]) } };
      const fallback = bucketFromRpm(cfg.rpm);
      const p = new ManagedProvider(createProvider(cfg), new TokenBucket(fallback.capacity, fallback.refillPerSec));
      cfgOf.set(p, cfg);
      privateProviders.add(p);
      return { provider: p };
    }),
  );
  return {
    providers: results.flatMap((r) => (r.provider ? [r.provider] : [])),
    problems: results.flatMap((r) => (r.problem ? [r.problem] : [])),
  };
}

// ---------- capacity: how many calls can start at once, and how fast after that ----------

const capacities = new Map<string, Capacity>();

export function capacityOf(p: { name: string; model: string }): Capacity | null {
  return capacities.get(providerKey(p)) ?? null;
}

/**
 * Measure one provider's limits right now and resize its token bucket to match.
 * Never throws: if the provider can't be reached, the last measurement (or the RPM setting) is used.
 */
export async function measureProvider(p: ManagedProvider, ideaChars?: number, timeoutMs = 6000): Promise<Capacity> {
  const cfg = cfgOf.get(p) ?? config.providers.find((c) => c.name === p.name)!;
  const remember = (c: Capacity) => {
    if (!isPrivate(p)) capacities.set(providerKey(p), c); // a visitor's key is never cached or shown to others
  };
  const tokensPerCall = estimateTokensPerCall(ideaChars, p.avgTokensPerCall);
  const mode = config.sendMode;
  let cap: Capacity;

  if (mode === "paced") {
    const burst = p.bucket.capacity;
    cap = {
      now: burst,
      burst,
      perMinute: cfg.rpm,
      dailyLeft: null,
      tokensPerCall,
      source: "setting",
      detail: `Paced (PANEL_ALL_AT_ONCE=false): up to ${config.concurrency} at a time, ${cfg.rpm} a minute.`,
      checkedAt: new Date().toISOString(),
    };
    remember(cap);
    return cap; // leave the bucket as configured
  }

  let info: RateInfo = {};
  let note = "";
  if (cfg.name !== "mock" && mode === "auto") {
    try {
      info = (await probeRateInfo(cfg, timeoutMs)).info;
    } catch (err) {
      const last = isPrivate(p) ? undefined : capacities.get(providerKey(p));
      if (last) return last;
      note = ` Couldn't reach ${cfg.name} to measure (${redactSecrets((err as Error).message, [cfg.apiKey])}).`;
    }
  }
  cap = planCapacity(cfg.name, info, {
    tokensPerCall,
    rpmSetting: rpmIsSet(cfg.name) ? cfg.rpm : undefined,
    rpmFallback: cfg.rpm,
    burstPin: burstFor(cfg.name),
    source: mode === "all" ? "forced" : cfg.name === "mock" ? "simulated" : undefined,
  });
  if (note) cap = { ...cap, detail: cap.detail + note };
  p.bucket.reconfigure(cap.burst, cap.perMinute / 60, cap.now);
  remember(cap);
  return cap;
}

/** Measure every usable provider (the preliminary check at startup). */
export async function measureAll(): Promise<void> {
  await Promise.all(panelProviders().map((p) => measureProvider(p)));
}

/**
 * Just before a run: re-measure each provider on the council (limits change minute to minute and
 * with earlier runs), resize their buckets, and describe the plan for the UI.
 */
export async function planRun(assignments: ManagedProvider[], ideaChars: number): Promise<SendPlan> {
  const counts = new Map<ManagedProvider, number>();
  for (const p of assignments) counts.set(p, (counts.get(p) ?? 0) + 1);
  const items = await Promise.all(
    [...counts].map(async ([p, personas]) => ({ key: providerKey(p), name: p.name, model: p.model, personas, cap: await measureProvider(p, ideaChars) })),
  );
  const plan = buildSendPlan(config.sendMode, items);
  if (config.sendMode === "paced") plan.concurrency = config.concurrency;
  return plan;
}

// ---------- council assignment ----------

/** The provider used for "single" mode panels (and the single-prompt baseline in eval). */
export function primaryProvider(): ManagedProvider {
  const all = panelProviders().length ? panelProviders() : allProviders();
  const wanted = config.panelProvider;
  return (wanted && all.find((p) => p.name === wanted)) || all[0];
}

let synthesisCache: ManagedProvider | null = null;
let synthesisDisabled: string | null = null;

function synthesisConfig(): { cfg: ProviderConfig; model: string } | null {
  const primary = primaryProvider();
  if (!primary) return null;
  const cfg = (config.synthesis.provider && config.providers.find((p) => p.name === config.synthesis.provider)) || config.providers.find((p) => p.name === primary.name)!;
  const model = config.synthesis.model ?? (cfg.name === "anthropic" ? "claude-sonnet-4-5" : cfg.model);
  return { cfg, model };
}

export function synthesisProvider(): ManagedProvider {
  // If the dedicated synthesis model failed its check (or its provider is down), use the primary persona provider.
  if (synthesisDisabled) return primaryProvider();
  const s = synthesisConfig()!;
  if (!synthesisCache || synthesisCache.name !== s.cfg.name || synthesisCache.model !== s.model) synthesisCache = manage(s.cfg, s.model);
  if (synthesisCache.unavailableReason || panelProviders().every((p) => p.name !== synthesisCache!.name)) return primaryProvider();
  return synthesisCache;
}

/**
 * Round-robin assignment over the persona list. The persona library is ordered by category
 * (9 per category), so with 3 providers each provider judges exactly 3 personas from every
 * category — provider effects and category effects aren't confounded.
 */
export function assignProviders<P>(personas: readonly P[], mode: PanelMode, providers: ManagedProvider[] = panelProviders()): ManagedProvider[] {
  // Nothing healthy: still assign real providers so each call fails fast with the explanatory message.
  if (providers.length === 0) providers = allProviders();
  if (mode === "single" || providers.length === 1) {
    const p = mode === "single" ? primaryProvider() : providers[0];
    return personas.map(() => p);
  }
  return personas.map((_, i) => providers[i % providers.length]);
}

export { MOCK_MODE };
