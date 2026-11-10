import { useState } from "react";
import { api } from "../api";
import type { ApiMeta, OwnKey, Quota } from "../types";
import { capacityLine, providerLabel } from "./model";

/** Providers a visitor can bring a key for, with where to get one. Free ones first. */
export const KEY_PROVIDERS: { id: string; label: string; free: boolean; where: string; url: string; prefix?: string }[] = [
  { id: "groq", label: "Groq", free: true, where: "console.groq.com → API Keys", url: "https://console.groq.com/keys", prefix: "gsk_" },
  { id: "openrouter", label: "OpenRouter", free: true, where: "openrouter.ai → Keys", url: "https://openrouter.ai/settings/keys", prefix: "sk-or-" },
  { id: "gemini", label: "Gemini", free: true, where: "Google AI Studio → Get API key", url: "https://aistudio.google.com/apikey" },
  { id: "opencode", label: "OpenCode Zen", free: true, where: "opencode.ai", url: "https://opencode.ai" },
  { id: "openai", label: "OpenAI", free: false, where: "platform.openai.com → API keys", url: "https://platform.openai.com/api-keys", prefix: "sk-" },
  { id: "anthropic", label: "Anthropic", free: false, where: "console.anthropic.com → API keys", url: "https://console.anthropic.com/settings/keys", prefix: "sk-ant-" },
];

// ---------- keys remembered in this browser (only if the visitor ticks the box) ----------

const STORE = "bon.ownkeys.v2";
export function loadRememberedKeys(): OwnKey[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return Array.isArray(v) ? v.filter((k) => k && typeof k.provider === "string" && typeof k.apiKey === "string" && k.capacity) : [];
  } catch {
    return [];
  }
}
function saveRemembered(keys: OwnKey[]) {
  try {
    if (keys.length) localStorage.setItem(STORE, JSON.stringify(keys));
    else localStorage.removeItem(STORE);
  } catch {
    /* storage blocked: nothing is remembered */
  }
}
// Old builds stored keys under another name; clear them.
try {
  localStorage.removeItem("bon.keys.v1");
} catch {
  /* ignore */
}

export type KeyMode = "free" | "own";

interface Props {
  meta: ApiMeta | null;
  quota: Quota | null;
  keyMode: KeyMode;
  onKeyMode: (m: KeyMode) => void;
  ownKeys: OwnKey[];
  onOwnKeys: (keys: OwnKey[], added?: string) => void;
  locked: boolean;
}

/**
 * How this visitor's run is paid for: the site's free tier (a few runs a day), or their own key.
 * Own keys stay in this browser. They're sent with this visitor's runs only, and the server keeps none.
 */
export function RunOptions({ meta, quota, keyMode, onKeyMode, ownKeys, onOwnKeys, locked }: Props) {
  const [provider, setProvider] = useState("groq");
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(() => loadRememberedKeys().length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const ownAllowed = meta?.ownKeys !== false;
  const site = quota?.site;
  const simulated = site?.kind === "sim" || meta?.mock;
  const siteModels = meta?.providers.filter((p) => p.usable).map((p) => (p.name === "mock" ? p.model : `${providerLabel(p.name)} · ${p.model}`)) ?? [];
  const spec = KEY_PROVIDERS.find((p) => p.id === provider)!;
  const prefixWarn = spec.prefix && key.trim() && !key.trim().startsWith(spec.prefix) ? `${spec.label} keys usually start with “${spec.prefix}”.` : null;
  const resets = quota ? new Date(quota.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

  async function add() {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const res = await api.checkKey(provider, key.trim());
      const entry: OwnKey = { provider: res.provider, apiKey: key.trim(), model: res.model, capacity: res.capacity };
      const next = [...ownKeys.filter((k) => k.provider !== entry.provider), entry];
      onOwnKeys(next, entry.provider);
      saveRemembered(remember ? next : []);
      setKey("");
      setOk(`${spec.label} key works (${res.model}). It can take ${capacityLine(res.capacity)}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function remove(p: string) {
    const next = ownKeys.filter((k) => k.provider !== p);
    onOwnKeys(next);
    saveRemembered(remember ? next : []);
    setOk(null);
  }

  function toggleRemember(on: boolean) {
    setRemember(on);
    saveRemembered(on ? ownKeys : []);
  }

  return (
    <fieldset className="parch-set keys-set">
      <legend>HOW TO RUN IT</legend>

      <label className={`radio-row run-opt ${keyMode === "free" ? "on" : ""}`}>
        <input type="radio" name="key-mode" checked={keyMode === "free"} disabled={locked} onChange={() => onKeyMode("free")} />
        <span>
          <strong>{simulated ? "Try it free (simulated models)" : "Use the free tier"}</strong>
          {site ? (
            <span className={`runs-left ${site.left === 0 ? "none" : ""}`}>
              {site.left} of {site.limit} runs left today
            </span>
          ) : null}
          <span className="run-sub">
            {simulated
              ? "The site has no AI key of its own, so the council runs on simulated models. Good for seeing how it works; the verdicts aren't real."
              : `Runs on the site's ${siteModels.join(", ") || "AI key"}. Each visitor gets ${site?.limit ?? 3} runs a day${resets ? `; more after ${resets}` : ""}.`}
          </span>
        </span>
      </label>

      {ownAllowed && (
        <label className={`radio-row run-opt ${keyMode === "own" ? "on" : ""}`}>
          <input type="radio" name="key-mode" checked={keyMode === "own"} disabled={locked} onChange={() => onKeyMode("own")} />
          <span>
            <strong>Use my own API key</strong>
            <span className="run-sub">Real models, on your own quota. Your key is only ever used for your runs, and never stored on the server.</span>
          </span>
        </label>
      )}

      {keyMode === "own" && ownAllowed && (
        <div className="own-keys">
          {ownKeys.length > 0 && (
            <ul className="key-list">
              {ownKeys.map((k) => (
                <li key={k.provider} className="key-row">
                  <div className="key-head">
                    <strong>{providerLabel(k.provider)}</strong>
                    <span className="key-model">{k.model}</span>
                    <span className="key-src own">your key · {maskKey(k.apiKey)}</span>
                  </div>
                  <div className="key-cap">
                    <span className="key-cap-main">Sends {capacityLine(k.capacity)}</span>
                    <details>
                      <summary>How this was worked out</summary>
                      <p>{k.capacity.detail}</p>
                    </details>
                  </div>
                  {!locked && (
                    <button type="button" className="link-btn key-remove" onClick={() => remove(k.provider)}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!locked && (
            <div className="key-add">
              <div className="key-add-row">
                <label className="field-label key-provider">
                  Provider
                  <select className="field" value={provider} onChange={(e) => (setProvider(e.target.value), setError(null))}>
                    {KEY_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                        {p.free ? " (free)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label key-input">
                  API key
                  <input
                    className="field"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={spec.prefix ? `${spec.prefix}…` : "Paste your key"}
                    value={key}
                    onChange={(e) => (setKey(e.target.value), setError(null))}
                    onKeyDown={(e) => e.key === "Enter" && key.trim() && !busy && add()}
                  />
                </label>
              </div>
              <div className="key-add-foot">
                <label className="check-row">
                  <input type="checkbox" checked={remember} onChange={(e) => toggleRemember(e.target.checked)} />
                  <span>Remember on this device</span>
                </label>
                <a className="key-where" href={spec.url} target="_blank" rel="noreferrer noopener">
                  Get a key: {spec.where}
                </a>
              </div>
              {prefixWarn && <span className="warn-text">{prefixWarn}</span>}
              <button type="button" className="parch-btn key-check" disabled={!key.trim() || busy} onClick={add}>
                {busy ? "Checking the key and measuring its limits…" : ownKeys.length ? "Add another key" : "Check key and measure its limits"}
              </button>
              <p className="key-note">
                One tiny request reads your key's rate limits, so the council can send as many questions at once as it allows. The key stays in this tab (and in this browser only if you tick “Remember”). The server uses it for your run and then forgets it. Don't tick “Remember” on a shared computer.
              </p>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {ok && keyMode === "own" && (
        <div className="form-ok" role="status">
          {ok}
        </div>
      )}
    </fieldset>
  );
}

/** "gsk_ab…9xQz": enough to tell keys apart, not enough to use. */
export function maskKey(k: string): string {
  return k.length <= 10 ? "••••" : `${k.slice(0, 5)}…${k.slice(-4)}`;
}
