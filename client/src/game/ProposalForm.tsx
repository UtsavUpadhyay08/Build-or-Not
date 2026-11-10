import type { ReactNode } from "react";
import type { ApiMeta, IdeaBrief, IdeaSliders, PanelMode } from "../types";
import { SLIDER_FIELDS } from "../types";
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
}

const SHORT_SLIDERS: Record<keyof IdeaSliders, [string, string]> = {
  reach: ["Few users", "Most users"],
  buildCost: ["Quick and cheap", "Slow and pricey"],
  userImportance: ["Peripheral users", "Our key users"],
  complexity: ["Simple to run", "Hard to run"],
  value: ["Nice to have", "Solves real pain"],
  risk: ["Low risk", "Could break things"],
};

export function ProposalForm({ brief, onBrief, council, onCouncil, meta, locked, submitting, submitLabel, onSubmit, onReset, error, keysSlot, blocked }: Props) {
  const set = <K extends keyof IdeaBrief>(k: K, v: IdeaBrief[K]) => onBrief({ ...brief, [k]: v });
  const usable = meta?.providers.filter((p) => p.usable) ?? [];
  const unusable = meta?.providers.filter((p) => !p.usable) ?? [];
  const label = (p: { name: string; model: string }) => (p.name === "mock" ? `${p.model} (simulated)` : `${p.name} · ${p.model}`);
  const mixedOk = usable.length >= 2;
  const councilValid = council.mode === "single" ? usable.some((p) => p.key === council.single) || meta?.mock : council.mixed.length >= 2;
  const canSubmit = !locked && !submitting && !blocked && brief.title.trim() && brief.description.trim() && councilValid;
  const councilKeys = council.mode === "single" ? (council.single ? [council.single] : []) : council.mixed;
  const preview = previewPlan(meta, councilKeys, meta?.personaCount ?? 45);

  return (
    <section className="proposal" aria-labelledby="proposal-h">
      <div>
        <div className="eyebrow">PROPOSAL</div>
        <h2 id="proposal-h">What should the village judge?</h2>
        <p className="proposal-hint">{locked ? "Sealed while the council meets." : "Every field is read by all 45 personas."}</p>
      </div>

      <label className="field-label">
        Title
        <input className="field" type="text" value={brief.title} disabled={locked} maxLength={200} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Peak tracker" />
      </label>
      <label className="field-label">
        What is it, and what problem does it solve?
        <textarea className="field" rows={4} value={brief.description} disabled={locked} maxLength={4000} onChange={(e) => set("description", e.target.value)} placeholder="Describe the idea in a few sentences." />
      </label>
      <div className="field-row">
        <label className="field-label">
          Target audience
          <input className="field" type="text" value={brief.targetAudience} disabled={locked} onChange={(e) => set("targetAudience", e.target.value)} placeholder="Who is it for?" />
        </label>
        <label className="field-label">
          Pricing model
          <input className="field" type="text" value={brief.pricingModel} disabled={locked} onChange={(e) => set("pricingModel", e.target.value)} placeholder="Free, subscription…" />
        </label>
      </div>
      <label className="field-label">
        Competitors / what people use today
        <input className="field" type="text" value={brief.competitors} disabled={locked} onChange={(e) => set("competitors", e.target.value)} placeholder="What do people use instead?" />
      </label>

      <fieldset className="parch-set">
        <legend>IDEA STATS</legend>
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
        <legend>THE COUNCIL</legend>
        <label className="radio-row">
          <input type="radio" name="council-mode" checked={council.mode === "single"} disabled={locked} onChange={() => onCouncil({ ...council, mode: "single" })} />
          <span>
            <strong>One model</strong> for all 45 personas
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
            <strong>Mixed models</strong>: personas are shared out evenly across the models you tick{mixedOk ? "" : " (needs 2+ working providers)"}
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
            {council.mixed.length < 2 && <span className="warn-text">Tick at least two models.</span>}
          </div>
        )}
        {preview && (
          <p className="plan-preview">
            <span aria-hidden="true">⚡</span> {preview.text}
          </p>
        )}
        {unusable.length > 0 && (
          <details className="off-list">
            <summary>{unusable.length} provider{unusable.length === 1 ? " is" : "s are"} switched off</summary>
            {unusable.map((p) => (
              <div key={p.key} className="off-row">
                <strong>{label(p)}</strong>: {p.reason ?? "unavailable"}
              </div>
            ))}
          </details>
        )}
      </fieldset>

      {blocked && !error && <p className="blocked-note">{blocked}</p>}
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
          Edit the proposal and send everyone home
        </button>
      )}
    </section>
  );
}
