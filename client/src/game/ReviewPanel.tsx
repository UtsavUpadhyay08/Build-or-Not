import type { PersonaFailure, PersonaMeta, PersonaVerdict } from "../types";
import { VSTYLE, districtOf, explainFailure, providerLabel, skinFor, splitName, toV } from "./model";

interface Props {
  persona: PersonaMeta;
  index: number;
  verdict?: PersonaVerdict;
  failure?: PersonaFailure;
  impact: string;
  onClose: () => void;
}

/** Full review for one persona, or the full story of why they went home. */
export function ReviewPanel({ persona, index, verdict, failure, impact, onClose }: Props) {
  const d = districtOf(persona.category);
  const { short } = splitName(persona.name);
  const v = verdict ? toV(verdict.verdict) : failure ? "f" : null;
  const style = v ? VSTYLE[v] : null;
  const story = failure ? explainFailure(failure, short) : null;

  return (
    <aside className="review rise" role="dialog" aria-label={`${persona.name}: full review`}>
      <div className="review-head">
        <span aria-hidden="true" className="avatar avatar-lg">
          <span className="avatar-head" style={{ background: skinFor(index) }} />
          <span className="avatar-body" style={{ background: d.color }}>
            {short[0]}
          </span>
        </span>
        <div className="review-title">
          <div className="review-name">{persona.name}</div>
          <div className="review-sub">
            Lives in the {d.label} district · “{persona.tagline}”
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close review">
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {style && (
        <div className="review-verdict">
          <span className="vpill" style={{ background: style.bg, color: style.fg }}>
            {style.label}
          </span>
          <span className="review-score">{verdict ? `Score ${verdict.score} / 10` : "No score"}</span>
        </div>
      )}
      {!style && <p className="review-p">Still thinking. Their verdict will appear here the moment it arrives.</p>}

      {verdict && (
        <>
          <div>
            <h3 className="kicker">IN THEIR WORDS</h3>
            <p className="review-p">{verdict.reasoning}</p>
          </div>
          <div className="note note-concern">
            <div className="note-k">TOP CONCERN</div>
            <div>{verdict.topConcern}</div>
          </div>
          <div className="note note-appeal">
            <div className="note-k">TOP APPEAL</div>
            <div>{verdict.topAppeal}</div>
          </div>
          <div className="review-meta">
            Answered by {providerLabel(verdict.provider)} · {verdict.model} in {(verdict.latencyMs / 1000).toFixed(1)}s · {(verdict.inputTokens + verdict.outputTokens).toLocaleString()} tokens
            {verdict.repaired ? " · first answer was malformed, fixed on re-ask" : ""}
          </div>
        </>
      )}

      {failure && story && (
        <>
          <div>
            <h3 className="kicker kicker-indigo">WHY THEY WENT HOME</h3>
            <p className="review-p">{story.plain}</p>
          </div>
          <ol className="note note-steps">
            {story.steps.map((s, k) => (
              <li key={k}>{s}</li>
            ))}
          </ol>
          <div className="note note-impact">
            <div className="note-k">DOES IT CHANGE THE RESULT?</div>
            <div>{impact}</div>
          </div>
          {story.fix && (
            <div className="note note-fix">
              <div className="note-k">WHAT YOU CAN DO</div>
              <div>{story.fix}</div>
            </div>
          )}
          <div className="review-meta">
            Technical detail: {failure.provider} / {failure.model}
            {failure.status ? ` · HTTP ${failure.status}` : ""} · {failure.attempts ?? 1} attempt{(failure.attempts ?? 1) === 1 ? "" : "s"} · {failure.error.slice(0, 220)}
          </div>
        </>
      )}
    </aside>
  );
}
