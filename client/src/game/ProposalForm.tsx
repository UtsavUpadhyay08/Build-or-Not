import type { ReactNode } from "react";
import { useId, useRef, useState } from "react";
import type { ApiMeta, IdeaBrief, IdeaSliders, PanelMode } from "../types";
import { PRODUCT_CONTEXT_MAX, SLIDER_FIELDS } from "../types";
import { useAuth } from "../auth";
import { previewPlan } from "./model";

export interface Council {
  mode: PanelMode;
  single: string; // provider key
  mixed: string[]; // provider keys
}

interface Props {
  brief: IdeaBrief;
  onBrief: (b: IdeaBrief) => void;
  council: Council;
  onCouncil: (c: Council) => void;
  meta: ApiMeta | null;
  locked: boolean;
  submitting: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onReset?: () => void;
  error: string | null;
  /** "How to run it" (free tier vs own key), rendered above the council. */
  keysSlot?: ReactNode;
  /** Why the council can't be summoned right now (no runs left, no key yet), if it can't. */
  blocked?: string | null;
  /** Open the "just type your idea" popup. */
  onQuickStart?: () => void;
}

const SHORT_SLIDERS: Record<keyof IdeaSliders, [string, string]> = {
  reach: ["Very few", "Almost everyone"],
  buildCost: ["Quick and cheap", "Slow and costly"],
  userImportance: ["Minor users", "Your best users"],
  complexity: ["Easy", "Hard"],
  value: ["Nice to have", "Fixes a real pain"],
  risk: ["Low", "High"],
};

export function ProposalForm({ brief, onBrief, council, onCouncil, meta, locked, submitting, submitLabel, onSubmit, onReset, error, keysSlot, blocked, onQuickStart }: Props) {
  const set = <K extends keyof IdeaBrief>(k: K, v: IdeaBrief[K]) => onBrief({ ...brief, [k]: v });
  const { user } = useAuth();
  const feature = brief.kind === "feature";
  const product = brief.productContext ?? "";
  const productOk = !feature || product.trim().length >= 40;
  const usable = meta?.providers.filter((p) => p.usable) ?? [];
  const unusable = meta?.providers.filter((p) => !p.usable) ?? [];
  const label = (p: { name: string; model: string }) => (p.name === "mock" ? `${p.model} (simulated)` : `${p.name} · ${p.model}`);
  const mixedOk = usable.length >= 2;
  const councilValid = council.mode === "single" ? usable.some((p) => p.key === council.single) || meta?.mock : council.mixed.length >= 2;
  const canSubmit = !locked && !submitting && !blocked && !(brief.hidden && !user) && brief.title.trim() && brief.description.trim() && councilValid && productOk && product.length <= PRODUCT_CONTEXT_MAX;
  // Say why the button is greyed out, instead of leaving people clicking a button that does nothing.
  const missing = locked || submitting || blocked
    ? null
    : brief.hidden && !user
      ? "Private runs need an account: sign in, or untick “Keep this run private”."
    : feature && !product.trim()
      ? "Add your product’s description first (upload its description.md, or paste a few lines)."
      : feature && !productOk
        ? "Tell the council a little more about your product (a few lines at least)."
        : product.length > PRODUCT_CONTEXT_MAX
          ? `Shorten the product description to ${PRODUCT_CONTEXT_MAX.toLocaleString("en")} characters.`
          : !brief.title.trim() && !brief.description.trim()
      ? "Add a name and a description first (or use “Just type your idea”)."
      : !brief.title.trim()
        ? "Add a name for the idea first."
        : !brief.description.trim()
          ? "Add a short description first."
          : !councilValid
            ? usable.length === 0
              ? "No AI is working on the site right now, so the council can’t meet. Use your own key, or try again later."
              : council.mode === "single"
                ? "Pick which AI the council uses (under “Which AI answers”)."
                : "Pick at least 2 AIs for a mixed council."
            : null;
  const councilKeys = council.mode === "single" ? (council.single ? [council.single] : []) : council.mixed;
  const preview = previewPlan(meta, councilKeys, meta?.personaCount ?? 45);

  return (
    <section className="proposal" aria-labelledby="proposal-h">
      <div>
        <div className="eyebrow">YOUR IDEA</div>
        <h2 id="proposal-h">{feature ? "What feature do you want to add?" : "What do you want to build?"}</h2>
        <p className="proposal-hint">{locked ? "Locked while the council votes." : "All 45 personas read everything you write here."}</p>
      </div>

      <KindPick feature={feature} locked={locked} onStartup={() => set("kind", "startup")} onFeature={() => onBrief({ ...brief, kind: "feature", productContext: product || loadSavedProduct() })} />

      {feature && <ProductBox value={product} locked={locked} onChange={(v) => set("productContext", v)} />}

      {onQuickStart && !locked && (
        <button type="button" className="quick-start" onClick={onQuickStart}>
          <span aria-hidden="true" className="quick-spark">✦</span>
          <span>
            <strong>Just type your idea</strong>
            <span>Write one sentence. AI fills in the rest and asks the council.</span>
          </span>
          <span aria-hidden="true" className="quick-arrow">→</span>
        </button>
      )}

      <label className="field-label">
        {feature ? "Feature name" : "Title"}
        <input className="field" type="text" value={brief.title} disabled={locked} maxLength={200} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Peak tracker" />
      </label>
      <label className="field-label">
        {feature ? "What does the feature do, and why add it?" : "What is it, and what problem does it solve?"}
        <textarea className="field" rows={4} value={brief.description} disabled={locked} maxLength={4000} onChange={(e) => set("description", e.target.value)} placeholder="Explain it in 2 or 3 sentences." />
      </label>
      <div className="field-row">
        <label className="field-label">
          Who is it for?
          <input className="field" type="text" value={brief.targetAudience} disabled={locked} onChange={(e) => set("targetAudience", e.target.value)} placeholder="e.g. students sharing a flat" />
        </label>
        <label className="field-label">
          How will it make money?
          <input className="field" type="text" value={brief.pricingModel} disabled={locked} onChange={(e) => set("pricingModel", e.target.value)} placeholder="e.g. free, ₹99/month" />
        </label>
      </div>
      <label className="field-label">
        What do people use today instead?
        <input className="field" type="text" value={brief.competitors} disabled={locked} onChange={(e) => set("competitors", e.target.value)} placeholder="e.g. Splitwise, spreadsheets" />
      </label>

      <fieldset className="parch-set">
        <legend>RATE YOUR IDEA</legend>
        {SLIDER_FIELDS.map((f) => {
          const value = brief.sliders[f.key];
          return (
            <label key={f.key} className="stat">
              <span className="stat-head">
                <span>{f.label}</span>
                <span aria-hidden="true" className="pips">
                  {Array.from({ length: 10 }, (_, n) => (
                    <span key={n} className={n < value ? "on" : ""} />
                  ))}
                </span>
              </span>
              <input type="range" min={1} max={10} step={1} value={value} disabled={locked} aria-valuetext={`${value} out of 10`} onChange={(e) => set("sliders", { ...brief.sliders, [f.key]: Number(e.target.value) })} />
              <span className="stat-ends">
                <span>{SHORT_SLIDERS[f.key][0]}</span>
                <span>{SHORT_SLIDERS[f.key][1]}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {keysSlot}

      <fieldset className="parch-set">
        <legend>WHICH AI ANSWERS</legend>
        <label className="radio-row">
          <input type="radio" name="council-mode" checked={council.mode === "single"} disabled={locked} onChange={() => onCouncil({ ...council, mode: "single" })} />
          <span>
            <strong>One AI model</strong> for everyone
          </span>
        </label>
        {council.mode === "single" && (
          <select className="field" value={council.single} disabled={locked || usable.length === 0} onChange={(e) => onCouncil({ ...council, single: e.target.value })} aria-label="Model for the whole council">
            {usable.map((p) => (
              <option key={p.key} value={p.key}>
                {label(p)}
              </option>
            ))}
          </select>
        )}
        <label className={`radio-row ${mixedOk ? "" : "muted"}`}>
          <input type="radio" name="council-mode" checked={council.mode === "mixed"} disabled={locked || !mixedOk} onChange={() => onCouncil({ ...council, mode: "mixed", mixed: council.mixed.length >= 2 ? council.mixed : usable.map((p) => p.key) })} />
          <span>
            <strong>Mix models</strong>: split the 45 personas between the models you tick{mixedOk ? "" : " (needs 2 or more working models)"}
          </span>
        </label>
        {council.mode === "mixed" && (
          <div className="check-list">
            {usable.map((p) => {
              const on = council.mixed.includes(p.key);
              return (
                <label key={p.key} className="check-row">
                  <input type="checkbox" checked={on} disabled={locked} onChange={() => onCouncil({ ...council, mixed: on ? council.mixed.filter((k) => k !== p.key) : [...council.mixed, p.key] })} />
                  <span>{label(p)}</span>
                </label>
              );
            })}
            {council.mixed.length < 2 && <span className="warn-text">Tick at least 2 models.</span>}
          </div>
        )}
        {preview && (
          <p className="plan-preview">
            <span aria-hidden="true">⚡</span> {preview.text}
          </p>
        )}
        {unusable.length > 0 && (
          <details className="off-list">
            <summary>{unusable.length} model{unusable.length === 1 ? " isn’t" : "s aren’t"} working</summary>
            {unusable.map((p) => (
              <div key={p.key} className="off-row">
                <strong>{label(p)}</strong>: {p.reason ?? "unavailable"}
              </div>
            ))}
          </details>
        )}
      </fieldset>

      {blocked && !error && <p className="blocked-note">{blocked}</p>}
      <PrivacyToggle hidden={!!brief.hidden} locked={locked} onChange={(h) => set("hidden", h)} />

      {missing && !error && <p className="blocked-note">{missing}</p>}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      <button type="button" className="gbtn gbtn-big" disabled={!canSubmit} onClick={onSubmit}>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20">
          <path d="M3 17l6-6M11 3l6 6-5 5-6-6z" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        {submitLabel}
      </button>
      {onReset && (
        <button type="button" className="parch-btn" onClick={onReset}>
          Change the idea and start over
        </button>
      )}
    </section>
  );
}

const SAVED_PRODUCT = "bon.productDescription";

/** The product description is remembered in this browser, so testing the next feature doesn't mean uploading again. */
export function loadSavedProduct(): string {
  try {
    return localStorage.getItem(SAVED_PRODUCT) ?? "";
  } catch {
    return "";
  }
}
function saveProduct(v: string) {
  try {
    if (v.trim()) localStorage.setItem(SAVED_PRODUCT, v);
    else localStorage.removeItem(SAVED_PRODUCT);
  } catch {
    /* storage blocked: it's just not remembered */
  }
}

/** Upload (or paste) the product's description.md. Every persona reads it before judging the feature. */
export function ProductBox({ value, locked, onChange }: { value: string; locked: boolean; onChange: (v: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const over = value.length > PRODUCT_CONTEXT_MAX;

  const change = (v: string) => {
    onChange(v);
    saveProduct(v);
  };

  async function pick(file: File | undefined) {
    setProblem(null);
    if (!file) return;
    if (!/\.(md|markdown|txt)$/i.test(file.name) && !/^text\//.test(file.type)) {
      setProblem("That doesn’t look like a text file. Upload a .md or .txt file.");
      return;
    }
    if (file.size > 200_000) {
      setProblem("That file is very large. Upload a shorter description (a page or two).");
      return;
    }
    const text = (await file.text()).replace(/\r\n/g, "\n").trim();
    setFileName(file.name);
    change(text);
    if (text.length > PRODUCT_CONTEXT_MAX) setProblem(`It’s ${text.length.toLocaleString("en")} characters. Trim it below to ${PRODUCT_CONTEXT_MAX.toLocaleString("en")}: each of the 45 personas reads it.`);
  }

  return (
    <div className="product-box">
      <div className="product-head">
        <div>
          <div className="product-title">Your product</div>
          <div className="product-sub">Upload its <code>description.md</code>, or paste what it is, who uses it and what it does today.</div>
        </div>
        <button type="button" className="parch-btn product-upload" disabled={locked} onClick={() => fileRef.current?.click()}>
          {value ? "Replace file" : "Upload .md"}
        </button>
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ""))} />
      </div>
      {fileName && <div className="product-file">Loaded {fileName}</div>}
      <label className="field-label">
        <span className="sr-only">Product description</span>
        <textarea
          className="field product-text"
          rows={value ? 6 : 4}
          value={value}
          disabled={locked}
          onChange={(e) => change(e.target.value)}
          placeholder={"# My product\nWhat it is, who uses it, the main features today, pricing."}
        />
      </label>
      <div className={`product-count ${over ? "over" : ""}`}>
        {value.length.toLocaleString("en")} / {PRODUCT_CONTEXT_MAX.toLocaleString("en")} characters
        {value && !locked && (
          <button type="button" className="link-btn" onClick={() => (change(""), setFileName(null), setProblem(null))}>
            Clear
          </button>
        )}
      </div>
      {problem && <p className="product-problem" role="alert">{problem}</p>}
    </div>
  );
}

/** "Startup idea" or "New feature for my product". Shared by the form and the quick start popup. */
export function KindPick({ feature, locked, onStartup, onFeature }: { feature: boolean; locked: boolean; onStartup: () => void; onFeature: () => void }) {
  // Unique per copy: the form and the popup can both be on screen, and must not share one radio group.
  const name = `idea-kind-${useId()}`;
  return (
    <fieldset className="kind-pick" disabled={locked}>
      <legend className="sr-only">What are you testing?</legend>
      <label className={`kind-opt ${!feature ? "on" : ""}`}>
        <input type="radio" name={name} checked={!feature} onChange={onStartup} />
        <strong>A new product</strong>
        <span>Startup or side-project idea</span>
      </label>
      <label className={`kind-opt ${feature ? "on" : ""}`}>
        <input type="radio" name={name} checked={feature} onChange={onFeature} />
        <strong>A new feature</strong>
        <span>For a product you already have</span>
      </label>
    </fieldset>
  );
}

/**
 * Keep the run out of every public list. Private runs belong to an account, so ticking it while
 * signed out opens sign-in (the tick stays, and survives the trip to Google/GitHub and back).
 */
export function PrivacyToggle({ hidden, locked, onChange }: { hidden: boolean; locked: boolean; onChange: (hidden: boolean) => void }) {
  const { user, openSignIn } = useAuth();
  const needsSignIn = hidden && !user;
  return (
    <div className={`privacy-row ${hidden ? "on" : ""}`}>
      <input
        id="privacy-toggle"
        type="checkbox"
        checked={hidden}
        disabled={locked}
        onChange={(e) => {
          onChange(e.target.checked);
          if (e.target.checked && !user) openSignIn({ reason: "Private runs are saved to your account, so only you can open them, on any device." });
        }}
      />
      <span>
        <label htmlFor="privacy-toggle">
          <strong>Keep this run private</strong>
        </label>
        <span>
          {needsSignIn
            ? "Needs an account."
            : hidden
              ? "Hidden from “All ideas” and everyone else. Only you can open it, on any device you’re signed in on."
              : "Off: anyone can see it in “All ideas”."}
          {needsSignIn && (
            <>
              {" "}
              <button type="button" className="privacy-signin" onClick={() => openSignIn()} disabled={locked}>
                Sign in
              </button>
            </>
          )}
        </span>
      </span>
    </div>
  );
}
