import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, rememberOwned } from "../api";
import { ideaToMarkdown } from "../exportMarkdown";
import type { ApiMeta, IdeaBrief, IdeaRecord, OwnKey, PersonaFailure, PersonaVerdict, Quota, Synthesis } from "../types";
import { ProposalForm, type Council } from "./ProposalForm";
import { ProposalSummary } from "./ProposalSummary";
import { ReviewPanel } from "./ReviewPanel";
import { Results } from "./Results";
import { Village } from "./Village";
import { VSTYLE, explainFailure, planFromServer, sortByArrival, splitName, toV, type Stage, type V } from "./model";
import { RunOptions, loadRememberedKeys, type KeyMode } from "./RunOptions";
import { RecentProposals } from "./RecentProposals";

const EMPTY_BRIEF: IdeaBrief = {
  title: "",
  description: "",
  targetAudience: "",
  pricingModel: "",
  competitors: "",
  sliders: { reach: 5, buildCost: 5, userImportance: 5, complexity: 5, value: 5, risk: 5 },
};
const ASSEMBLY_MS = 2400;
const STEPS: [Stage, string][] = [
  ["idle", "Proposal"],
  ["assembly", "Gather"],
  ["thinking", "Deliberate"],
  ["deciding", "Pick sides"],
  ["result", "Verdict"],
];

export function GamePage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const fresh = (location.state as { fresh?: boolean } | null)?.fresh ?? false;

  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [brief, setBrief] = useState<IdeaBrief>(EMPTY_BRIEF);
  const [council, setCouncil] = useState<Council>({ mode: "single", single: "", mixed: [] });
  // How the run is paid for. A visitor's own keys live only in this tab (and localStorage if they opt in).
  const [ownKeys, setOwnKeys] = useState<OwnKey[]>(() => loadRememberedKeys());
  const [keyMode, setKeyMode] = useState<KeyMode>(() => (loadRememberedKeys().length ? "own" : "free"));
  const [quota, setQuota] = useState<Quota | null>(null);
  const pendingSelect = useRef<string | undefined>(undefined);
  const [idea, setIdea] = useState<IdeaRecord | null>(null);
  const [verdicts, setVerdicts] = useState<Map<string, PersonaVerdict>>(new Map());
  const [failures, setFailures] = useState<Map<string, PersonaFailure>>(new Map());
  const [synthesis, setSynthesis] = useState<Synthesis | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy results as Markdown");
  const unsub = useRef<(() => void) | null>(null);
  const villageRef = useRef<HTMLElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(760);

  // ---- metadata (personas + the site's providers + limits)
  const loadMeta = useCallback(async () => {
    const m = await api.getMeta();
    setMeta(m);
    return m;
  }, []);
  const loadQuota = useCallback(() => api.getQuota().then(setQuota).catch(() => undefined), []);

  /** The providers the council can be drawn from: the site's (free tier) or this visitor's own keys. */
  const councilMeta = useMemo<ApiMeta | null>(() => {
    if (!meta || keyMode === "free") return meta;
    return {
      ...meta,
      mock: false,
      providers: ownKeys.map((k) => ({ key: k.provider, name: k.provider, model: k.model, stats: { calls: 0, retries: 0, rateLimited: 0, failures: 0 }, usable: true, reason: null, source: "own" as const, capacity: k.capacity })),
    };
  }, [meta, keyMode, ownKeys]);

  // Keep the council's picks valid whenever the available providers change.
  useEffect(() => {
    if (!councilMeta) return;
    const usable = councilMeta.providers.filter((p) => p.usable);
    const select = pendingSelect.current;
    pendingSelect.current = undefined;
    setCouncil((c) => {
      const keep = (k: string) => usable.some((p) => p.key === k);
      const single = select && keep(select) ? select : keep(c.single) ? c.single : usable[0]?.key ?? "";
      const mixed = c.mixed.filter(keep);
      const first = !c.single && c.mixed.length === 0;
      const wantsMixed = first ? councilMeta.panelMode === "mixed" : c.mode === "mixed";
      const mode = wantsMixed && usable.length >= 2 ? ("mixed" as const) : ("single" as const);
      return { mode, single, mixed: select && keep(select) && !mixed.includes(select) ? [...mixed, select] : mixed.length ? mixed : usable.map((p) => p.key) };
    });
  }, [councilMeta]);

  useEffect(() => {
    loadMeta().catch((e) => setFormError(`Can't reach the server: ${e.message}. Is it running?`));
    void loadQuota();
  }, [loadMeta, loadQuota]);

  // ---- load / follow an idea when the URL has one
  useEffect(() => {
    unsub.current?.();
    unsub.current = null;
    setVerdicts(new Map());
    setFailures(new Map());
    setSynthesis(null);
    setSynthesizing(false);
    setRunError(null);
    setSelected(null);
    setDrawer(null);
    if (!id) {
      setIdea(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (fresh) {
      setAssembling(true);
      timer = setTimeout(() => setAssembling(false), ASSEMBLY_MS);
    }
    const stop = () => {
      unsub.current?.();
      unsub.current = null;
    };
    api
      .getIdea(id)
      .then((state) => {
        setIdea(state.idea);
        const { sliders, title, description, targetAudience, pricingModel, competitors } = state.idea;
        setBrief({ title, description, targetAudience, pricingModel, competitors, sliders });
        setVerdicts(new Map(state.verdicts.map((v) => [v.personaId, v])));
        setFailures(new Map(state.failures.map((f) => [f.personaId, f])));
        setSynthesis(state.synthesis);
        if (state.idea.status === "failed") setRunError(state.idea.error ?? "The council couldn't reach a verdict.");
        if (state.idea.status !== "running") return;
        unsub.current = api.streamIdea(id, {
          onSnapshot: (snap) => {
            setVerdicts(new Map(snap.verdicts.map((v: PersonaVerdict) => [v.personaId, v])));
            setFailures(new Map(snap.failures.map((f: PersonaFailure) => [f.personaId, f])));
            if (snap.synthesis) setSynthesis(snap.synthesis);
            if (snap.status && snap.status !== "running") {
              setIdea((p) => (p ? { ...p, status: snap.status } : p));
              if (snap.status === "failed") setRunError(snap.error ?? "The council couldn't reach a verdict.");
              stop();
            }
          },
          onProgress: (e) => {
            if (e.type === "verdict") {
              setVerdicts((prev) => new Map(prev).set(e.verdict.personaId, e.verdict));
              setFailures((prev) => {
                if (!prev.has(e.verdict.personaId)) return prev;
                const next = new Map(prev);
                next.delete(e.verdict.personaId);
                return next;
              });
            } else if (e.type === "failure") {
              setFailures((prev) => new Map(prev).set(e.failure.personaId, e.failure));
            } else if (e.type === "synthesizing") {
              setSynthesizing(true);
            } else if (e.type === "done") {
              setSynthesizing(false);
              setSynthesis(e.synthesis);
              setIdea((p) => (p ? { ...p, status: "completed" } : p));
              stop();
            } else if (e.type === "error") {
              setSynthesizing(false);
              setRunError(e.message);
              setIdea((p) => (p ? { ...p, status: "failed" } : p));
              stop();
            }
          },
        });
      })
      .catch((e) => setRunError(e.message === "not found" ? "No proposal with that id." : e.message));
    return () => {
      if (timer) clearTimeout(timer);
      unsub.current?.();
    };
  }, [id, fresh]);

  const personas = meta?.personas ?? [];
  const idxOf = useMemo(() => new Map(personas.map((p, i) => [p.id, i])), [personas]);
  const total = meta?.personaCount ?? 45;

  const arrival = useMemo(() => sortByArrival<{ personaId: string; createdAt: string }>([...verdicts.values(), ...failures.values()]).map((x) => x.personaId), [verdicts, failures]);
  const verdictOf = useCallback((pid: string): V | undefined => {
    const v = verdicts.get(pid);
    if (v) return toV(v.verdict);
    return failures.has(pid) ? "f" : undefined;
  }, [verdicts, failures]);

  const stage: Stage = !id || !idea ? (submitting ? "assembly" : "idle")
    : synthesis ? "result"
    : idea.status === "failed" ? "failed"
    : assembling ? "assembly"
    : arrival.length === 0 ? "thinking"
    : "deciding";

  const counts = { b: 0, m: 0, d: 0, f: 0 } as Record<V, number>;
  for (const pid of arrival) {
    const v = verdictOf(pid);
    if (v) counts[v]++;
  }

  async function submit() {
    setFormError(null);
    setSubmitting(true);
    try {
      const providers = council.mode === "single" ? (council.single ? [council.single] : []) : council.mixed;
      // Own keys: send only the keys this council actually uses, and only with this request.
      const keys = keyMode === "own" ? ownKeys.filter((k) => providers.includes(k.provider)).map(({ provider, apiKey, model }) => ({ provider, apiKey, model })) : undefined;
      const res = await api.submitIdea({ ...brief, panelMode: council.mode, providers, keyMode, ownKeys: keys });
      rememberOwned(res.id, res.ownerToken);
      setQuota(res.quota);
      navigate(`/ideas/${res.id}`, { state: { fresh: true } });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      void loadQuota();
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    navigate("/");
  }

  // ---- bubble (short take) for the selected character
  const selPersona = selected ? personas.find((p) => p.id === selected) : undefined;
  let bubble: ReactNode = null;
  if (selPersona) {
    const { short, role } = splitName(selPersona.name);
    const v = verdicts.get(selPersona.id);
    const f = failures.get(selPersona.id);
    const vk = v ? toV(v.verdict) : f ? "f" : null;
    const st = vk ? VSTYLE[vk] : null;
    bubble = (
      <div className="bubble-card" role="dialog" aria-label={`${selPersona.name}: short take`}>
        <div className="bubble-name">
          {short}
          {role && <span>, {role}</span>}
        </div>
        <div className="bubble-meta">
          {st ? (
            <span className="vpill" style={{ background: st.bg, color: st.fg }}>
              {st.label}
            </span>
          ) : (
            <span className="vpill" style={{ background: "#F3F4F6", color: "#374151" }}>
              {stage === "idle" ? "AT HOME" : "THINKING…"}
            </span>
          )}
          {v && <span>Score {v.score}/10</span>}
          {f && <span>No vote counted</span>}
        </div>
        <p className="bubble-line">
          {v ? `“${toV(v.verdict) === "b" ? v.topAppeal : v.topConcern}”` : f ? explainFailure(f, short).short : stage === "idle" ? selPersona.tagline : "Still weighing it up. Their verdict appears the moment it arrives."}
        </p>
        <div className="bubble-actions">
          {(v || f) && (
            <button type="button" className="gbtn gbtn-sm" onClick={() => setDrawer(selPersona.id)}>
              {f ? "Why did they go home? →" : "Read full review →"}
            </button>
          )}
          <button type="button" className="ghost-dark" onClick={() => setSelected(null)}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const judged = verdicts.size;
  const impact = synthesis
    ? `No. ${judged} of ${total} personas voted, above the 80% the council needs. Their seat is left empty rather than guessed. Ask again later and they get another chance.`
    : idea?.status === "failed"
      ? "Yes: too few personas answered for a trustworthy verdict, so the council didn’t publish one."
      : "Their seat stays empty. The verdict will use everyone who answers, as long as at least 80% do.";

  const drawerPersona = drawer ? personas.find((p) => p.id === drawer) : undefined;

  const banner = synthesis
    ? { word: { build: "BUILD IT", maybe: "MIXED", dont_build: "DON’T BUILD" }[synthesis.overallVerdict], score: synthesis.overallScore, color: VSTYLE[toV(synthesis.overallVerdict)].bright }
    : stage === "failed"
      ? { word: "NO VERDICT", score: "–", color: "#A5B4FC" }
      : null;

  const planText = idea?.sendPlan ? planFromServer(idea.sendPlan, total) : null;
  const hud = {
    idle: { title: "The council is at home", sub: `${total} personas · 5 districts`, foot: "Write a proposal, then summon the council." },
    assembly: { title: "The council is gathering…", sub: "Walking to the square", foot: planText ?? "Each character sets off as their question is sent." },
    thinking: { title: "The council is deliberating", sub: `0 of ${total} decided`, foot: planText ?? "Everyone thinks alone. Nobody sees anyone else’s answer." },
    deciding: { title: synthesizing ? "Everyone has answered. Finding the common themes…" : "Verdicts are arriving", sub: `${arrival.length} of ${total} decided`, foot: counts.f ? "Click anyone with a ! on their house to see why they went home." : planText && arrival.length < total ? planText : "Each verdict sends its character to a side." },
    result: { title: "The council has picked sides", sub: `${arrival.length} of ${total} finished`, foot: "Full results below ↓" },
    failed: { title: "The council couldn’t reach a verdict", sub: `${judged} of ${total} answered`, foot: runError ?? "" },
  }[stage];

  const pips = arrival.map((pid) => VSTYLE[verdictOf(pid)!].solid);
  while (pips.length < total) pips.push("rgba(255,255,255,0.10)");
  const curStep = STEPS.findIndex(([k]) => k === (stage === "failed" ? "result" : stage));

  async function copy() {
    if (!idea) return;
    const md = ideaToMarkdown(idea, [...verdicts.values()], [...failures.values()], synthesis, (pid) => personas.find((p) => p.id === pid)?.name ?? pid);
    try {
      await navigator.clipboard.writeText(md);
      setCopyLabel("Copied!");
    } catch {
      setCopyLabel("Couldn’t copy: your browser blocked it");
    }
    setTimeout(() => setCopyLabel("Copy results as Markdown"), 2200);
  }

  const panelModel = meta ? (meta.mock ? "Simulated models (mock mode)" : meta.providers.filter((p) => p.usable).map((p) => `${p.name} / ${p.model}`).join(" · ") || "No working provider") : "Connecting…";

  return (
    <div className="game">
      <header className="g-header">
        <div className="g-wrap g-header-row">
          <Link to="/" className="g-brand" onClick={() => setSelected(null)}>
            <svg aria-hidden="true" width="40" height="40" viewBox="0 0 40 40">
              <rect width="40" height="40" rx="12" fill="#FBBF24" />
              <polygon points="8,20 20,9 32,20" fill="#111827" />
              <rect x="12" y="19" width="16" height="12" rx="2" fill="#111827" />
              <path d="M18 31v-5a2 2 0 0 1 4 0v5z" fill="#FBBF24" />
            </svg>
            <span>
              <span className="g-brand-name">Build or Not</span>
              <span className="g-brand-sub">A village of {total} AI personas judges your idea</span>
            </span>
          </Link>
          <ol className="steps" aria-label="Council progress">
            {STEPS.map(([k, label], n) => {
              const done = n < curStep;
              const cur = n === curStep;
              return (
                <li key={k} className={`step ${cur ? "cur" : done ? "done" : ""}`} aria-current={cur ? "step" : undefined}>
                  <span className="step-dot">{done ? "✓" : n + 1}</span>
                  {label}
                </li>
              );
            })}
          </ol>
          <div className="g-header-right">
            <Link to="/history" className="g-link">
              Past proposals
            </Link>
            <span className="model-chip">
              <span aria-hidden="true" className="ok-dot" />
              {panelModel}
            </span>
          </div>
        </div>
      </header>

      <main className="g-wrap g-main">
        <div className={`g-side ${stage === "idle" ? "" : "pinned"}`}>
          {stage === "idle" ? (
            <ProposalForm
              brief={brief}
              onBrief={setBrief}
              council={council}
              onCouncil={setCouncil}
              meta={councilMeta}
              locked={false}
              submitting={submitting}
              submitLabel={submitting ? "Summoning…" : "Summon the council"}
              onSubmit={submit}
              error={formError}
              blocked={
                keyMode === "own"
                  ? ownKeys.length === 0
                    ? "Add your API key above first."
                    : null
                  : quota && quota.site.left === 0
                    ? `You've used today's ${quota.site.limit} free runs. Use your own key to keep going, or come back tomorrow.`
                    : null
              }
              keysSlot={
                <RunOptions
                  meta={meta}
                  quota={quota}
                  keyMode={keyMode}
                  onKeyMode={(m) => (setKeyMode(m), setFormError(null))}
                  ownKeys={ownKeys}
                  onOwnKeys={(keys, added) => {
                    pendingSelect.current = added;
                    setOwnKeys(keys);
                  }}
                  locked={false}
                />
              }
            />
          ) : (
            <ProposalSummary brief={brief} idea={idea} meta={meta} running={stage !== "result" && stage !== "failed"} onReset={stage === "result" || stage === "failed" ? reset : undefined} />
          )}
        </div>

        <div className="g-content">
          <section className="g-village-col" aria-labelledby="village-h" ref={villageRef}>
            <div className="g-col-head">
              <h2 id="village-h">The council village</h2>
              <span className="muted">{narrow ? "Swipe to explore · tap a character to hear them out" : "Hover a character for their name · click to hear them out"}</span>
            </div>
            <div className="g-village-wrap">
              {personas.length > 0 ? (
                <Village
                  personas={personas}
                  stage={stage}
                  arrival={arrival}
                  verdictOf={verdictOf}
                  selectedId={selected}
                  onPick={(pid) => setSelected((s) => (s === pid ? null : pid))}
                  bubble={drawer ? null : bubble}
                  banner={banner}
                  ideaLabel={brief.title || "Your idea"}
                />
              ) : (
                <div className="village-loading">{formError ? "Can't load the village." : "Building the village…"}</div>
              )}
              {drawerPersona && (
                <>
                  <div className="sheet-backdrop" onClick={() => setDrawer(null)} aria-hidden="true" />
                  <ReviewPanel persona={drawerPersona} index={idxOf.get(drawerPersona.id) ?? 0} verdict={verdicts.get(drawerPersona.id)} failure={failures.get(drawerPersona.id)} impact={impact} onClose={() => setDrawer(null)} />
                </>
              )}
            </div>

            <div className="hud" aria-live="polite">
              <div className="hud-top">
                <span className="hud-title">
                  <span aria-hidden="true" className={`hud-dot ${stage === "idle" || stage === "result" || stage === "failed" ? "" : "live"}`} style={{ background: stage === "result" ? "#34D399" : stage === "failed" ? "#A5B4FC" : stage === "idle" ? "#6B7280" : "#FBBF24" }} />
                  {hud.title}
                </span>
                <span className="hud-sub">{hud.sub}</span>
              </div>
              <div className="pips-row" role="progressbar" aria-label="Personas decided" aria-valuemin={0} aria-valuemax={total} aria-valuenow={arrival.length} style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}>
                {pips.map((c, k) => (
                  <span key={k} style={{ background: c }} />
                ))}
              </div>
              <div className="hud-legend">
                <span><i style={{ background: VSTYLE.b.solid }} />{counts.b} build</span>
                <span><i style={{ background: VSTYLE.m.solid }} />{counts.m} maybe</span>
                <span><i style={{ background: VSTYLE.d.solid }} />{counts.d} don’t build</span>
                <span><i style={{ background: VSTYLE.f.solid }} />{counts.f} went home</span>
                {stage === "result" ? (
                  <button type="button" className="jump-btn" onClick={() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                    Jump to results ↓
                  </button>
                ) : (
                  <span className="muted">{hud.foot}</span>
                )}
              </div>
            </div>
          </section>

          <div ref={resultsRef} className="results-anchor">
            {synthesis && idea && (
              <Results
                idea={idea}
                personas={personas}
                verdicts={[...verdicts.values()]}
                failures={[...failures.values()]}
                synthesis={synthesis}
                onOpen={(pid) => {
                  setSelected(pid);
                  setDrawer(pid);
                  if (!narrow) villageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                onReset={reset}
                onCopy={copy}
                copyLabel={copyLabel}
              />
            )}
            {stage === "idle" && <RecentProposals />}
            {stage === "failed" && (
              <section className="results">
                <div className="card">
                  <h2 className="card-h">No verdict this time</h2>
                  <p>{runError}</p>
                  <p className="muted">Click the characters at home (marked !) to see what went wrong for each of them, then try again.</p>
                </div>
              </section>
            )}
          </div>
        </div>
      </main>
      <footer className="g-wrap g-foot muted">Verdicts come from AI personas: a structured second opinion, not a guarantee.</footer>
    </div>
  );
}

/** True below the given viewport width (phones / small tablets). */
function useNarrow(px: number): boolean {
  const query = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}
