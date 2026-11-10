import type { ThemeCluster } from "../types";

/** Ranked list of recurring themes. The small inline bar encodes magnitude (mention count),
 * so it uses the sequential ramp, not a status or categorical color — it isn't a verdict. */
export function ThemeList({ title, items, total }: { title: string; items: ThemeCluster[]; total: number }) {
  const max = Math.max(1, ...items.map((i) => i.mentionCount));
  return (
    <div className="theme-list">
      <h3>{title}</h3>
      {items.length === 0 && <p className="muted">No clear recurring theme emerged.</p>}
      <ul>
        {items.map((item, i) => (
          <li key={i} className="theme-item">
            <div className="theme-item-row">
              <span className="theme-name">{item.theme}</span>
              <span className="theme-count">
                {item.mentionCount}/{total}
              </span>
            </div>
            <div className="theme-bar-track">
              <div className="theme-bar-fill" style={{ width: `${(item.mentionCount / max) * 100}%` }} />
            </div>
            <p className="theme-example">{"“" + item.example + "”"}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
