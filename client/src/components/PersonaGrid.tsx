import { useMemo, useState } from "react";
import type { PersonaFailure, PersonaVerdict, Verdict } from "../types";
import { VerdictPill } from "./VerdictPill";

export interface PersonaMetaLite {
  id: string;
  name: string;
  category: string;
  tagline: string;
}

type Filter = Verdict | "all" | "failed";

export function PersonaGrid({ verdicts, failures, personas }: { verdicts: PersonaVerdict[]; failures: PersonaFailure[]; personas: PersonaMetaLite[] }) {
  const personaById = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas]);
  const categories = useMemo(() => ["All", ...Array.from(new Set(personas.map((p) => p.category)))], [personas]);
  const models = useMemo(() => Array.from(new Set(verdicts.map((v) => `${v.provider}/${v.model}`))), [verdicts]);
  const [verdictFilter, setVerdictFilter] = useState<Filter>("all");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [modelFilter, setModelFilter] = useState("All");

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "build", label: "Build it" },
    { key: "maybe", label: "Mixed" },
    { key: "dont_build", label: "Don't build" },
    ...(failures.length ? [{ key: "failed" as const, label: `No response (${failures.length})` }] : []),
  ];

  const inCategory = (personaId: string) => categoryFilter === "All" || personaById.get(personaId)?.category === categoryFilter;
  const inModel = (provider: string, model: string) => modelFilter === "All" || `${provider}/${model}` === modelFilter;

  const shownVerdicts = verdictFilter === "failed" ? [] : verdicts.filter((v) => (verdictFilter === "all" || v.verdict === verdictFilter) && inCategory(v.personaId) && inModel(v.provider, v.model));
  const shownFailures = verdictFilter === "all" || verdictFilter === "failed" ? failures.filter((f) => inCategory(f.personaId) && inModel(f.provider, f.model)) : [];

  return (
    <div className="card">
      <div className="persona-grid-header">
        <h2>Persona breakdown</h2>
        <div className="filters">
          <div className="filter-group">
            {filters.map((f) => (
              <button key={f.key} className={`filter-chip ${verdictFilter === f.key ? "active" : ""}`} onClick={() => setVerdictFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="category-select" aria-label="Persona group">
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          {models.length > 1 && (
            <select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} className="category-select" aria-label="Model">
              {["All", ...models].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          )}
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Showing {shownVerdicts.length + shownFailures.length} of {verdicts.length + failures.length}.
      </p>
      <div className="persona-cards">
        {shownVerdicts.map((v) => {
          const p = personaById.get(v.personaId);
          return (
            <div className="persona-card" key={v.personaId}>
              <div className="persona-card-head">
                <div>
                  <div className="persona-name">{p?.name ?? v.personaId}</div>
                  <div className="persona-category">
                    {p?.category} · <span className="model-badge">{v.model}</span>
                    {v.repaired && <span className="model-badge" title="First answer failed validation; the re-ask fixed it."> re-asked</span>}
                  </div>
                </div>
                <VerdictPill verdict={v.verdict} />
              </div>
              <div className="persona-score">Score: {v.score}/10</div>
              <p className="persona-reasoning">{v.reasoning}</p>
              <div className="persona-concern-appeal">
                <div>
                  <span className="label-chip concern">Concern</span> {v.topConcern}
                </div>
                <div>
                  <span className="label-chip appeal">Appeal</span> {v.topAppeal}
                </div>
              </div>
            </div>
          );
        })}
        {shownFailures.map((f) => {
          const p = personaById.get(f.personaId);
          return (
            <div className="persona-card failed" key={f.personaId}>
              <div className="persona-card-head">
                <div>
                  <div className="persona-name">{p?.name ?? f.personaId}</div>
                  <div className="persona-category">
                    {p?.category} · <span className="model-badge">{f.model}</span>
                  </div>
                </div>
                <span className="pill danger">No response</span>
              </div>
              <p className="persona-reasoning muted-small">Failed: {f.error}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
