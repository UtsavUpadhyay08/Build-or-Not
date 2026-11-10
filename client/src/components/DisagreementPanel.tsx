import type { GroupStat, Synthesis } from "../types";

const CONFIDENCE_COPY: Record<string, { label: string; cls: string; note: string }> = {
  high: { label: "High agreement", cls: "ok", note: "The panel largely agrees. The headline verdict is a fair summary." },
  medium: { label: "Some disagreement", cls: "warn", note: "Opinions are split in places. Read the breakdown below before trusting the headline." },
  low: { label: "Panel is split", cls: "danger", note: "The personas disagree sharply. The headline verdict hides real uncertainty — look at who likes it and who doesn't." },
};

/** Mean score per group on a fixed 1–10 axis, so groups are comparable at a glance. Sequential ramp: it's magnitude, not a verdict. */
function GroupBars({ title, groups }: { title: string; groups: GroupStat[] }) {
  return (
    <div className="group-bars">
      <h3>{title}</h3>
      {groups.map((g) => (
        <div className="group-row" key={g.key}>
          <span className="group-label" title={g.key}>
            {g.key}
          </span>
          <div className="group-track">
            <div className="group-fill" style={{ width: `${((g.meanScore - 1) / 9) * 100}%` }} />
          </div>
          <span className="group-value">
            {g.meanScore.toFixed(1)} <span className="muted-small">n={g.n}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function DisagreementPanel({ synthesis }: { synthesis: Synthesis }) {
  const d = synthesis.disagreement;
  const c = CONFIDENCE_COPY[d.confidence];
  return (
    <div className="card">
      <div className="disagreement-head">
        <h2>How much does the panel agree?</h2>
        <span className={`pill ${c.cls}`}>{c.label}</span>
      </div>
      <p className="muted">{c.note}</p>
      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="stat-value">{d.scoreStdDev.toFixed(2)}</div>
          <div className="stat-label">Score spread (SD, 1–10)</div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">{d.verdictEntropy.toFixed(2)}</div>
          <div className="stat-label">Verdict entropy (0 unanimous · 1 even split)</div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">{Math.round(d.agreement * 100)}%</div>
          <div className="stat-label">Share giving the most common verdict</div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">
            {synthesis.judged}/{synthesis.judged + synthesis.failed}
          </div>
          <div className="stat-label">Personas that responded</div>
        </div>
      </div>
      <div className="group-columns">
        <GroupBars title="Mean score by persona group" groups={d.byCategory} />
        {d.byProvider.length > 1 && <GroupBars title="Mean score by model" groups={d.byProvider} />}
      </div>
    </div>
  );
}
