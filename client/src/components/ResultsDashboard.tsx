import { useEffect, useState } from "react";
import { api } from "../api";
import type { IdeaRecord, PersonaFailure, PersonaVerdict, Synthesis } from "../types";
import { VerdictPill } from "./VerdictPill";
import { SentimentBar } from "./SentimentBar";
import { ScoreHistogram } from "./ScoreHistogram";
import { ThemeList } from "./ThemeList";
import { PersonaGrid, type PersonaMetaLite } from "./PersonaGrid";
import { DisagreementPanel } from "./DisagreementPanel";
import { ideaToMarkdown } from "../exportMarkdown";

export function ResultsDashboard({
  idea,
  verdicts,
  failures,
  totalPersonas,
  synthesis,
  synthesizing,
  error,
}: {
  idea: IdeaRecord;
  verdicts: PersonaVerdict[];
  failures: PersonaFailure[];
  totalPersonas: number;
  synthesis: Synthesis | null;
  synthesizing: boolean;
  error: string | null;
}) {
  const [personas, setPersonas] = useState<PersonaMetaLite[]>([]);
  const [copyLabel, setCopyLabel] = useState("Copy as Markdown");

  useEffect(() => {
    api.getMeta().then((m) => setPersonas(m.personas)).catch(() => {});
  }, []);

  const personaNameById = new Map(personas.map((p) => [p.id, p.name]));
  const nameFor = (id: string) => personaNameById.get(id) ?? id;
  const answered = verdicts.length + failures.length;
  const failureGroups = groupFailures(failures);

  async function copyMarkdown() {
    const md = ideaToMarkdown(idea, verdicts, failures, synthesis, nameFor);
    try {
      await navigator.clipboard.writeText(md);
      setCopyLabel("Copied!");
    } catch {
      setCopyLabel("Couldn't copy — select and copy manually");
    }
    setTimeout(() => setCopyLabel("Copy as Markdown"), 2000);
  }

  return (
    <div className="results">
      <div className="card">
        <div className="results-head">
          <div>
            <h1>{idea.title}</h1>
            <p className="muted">{idea.description}</p>
            <p className="muted-small">
              Panel: {idea.panelMode === "mixed" ? "models mixed across providers" : "one model"} · persona library v{idea.personaLibraryVersion}
            </p>
          </div>
          {idea.mock && <span className="mock-tag large">MOCK MODE — add an API key in .env for real judgments</span>}
        </div>

        {idea.status === "running" && (
          <div className="progress-banner">
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${(answered / totalPersonas) * 100}%` }} />
            </div>
            <p>
              {synthesizing
                ? `All personas have answered. Extracting recurring themes…`
                : `${verdicts.length} of ${totalPersonas} personas have responded${failures.length ? ` · ${failures.length} failed after retries` : ""}…`}
            </p>
          </div>
        )}

        {error && <div className="error-box">{error}</div>}
        {failureGroups.length > 0 && (
          <div className={synthesis ? "warn-box" : "error-box"}>
            <strong>Why personas didn't respond:</strong>
            <ul className="health-list">
              {failureGroups.map((g) => (
                <li key={g.reason}>
                  <strong>{g.count}×</strong> {g.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {synthesis && (
          <div className="headline">
            <div className="headline-verdict">
              <VerdictPill verdict={synthesis.overallVerdict} />
              <span className="headline-score">{synthesis.overallScore}/100</span>
            </div>
            <p className="headline-summary">{synthesis.summary}</p>
            <SentimentBar counts={synthesis.counts} />
            <p className="muted-small run-footnote">
              {synthesis.failed > 0 && `${synthesis.failed} persona(s) failed after retries and are excluded. `}
              {synthesis.cost.inputTokens + synthesis.cost.outputTokens > 0 &&
                `${(synthesis.cost.inputTokens + synthesis.cost.outputTokens).toLocaleString()} tokens` +
                  (synthesis.cost.usd !== null ? ` · ≈ $${synthesis.cost.usd.toFixed(4)}` : "")}
            </p>
          </div>
        )}
      </div>

      {synthesis && <DisagreementPanel synthesis={synthesis} />}

      {verdicts.length > 0 && (
        <div className="card">
          <h2>Score distribution</h2>
          <ScoreHistogram verdicts={verdicts} />
        </div>
      )}

      {synthesis && synthesis.themesAvailable && (
        <div className="card theme-columns">
          <ThemeList title="Top concerns" items={synthesis.topConcerns} total={synthesis.judged} />
          <ThemeList title="Top appeals" items={synthesis.topAppeals} total={synthesis.judged} />
        </div>
      )}

      {answered > 0 && <PersonaGrid verdicts={verdicts} failures={failures} personas={personas} />}

      {synthesis && (
        <div className="card export-row">
          <button className="secondary-button" onClick={copyMarkdown}>
            {copyLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/** Collapse identical failure reasons (e.g. 45 copies of the same 401) into one line each. */
function groupFailures(failures: PersonaFailure[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of failures) {
    // Strip per-request noise (request ids, raw JSON bodies) so identical causes group together.
    const reason = f.error
      .replace(/"request_id":"[^"]*"/g, "")
      .replace(/HTTP (\d{3}) \{.*$/s, (_m, code) => `HTTP ${code}${/invalid x-api-key|authentication|API key not valid|Incorrect API key/i.test(f.error) ? " — the API key was rejected. Check the key in .env and restart the server." : ""}`)
      .trim();
    counts.set(`${f.provider}/${f.model}: ${reason}`, (counts.get(`${f.provider}/${f.model}: ${reason}`) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}
