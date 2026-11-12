import type { ApiMeta, IdeaBrief, IdeaRecord } from "../types";
import { SLIDER_FIELDS } from "../types";
import { productName, capacityLine, planFromServer, providerLabel } from "./model";

interface Props {
  brief: IdeaBrief;
  idea: IdeaRecord | null;
  meta: ApiMeta | null;
  running: boolean;
  onReset?: () => void;
}

/**
 * The proposal, compacted once the council is in session, so the village and the results
 * stay within reach instead of sitting below a long form.
 */
export function ProposalSummary({ brief, idea, meta, running, onReset }: Props) {
  const providers = idea?.providers?.length ? idea.providers : null;
  const label = (key: string) => {
    const p = meta?.providers.find((x) => x.key === key) ?? idea?.sendPlan?.providers.find((x) => x.key === key);
    return p ? (p.name === "mock" ? p.model : `${p.name} · ${p.model}`) : key;
  };
  const paidBy = !idea ? "" : idea.keyMode === "own" ? " (your key)" : idea.mock ? "" : " (free run)";
  const council = !idea
    ? "Getting ready…"
    : idea.panelMode === "mixed"
      ? `Mixed: ${providers ? providers.map(label).join(", ") : "all working models"}`
      : `One model: ${providers ? label(providers[0]) : "the default model"}`;
  const isFeature = brief.kind === "feature" && !!brief.productContext;
  const extras = [
    isFeature && ["Feature for", productName(brief.productContext) || "your product"],
    brief.targetAudience && ["For", brief.targetAudience],
    brief.pricingModel && ["Pricing", brief.pricingModel],
    brief.competitors && ["Instead of", brief.competitors],
  ].filter(Boolean) as [string, string][];

  return (
    <section className="proposal proposal-compact" aria-labelledby="proposal-h">
      <div className="compact-top">
        <div className="eyebrow">{isFeature ? "NEW FEATURE" : "YOUR IDEA"}{brief.hidden ? " · PRIVATE" : ""}{running ? " · LOCKED" : ""}</div>
        <h2 id="proposal-h">{brief.title || "Untitled idea"}</h2>
      </div>
      <p className="compact-desc">{brief.description}</p>
      {extras.length > 0 && (
        <dl className="compact-facts">
          {extras.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="compact-stats" aria-label="Idea stats">
        {SLIDER_FIELDS.map((f) => {
          const value = brief.sliders[f.key];
          return (
            <div key={f.key} className="compact-stat">
              <span>{f.label}</span>
              <span className="pips" aria-label={`${value} out of 10`}>
                {Array.from({ length: 10 }, (_, n) => (
                  <span key={n} className={n < value ? "on" : ""} />
                ))}
              </span>
            </div>
          );
        })}
      </div>
      <div className="compact-council">
        <span className="eyebrow">AI USED</span>
        <span>
          {council}
          {paidBy}
        </span>
      </div>
      {idea?.sendPlan && (
        <div className="compact-plan">
          <span className="eyebrow">HOW IT WAS SENT</span>
          <span>{planFromServer(idea.sendPlan, idea.sendPlan.providers.reduce((s, p) => s + p.personas, 0) || 45)}</span>
          <details>
            <summary>Details</summary>
            <ul>
              {idea.sendPlan.providers.map((p) => (
                <li key={p.key}>
                  <strong>{p.name === "mock" ? p.model : providerLabel(p.name)}</strong> ({p.personas} personas): {capacityLine(p)}. {p.detail}
                </li>
              ))}
            </ul>
            {idea.sendPlan.warnings.map((w) => (
              <p key={w} className="warn-text">
                {w}
              </p>
            ))}
          </details>
        </div>
      )}
      {onReset ? (
        <button type="button" className="gbtn" onClick={onReset}>
          Edit and ask again
        </button>
      ) : (
        <p className="proposal-hint">Locked while the council votes.</p>
      )}
    </section>
  );
}
