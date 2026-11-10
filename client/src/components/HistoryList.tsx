import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, forgetOwned, ownerTokenFor } from "../api";
import type { IdeaRecord, Synthesis } from "../types";
import { VerdictPill } from "./VerdictPill";

export function HistoryList() {
  const [items, setItems] = useState<{ idea: IdeaRecord; synthesis: Synthesis | null }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listIdeas().then(setItems).catch((e) => setError(e.message));
  }, []);

  async function remove(id: string) {
    const token = ownerTokenFor(id);
    if (!token) return;
    try {
      await api.deleteIdea(id, token);
      forgetOwned(id);
      setItems((xs) => xs.filter((x) => x.idea.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) return <div className="error-box">{error}</div>;
  if (items.length === 0) return null;

  return (
    <div className="card">
      <h2>Past submissions</h2>
      <div className="table-scroll">
      <table className="history-table">
        <thead>
          <tr>
            <th>Idea</th>
            <th>Submitted</th>
            <th>Status</th>
            <th>Verdict</th>
            <th>Score</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {items.map(({ idea, synthesis }) => (
            <tr key={idea.id}>
              <td>
                <Link to={`/ideas/${idea.id}`}>{idea.title}</Link>
                {idea.mock && <span className="mock-tag">mock</span>}
                {idea.panelMode === "mixed" && <span className="mock-tag">mixed</span>}
                {ownerTokenFor(idea.id) && <span className="mock-tag">yours</span>}
              </td>
              <td className="muted">{new Date(idea.createdAt).toLocaleString()}</td>
              <td>
                <span className={`pill ${idea.status === "completed" ? "ok" : idea.status === "failed" ? "danger" : "warn"}`}>{idea.status}</span>
              </td>
              <td>{synthesis ? <VerdictPill verdict={synthesis.overallVerdict} /> : "—"}</td>
              <td>{synthesis ? `${synthesis.overallScore}/100` : "—"}</td>
              <td>
                {ownerTokenFor(idea.id) && idea.status !== "running" ? (
                  <button type="button" className="link-btn danger" onClick={() => remove(idea.id)} aria-label={`Delete ${idea.title}`}>
                    Delete
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
