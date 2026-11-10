import type { Synthesis } from "../types";

/** A single segmented bar (not a chart library) — three statuses, proportional widths, direct
 * labels when a segment is wide enough to hold them, plus a key below so identity never rests
 * on color alone. Verdict is a status, not an arbitrary category, so this uses the fixed
 * good/warning/critical status palette rather than the categorical series colors. */
export function SentimentBar({ counts }: { counts: Synthesis["counts"] }) {
  const total = counts.build + counts.maybe + counts.dont_build;
  if (total === 0) return null;
  const segments = [
    { key: "build", label: "Build it", count: counts.build, color: "var(--status-good)" },
    { key: "maybe", label: "Mixed signals", count: counts.maybe, color: "var(--status-warning)" },
    { key: "dont_build", label: "Don't build it", count: counts.dont_build, color: "var(--status-critical)" },
  ];

  return (
    <div className="sentiment-bar-wrap">
      <div className="sentiment-bar" role="img" aria-label={`${counts.build} of ${total} say build, ${counts.maybe} mixed, ${counts.dont_build} say don't build`}>
        {segments.map((s) => {
          const pct = (s.count / total) * 100;
          if (pct <= 0) return null;
          return (
            <div key={s.key} className="sentiment-segment" style={{ width: `${pct}%`, background: s.color }} title={`${s.label}: ${s.count} (${Math.round(pct)}%)`}>
              {pct >= 12 && <span className="sentiment-segment-label">{Math.round(pct)}%</span>}
            </div>
          );
        })}
      </div>
      <div className="sentiment-key">
        {segments.map((s) => (
          <span className="sentiment-key-item" key={s.key}>
            <span className="key-dot" style={{ background: s.color }} />
            {s.label} ({s.count})
          </span>
        ))}
      </div>
    </div>
  );
}
