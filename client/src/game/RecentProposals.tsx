import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ownerTokenFor } from "../api";
import type { IdeaRecord, Synthesis } from "../types";
import { VERDICT_WORD, VSTYLE, toV } from "./model";

/** "3 min ago", "yesterday", "12 Nov" */
function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

/** The latest finished proposals from everyone, so a first-time visitor sees what the council does. */
export function RecentProposals({ limit = 6 }: { limit?: number }) {
  const [items, setItems] = useState<{ idea: IdeaRecord; synthesis: Synthesis }[] | null>(null);

  useEffect(() => {
    api
      .listIdeas()
      .then((all) => setItems(all.filter((x): x is { idea: IdeaRecord; synthesis: Synthesis } => x.idea.status === "completed" && !!x.synthesis).slice(0, limit)))
      .catch(() => setItems([]));
  }, [limit]);

  if (!items || items.length === 0) return null;

  return (
    <section className="recent" aria-labelledby="recent-h">
      <div className="recent-head">
        <h2 id="recent-h">Ideas other people asked about</h2>
        <Link to="/history" className="recent-all">
          See all →
        </Link>
      </div>
      <ul className="recent-grid">
        {items.map(({ idea, synthesis }) => {
          const v = VSTYLE[toV(synthesis.overallVerdict)];
          return (
            <li key={idea.id}>
              <Link to={`/ideas/${idea.id}`} className="recent-card">
                <span className="recent-top">
                  <span className="recent-verdict" style={{ background: v.bg, color: v.fg }}>
                    {VERDICT_WORD[synthesis.overallVerdict]}
                  </span>
                  <span className="recent-score">
                    {synthesis.overallScore}
                    <small>/100</small>
                  </span>
                </span>
                <strong className="recent-title">{idea.title}</strong>
                <span className="recent-desc">{idea.description}</span>
                <span className="recent-meta">
                  {ago(idea.createdAt)}
                  {idea.mock ? " · simulated AI" : ""}
                  {ownerTokenFor(idea.id) ? " · yours" : ""}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
