import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AccountButton, useAuth } from "../auth";
import { api, forgetOwned, ownerTokenFor } from "../api";
import { VERDICT_WORD, VSTYLE, productName, toV } from "../game/model";
import type { IdeaRecord, Synthesis, Verdict } from "../types";

type Row = { idea: IdeaRecord; synthesis: Synthesis | null };
type Filter = "all" | Verdict | "unfinished" | "mine";

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["build", "Build"],
  ["maybe", "Maybe"],
  ["dont_build", "Don’t build"],
  ["unfinished", "No result"],
  ["mine", "Yours"],
];

/** "3 min ago", "yesterday", "12 Nov" */
function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/** Every idea anyone has submitted (ideas are public). Only this browser's own can be deleted. */
export function HistoryPage() {
  return (
    <div className="game">
      <header className="g-header">
        <div className="g-wrap g-header-row hist-header">
          <Link to="/" className="g-brand">
            <svg aria-hidden="true" width="40" height="40" viewBox="0 0 40 40">
              <rect width="40" height="40" rx="12" fill="#FBBF24" />
              <polygon points="8,20 20,9 32,20" fill="#111827" />
              <rect x="12" y="19" width="16" height="12" rx="2" fill="#111827" />
              <path d="M18 31v-5a2 2 0 0 1 4 0v5z" fill="#FBBF24" />
            </svg>
            <span>
              <span className="g-brand-name">Build or Not</span>
            </span>
          </Link>
          <div className="g-header-right">
            <Link to="/" className="g-link">
              ← Back to the village
            </Link>
            <AccountButton />
          </div>
        </div>
      </header>
      <main className="g-wrap ideas-page">
        <HistoryList />
      </main>
    </div>
  );
}

function HistoryList() {
  const [items, setItems] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<Filter>(params.get("mine") ? "mine" : "all");
  const { user } = useAuth();
  const isMine = (idea: IdeaRecord) => !!idea.yours || !!ownerTokenFor(idea.id);

  const load = useCallback(() => {
    setError(null);
    setItems(null);
    // Public ideas, plus this browser's own private runs (only it can prove it owns them).
    Promise.all([api.listIdeas(), api.listMine().catch(() => [] as Row[])])
      .then(([pub, mine]) => {
        // The /mine copy wins: it carries "yours", which the public list never does.
        const mineIds = new Set(mine.map((x) => x.idea.id));
        const merged = [...mine, ...pub.filter((x) => !mineIds.has(x.idea.id))];
        merged.sort((a, b) => b.idea.createdAt.localeCompare(a.idea.createdAt));
        setItems(merged);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  // Reload when someone signs in or out: "yours" (and private runs) depend on it.
  useEffect(load, [load, user?.id]);

  async function remove(id: string, title: string) {
    const token = ownerTokenFor(id);
    if (!window.confirm(`Delete “${title}”? This can’t be undone.`)) return;
    try {
      await api.deleteIdea(id, token);
      forgetOwned(id);
      setItems((xs) => (xs ?? []).filter((x) => x.idea.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(({ idea, synthesis }) => {
      if (filter === "mine" && !isMine(idea)) return false;
      if (filter === "unfinished" && synthesis) return false;
      if (filter !== "all" && filter !== "mine" && filter !== "unfinished" && synthesis?.overallVerdict !== filter) return false;
      return !q || `${idea.title} ${idea.description}`.toLowerCase().includes(q);
    });
  }, [items, query, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error)
    return (
      <div className="hist-state" role="alert">
        <h1>Couldn’t load the ideas</h1>
        <p className="muted">{/fetch|network|failed/i.test(error) ? "The server didn’t answer. If you’re running it yourself, check that it’s started." : error}</p>
        <button type="button" className="gbtn gbtn-sm" onClick={load}>
          Try again
        </button>
      </div>
    );

  return (
    <>
      <div className="hist-head">
        <h1>All ideas</h1>
        <p className="muted">
          {items ? `${items.length} ${items.length === 1 ? "idea" : "ideas"} people have asked the council about. Open one to see its result.` : "Loading…"}
          {items?.some((x) => x.idea.hidden) ? " Your private runs show here only for you." : ""}
        </p>
      </div>

      {items && items.length > 0 && (
        <div className="hist-controls">
          <label className="hist-search">
            <span className="sr-only">Search ideas</span>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ideas" />
          </label>
          <div className="hist-filters" role="group" aria-label="Show">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" className={`hist-chip ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {items === null ? (
        <ul className="recent-grid" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((k) => (
            <li key={k} className="recent-card hist-skeleton" />
          ))}
        </ul>
      ) : items.length === 0 ? (
        <div className="hist-state">
          <h2>No ideas yet</h2>
          <p className="muted">Nobody has asked the council about an idea yet.</p>
          <Link to="/" className="gbtn gbtn-sm hist-cta">
            Be the first →
          </Link>
        </div>
      ) : shown.length === 0 ? (
        <div className="hist-state">
          <h2>Nothing matches</h2>
          <button type="button" className="ghost-btn" onClick={() => (setQuery(""), setFilter("all"))}>
            Show all ideas
          </button>
        </div>
      ) : (
        <ul className="recent-grid">
          {shown.map(({ idea, synthesis }) => {
            const mine = isMine(idea);
            const v = synthesis ? VSTYLE[toV(synthesis.overallVerdict)] : null;
            const status = synthesis ? VERDICT_WORD[synthesis.overallVerdict] : idea.status === "running" ? "Still voting" : "No result";
            return (
              <li key={idea.id} className="hist-item">
                <Link to={`/ideas/${idea.id}`} className="recent-card">
                  <span className="recent-top">
                    <span className="recent-verdict" style={v ? { background: v.bg, color: v.fg } : { background: "#1f2a44", color: "#cbd5e1" }}>
                      {status}
                    </span>
                    {synthesis && (
                      <span className="recent-score">
                        {synthesis.overallScore}
                        <small>/100</small>
                      </span>
                    )}
                  </span>
                  <strong className="recent-title">{idea.title}</strong>
                  {idea.kind === "feature" && <span className="hist-kind">New feature{idea.productContext ? ` · ${productName(idea.productContext)}` : ""}</span>}
                  <span className="recent-desc">{idea.description}</span>
                  <span className="recent-meta">
                    {idea.hidden ? "Private · " : ""}
                    {ago(idea.createdAt)}
                    {idea.mock ? " · simulated AI" : ""}
                    {mine ? " · yours" : ""}
                  </span>
                </Link>
                {mine && idea.status !== "running" && (
                  <button type="button" className="hist-delete" onClick={() => remove(idea.id, idea.title)} aria-label={`Delete ${idea.title}`}>
                    Delete
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
