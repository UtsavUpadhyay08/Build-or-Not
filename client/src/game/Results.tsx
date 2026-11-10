import { useMemo, useState } from "react";
import type { IdeaRecord, PersonaFailure, PersonaMeta, PersonaVerdict, Synthesis } from "../types";
import { VERDICT_WORD, VSTYLE, districtOf, explainFailure, providerLabel, skinFor, splitName, toV, type V } from "./model";

interface Props {
  idea: IdeaRecord;
  personas: PersonaMeta[];
  verdicts: PersonaVerdict[];
  failures: PersonaFailure[];
  synthesis: Synthesis;
  onOpen: (personaId: string) => void;
  onReset: () => void;
  onCopy: () => void;
  copyLabel: string;
}

type SortKey = "score" | "district" | "name";

export function Results({ idea, personas, verdicts, failures, synthesis: s, onOpen, onReset, onCopy, copyLabel }: Props) {
  const [sort, setSort] = useState<SortKey>("score");
  const idx = useMemo(() => new Map(personas.map((p, i) => [p.id, i])), [personas]);
  const byId = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas]);
  const total = personas.length;
  const vKey = toV(s.overallVerdict);
  const color = VSTYLE[vKey].bright;
  const d = s.disagreement;
  const maxSide = Math.max(1, s.counts.build, s.counts.maybe, s.counts.dont_build);
  const meanLatency = verdicts.length ? verdicts.reduce((a, v) => a + v.latencyMs, 0) / verdicts.length / 1000 : 0;
  const repaired = verdicts.filter((v) => v.repaired).length;

  // Score histogram 1..10
  const hist = Array.from({ length: 10 }, (_, k) => ({ score: k + 1, n: 0 }));
  for (const v of verdicts) hist[Math.max(1, Math.min(10, Math.round(v.score))) - 1].n++;
  const histMax = Math.max(1, ...hist.map((h) => h.n));

  const teams: { v: Exclude<V, "f">; label: string }[] = [
    { v: "b", label: "Team Build" },
    { v: "m", label: "Maybe" },
    { v: "d", label: "Team Don’t Build" },
  ];

  const rows = [
    ...verdicts.map((v) => ({ id: v.personaId, v: toV(v.verdict) as V, score: v.score as number | null, model: `${providerLabel(v.provider)} · ${v.model}`, secs: v.latencyMs / 1000 })),
    ...failures.map((f) => ({ id: f.personaId, v: "f" as V, score: null, model: `${providerLabel(f.provider)} · ${f.model}`, secs: null as number | null })),
  ].map((r) => {
    const p = byId.get(r.id)!;
    return { ...r, p, ...splitName(p?.name ?? r.id), district: districtOf(p?.category ?? "") };
  });
  rows.sort((a, b) =>
    sort === "score" ? (b.score ?? -1) - (a.score ?? -1) || a.short.localeCompare(b.short)
    : sort === "district" ? a.district.label.localeCompare(b.district.label) || (b.score ?? -1) - (a.score ?? -1)
    : a.short.localeCompare(b.short),
  );

  const stats: { k: string; v: string; hint: string }[] = [
    { k: "Overall score", v: `${s.overallScore} / 100`, hint: "Everyone’s scores averaged, out of 100" },
    { k: "Agreement", v: `${Math.round(d.agreement * 100)}%`, hint: "How many picked the most popular answer" },
    { k: "Score spread", v: d.scoreStdDev.toFixed(2), hint: "How far apart the scores are (higher = more split)" },
    { k: "How split the votes are", v: d.verdictEntropy.toFixed(2), hint: "0 = everyone agrees, 1 = split three ways" },
    { k: "Confidence", v: d.confidence[0].toUpperCase() + d.confidence.slice(1), hint: "High when most people agree" },
    { k: "Responded", v: `${s.judged} / ${total}`, hint: s.failed ? `${s.failed} didn’t vote (80% needed)` : "Everyone answered" },
    { k: "Tokens", v: (s.cost.inputTokens + s.cost.outputTokens).toLocaleString(), hint: `${s.cost.inputTokens.toLocaleString()} sent · ${s.cost.outputTokens.toLocaleString()} received` },
    { k: "Cost", v: s.cost.usd === null ? "Not known" : s.cost.usd === 0 ? "Free" : `$${s.cost.usd.toFixed(4)}`, hint: `About ${meanLatency.toFixed(1)}s per persona${repaired ? ` · ${repaired} answer${repaired === 1 ? "" : "s"} re-asked` : ""}` },
  ];

  return (
    <section className="results rise" aria-labelledby="results-h">
      <div className="results-titlerow">
        <h2 id="results-h">The result</h2>
        <span className="muted">
          “{idea.title}”, judged by {s.judged} of {total} personas{idea.panelMode === "mixed" ? " across several models" : ""}
        </span>
      </div>

      <div className="card hero">
        <div className="ring" style={{ background: `conic-gradient(${color} ${s.overallScore}%, rgba(255,255,255,0.08) 0)` }}>
          <div className="ring-in">
            <span className="ring-n">{s.overallScore}</span>
            <span className="ring-l">out of 100</span>
          </div>
        </div>
        <div className="hero-text">
          <span className="hero-word" style={{ color }}>
            {VERDICT_WORD[s.overallVerdict]}
          </span>
          <p>{s.summary}</p>
          <div className="chips">
            <span className="chip chip-gold">
              {d.confidence === "high" ? "Most agree" : d.confidence === "medium" ? "Some disagreement" : "Opinions are split"}
            </span>
            <span className="chip">
              {s.judged} voted{s.failed ? ` · ${s.failed} didn’t` : ""}
            </span>
            <span className="chip">{s.cost.usd === null ? "Cost: not known for this model" : s.cost.usd === 0 ? "Cost: free" : `Cost $${s.cost.usd.toFixed(4)}`}</span>
          </div>
        </div>
        <div className="podium">
          {(
            [
              ["b", s.counts.build, "Build"],
              ["m", s.counts.maybe, "Maybe"],
              ["d", s.counts.dont_build, "Don’t build"],
            ] as const
          ).map(([k, n, label]) => (
            <div key={k} className="podium-col">
              <span className="podium-n">{n}</span>
              <div className="podium-bar" style={{ height: 30 + (n / maxSide) * 90, background: VSTYLE[k].solid }} />
              <span className="podium-l">{label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="card-h">The numbers</h3>
        <div className="stat-grid">
          {stats.map((x) => (
            <div key={x.k} className="stat-tile">
              <div className="stat-k">{x.k}</div>
              <div className="stat-v">{x.v}</div>
              <div className="stat-h">{x.hint}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="row">
        <div className="card grow2">
          <h3 className="card-h">How people scored it</h3>
          <p className="muted small">How many personas gave each score, from 1 to 10.</p>
          <div className="hist" role="img" aria-label={`Score distribution: ${hist.map((h) => `${h.n} gave ${h.score}`).join(", ")}`}>
            {hist.map((h) => (
              <div key={h.score} className="hist-col">
                <span className="hist-n">{h.n || ""}</span>
                <div className="hist-bar" style={{ height: `${(h.n / histMax) * 100}%`, background: h.score >= 7 ? VSTYLE.b.solid : h.score >= 4 ? VSTYLE.m.solid : VSTYLE.d.solid }} />
                <span className="hist-x">{h.score}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card grow1">
          <h3 className="card-h">{d.byProvider.length > 1 ? "Scores by AI model" : "AI model"}</h3>
          {d.byProvider.length > 1 ? (
            <>
              <p className="muted small">Average score from each model. A big gap means the models disagree.</p>
              {d.byProvider.map((g) => (
                <Bar key={g.key} label={g.key} n={g.n} mean={g.meanScore} color="#FBBF24" />
              ))}
            </>
          ) : (
            <p className="muted">All {s.judged} answers came from {d.byProvider[0]?.key ?? "one model"}. Choose “Mix models” to compare models.</p>
          )}
        </div>
      </div>

      {s.themesAvailable ? (
        <div className="row">
          {[
            { title: "Main worries", items: s.topConcerns, color: VSTYLE.d.solid },
            { title: "What people liked", items: s.topAppeals, color: VSTYLE.b.solid },
          ].map((g) => (
            <div key={g.title} className="card grow1">
              <h3 className="card-h">{g.title}</h3>
              {g.items.map((t) => (
                <div key={t.theme} className="theme">
                  <div className="theme-top">
                    <span>{t.theme}</span>
                    <span className="muted">{t.mentionCount} personas</span>
                  </div>
                  <div className="track">
                    <div style={{ width: `${Math.min(100, (t.mentionCount / Math.max(1, s.judged)) * 100)}%`, background: g.color }} />
                  </div>
                  <div className="theme-q">“{t.example}”</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <p className="muted">The summary of common worries didn’t run this time. Every person’s answer is still below.</p>
        </div>
      )}

      <div className="row">
        <div className="card grow2">
          <h3 className="card-h">Scores by group</h3>
          <p className="muted small">Average score out of 10 for each group. A big gap means it suits some people and not others.</p>
          {[...d.byCategory]
            .sort((a, b) => b.meanScore - a.meanScore)
            .map((g, k) => (
              <Bar key={g.key} rank={k + 1} label={districtOf(g.key).label} n={g.n} mean={g.meanScore} color={districtOf(g.key).color} />
            ))}
        </div>
        <div className="card grow1">
          <h3 className="card-h">Who didn’t vote</h3>
          {failures.length === 0 ? (
            <p className="muted">Everyone voted: all {total} personas.</p>
          ) : (
            <>
              <p className="muted small">
                These personas didn’t vote. The result uses the other {s.judged}, which is {s.judged / total >= 0.8 ? "enough" : "not enough"} (80% needed).
              </p>
              {failures.map((f) => {
                const p = byId.get(f.personaId);
                const story = explainFailure(f, splitName(p?.name ?? f.personaId).short);
                return (
                  <button key={f.personaId} type="button" className="seat" onClick={() => onOpen(f.personaId)}>
                    <strong>{p?.name ?? f.personaId}</strong>
                    <span>{story.short}</span>
                    <span className="seat-link">See why →</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>

      <details className="card teams-fold">
        <summary>
          <h3 className="card-h">Who voted which way</h3>
          <span className="fold-counts">
            {teams.map((t) => (
              <span key={t.v} className="fold-count" style={{ background: VSTYLE[t.v].bg, color: VSTYLE[t.v].fg }}>
                {t.label.replace("Team ", "")} · {verdicts.filter((v) => toV(v.verdict) === t.v).length}
              </span>
            ))}
          </span>
          <span className="fold-hint" aria-hidden="true">Show</span>
        </summary>
        <div className="row teams-row">
        {teams.map((t) => {
          const members = verdicts.filter((v) => toV(v.verdict) === t.v).sort((a, b) => b.score - a.score);
          return (
            <div key={t.v} className="card team">
              <div className="team-head">
                <h3>
                  <span aria-hidden="true" className="sq" style={{ background: VSTYLE[t.v].solid }} />
                  {t.label}
                </h3>
                <span className="count">{members.length}</span>
              </div>
              <div className="roster">
                {members.map((m) => {
                  const p = byId.get(m.personaId);
                  if (!p) return null;
                  const { short, role } = splitName(p.name);
                  return (
                    <button key={m.personaId} type="button" className="member" onClick={() => onOpen(m.personaId)} aria-label={`${p.name}, score ${m.score} out of 10`}>
                      <span aria-hidden="true" className="avatar">
                        <span className="avatar-head" style={{ background: skinFor(idx.get(p.id) ?? 0) }} />
                        <span className="avatar-body" style={{ background: districtOf(p.category).color }}>
                          {short[0]}
                        </span>
                      </span>
                      <span className="member-text">
                        <strong>{short}</strong>
                        <span>{role}</span>
                      </span>
                      <span className="member-score">{m.score}</span>
                    </button>
                  );
                })}
                {members.length === 0 && <p className="muted small">Nobody.</p>}
              </div>
            </div>
          );
        })}
        </div>
      </details>

      <div className="card">
        <div className="table-head">
          <h3 className="card-h">All scores</h3>
          <label className="sort">
            Sort by{" "}
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="score">Score</option>
              <option value="district">Group</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>
        <div className="table-wrap">
          <table className="scores">
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col">Group</th>
                <th scope="col">Verdict</th>
                <th scope="col" className="num">
                  Score
                </th>
                <th scope="col">Model</th>
                <th scope="col" className="num">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button type="button" className="link-btn" onClick={() => onOpen(r.id)}>
                      <strong>{r.short}</strong>
                      {r.role ? <span className="role">, {r.role}</span> : null}
                    </button>
                  </td>
                  <td>
                    <span aria-hidden="true" className="dot" style={{ background: r.district.color }} />
                    {r.district.label}
                  </td>
                  <td>
                    <span className="vpill" style={{ background: VSTYLE[r.v].bg, color: VSTYLE[r.v].fg }}>
                      {VSTYLE[r.v].label}
                    </span>
                  </td>
                  <td className="num">{r.score ?? "–"}</td>
                  <td className="muted">{r.model}</td>
                  <td className="num muted">{r.secs === null ? "–" : `${r.secs.toFixed(1)}s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="actions">
        <button type="button" className="ghost-btn" onClick={onCopy}>
          {copyLabel}
        </button>
        <button type="button" className="gbtn" onClick={onReset}>
          Change the idea and ask again
        </button>
      </div>
    </section>
  );
}

function Bar({ label, n, mean, color, rank }: { label: string; n: number; mean: number; color: string; rank?: number }) {
  return (
    <div className="sbar">
      {rank !== undefined && <span className="sbar-rank">#{rank}</span>}
      <span className="sbar-label">
        <span aria-hidden="true" className="dot" style={{ background: color }} />
        {label} <span className="muted">· {n}</span>
      </span>
      <div className="track track-lg">
        <div style={{ width: `${((mean - 1) / 9) * 100}%`, background: color }} />
      </div>
      <span className="sbar-v">{mean.toFixed(1)}</span>
    </div>
  );
}
