import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type SiteStats } from "../api";

const KEY = "bon.admin";
const VERDICT: Record<string, string> = { build: "Build", maybe: "Maybe", dont_build: "Don’t build" };

function readToken(): string {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}
function saveToken(t: string) {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The owner's numbers: visitors, where they came from, runs and how they ended. Unlocked with
 * ADMIN_TOKEN (set on the host). The token is kept for this tab only and sent as a header.
 */
export function StatsPage() {
  const [token, setToken] = useState(readToken);
  const [input, setInput] = useState("");
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<SiteStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api
      .getStats(token, days)
      .then((s) => (setStats(s), setError(null)))
      .catch((e) => {
        setError(e.message === "not found" ? "Stats are switched off: set ADMIN_TOKEN on the server (16+ characters)." : e.message);
        if (/token/i.test(e.message)) (saveToken(""), setToken(""));
      })
      .finally(() => setLoading(false));
  }, [token, days]);

  function unlock(e: FormEvent) {
    e.preventDefault();
    saveToken(input.trim());
    setToken(input.trim());
    setInput("");
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">BN</span>
          <span>Build or Not</span>
        </Link>
        <span className="topbar-sub">Site stats (only you can see this)</span>
        {token && (
          <button type="button" className="stats-lock" onClick={() => (saveToken(""), setToken(""), setStats(null))}>
            Lock
          </button>
        )}
      </header>
      <main className="main stats">
        {!token ? (
          <form className="card stats-login" onSubmit={unlock}>
            <h1>Site stats</h1>
            <p className="muted">Enter the ADMIN_TOKEN from your host's environment settings.</p>
            <input type="password" autoComplete="current-password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Admin token" aria-label="Admin token" />
            <button type="submit" disabled={input.trim().length < 16}>
              Unlock
            </button>
            {error && <div className="error-box">{error}</div>}
          </form>
        ) : error ? (
          <div className="error-box">{error}</div>
        ) : !stats ? (
          <p className="muted">{loading ? "Loading…" : ""}</p>
        ) : (
          <StatsView s={stats} days={days} onDays={setDays} />
        )}
      </main>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="sx-tile">
      <span className="sx-label">{label}</span>
      <span className="sx-value">{typeof value === "number" ? value.toLocaleString() : value}</span>
      {sub && <span className="sx-sub">{sub}</span>}
    </div>
  );
}

function StatsView({ s, days, onDays }: { s: SiteStats; days: number; onDays: (d: number) => void }) {
  const t = s.totals;
  const max = Math.max(1, ...s.daily.map((d) => d.visitors));
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
  const totalRefs = s.referrers.reduce((n, r) => n + r.visitors, 0) + s.direct;

  return (
    <>
      <div className="stats-head">
        <h1>Last {days} days</h1>
        <div className="stats-range" role="group" aria-label="Period">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" className={d === days ? "on" : ""} onClick={() => onDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>

      <section className="sx-tiles">
        <Tile label="Visitors" value={t.uniqueVisitors} sub={`${t.returningVisitors} came back on another day`} />
        <Tile label="Page views" value={t.pageViews} />
        <Tile label="Ran an idea" value={t.visitorsWhoRan} sub={`${pct(t.visitorsWhoRan, t.uniqueVisitors)} of visitors`} />
        <Tile label="Runs" value={t.runs} sub={`${t.freeRuns} free tier · ${t.ownKeyRuns} own key`} />
        <Tile label="Finished" value={t.completed} sub={`${t.failed} failed · ${pct(t.completed, t.runs)} success`} />
        <Tile label="Hit the free limit" value={t.hitFreeLimit} sub="visitors who used all their free runs" />
      </section>

      <section className="card">
        <h2>Visitors per day</h2>
        <div className="day-chart" role="img" aria-label="Visitors per day">
          {s.daily.map((d) => (
            <div key={d.day} className="day-col" title={`${d.day}: ${d.visitors} visitors, ${d.views} views, ${d.runs} runs`}>
              <span className="day-bar" style={{ height: `${(d.visitors / max) * 100}%` }}>
                {d.runs > 0 && <span className="day-runs" style={{ height: `${Math.min(100, (d.runs / Math.max(1, d.visitors)) * 100)}%` }} />}
              </span>
            </div>
          ))}
        </div>
        <div className="day-axis muted">
          <span>{s.daily[0]?.day}</span>
          <span>
            <i className="key-visitors" /> visitors <i className="key-runs" /> runs
          </span>
          <span>{s.daily[s.daily.length - 1]?.day}</span>
        </div>
      </section>

      <div className="stats-two">
        <section className="card">
          <h2>Where visitors came from</h2>
          {totalRefs === 0 ? (
            <p className="muted">No visits yet.</p>
          ) : (
            <table className="history-table">
              <tbody>
                {s.referrers.map((r) => (
                  <tr key={r.host}>
                    <td>{r.host}</td>
                    <td className="num">{r.visitors}</td>
                    <td className="num muted">{pct(r.visitors, totalRefs)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="muted">Direct (typed the link, or an app that hides it)</td>
                  <td className="num">{s.direct}</td>
                  <td className="num muted">{pct(s.direct, totalRefs)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </section>
        <section className="card">
          <h2>What they looked at</h2>
          <table className="history-table">
            <tbody>
              <tr>
                <td>Home (the village)</td>
                <td className="num">{s.pages.home}</td>
              </tr>
              <tr>
                <td>A proposal's results</td>
                <td className="num">{s.pages.idea}</td>
              </tr>
              <tr>
                <td>Past proposals</td>
                <td className="num">{s.pages.history}</td>
              </tr>
            </tbody>
          </table>
          <h2 style={{ marginTop: 16 }}>Verdicts given</h2>
          <p className="muted">
            Build {t.verdicts.build} · Maybe {t.verdicts.maybe} · Don’t build {t.verdicts.dont_build}
          </p>
        </section>
      </div>

      <section className="card">
        <h2>Latest runs</h2>
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Idea</th>
                <th>When</th>
                <th>Key</th>
                <th>Status</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {s.recentRuns.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/ideas/${r.id}`}>{r.title}</Link>
                  </td>
                  <td className="muted">{new Date(r.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</td>
                  <td>{r.keyMode === "own" ? "own key" : "free tier"}</td>
                  <td>
                    <span className={`pill ${r.status === "completed" ? "ok" : r.status === "failed" ? "danger" : "warn"}`}>{r.status}</span>
                  </td>
                  <td>{r.verdict ? `${VERDICT[r.verdict]} · ${r.score}/100` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="muted stats-note">
        Visitors are counted by a one-way hash of their IP address, so these numbers can't identify anyone. Several people sharing one network (an office, a college) count as one visitor. Only the referring site's name is kept, never the full link. Data is deleted after 90 days.
      </p>
    </>
  );
}
