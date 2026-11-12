import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ownerTokenFor, rememberOwned } from "../api";
import { AccountButton, useAuth } from "../auth";
import { ideaToMarkdown } from "../exportMarkdown";
import type { ApiMeta, IdeaBrief, IdeaRecord, OwnKey, PersonaFailure, PersonaVerdict, Quota, Synthesis } from "../types";
import { ProposalForm, type Council } from "./ProposalForm";
import { ProposalSummary } from "./ProposalSummary";
import { ReviewPanel } from "./ReviewPanel";
import { Results } from "./Results";
import { Village } from "./Village";
import { productName, VSTYLE, explainFailure, planFromServer, sortByArrival, splitName, toV, type Stage, type V } from "./model";
import { RunOptions, loadRememberedKeys, type KeyMode } from "./RunOptions";
import { RecentProposals } from "./RecentProposals";
import { DraftDialog } from "./DraftDialog";
import { FixNudge } from "./FixNudge";

const EMPTY_BRIEF: IdeaBrief = {
  title: "",
  description: "",
  targetAudience: "",
  pricingModel: "",
  competitors: "",
  sliders: { reach: 5, buildCost: 5, userImportance: 5, complexity: 5, value: 5, risk: 5 },
  kind: "startup",
  productContext: "",
  hidden: false,
};
const ASSEMBLY_MS = 2400;
const STEPS: [Stage, string][] = [
  ["idle", "Your idea"],
  ["assembly", "Gather"],
  ["thinking", "Think"],
  ["deciding", "Vote"],
  ["result", "Result"],
];

export function GamePage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const fresh = (location.state as { fresh?: boolean } | null)?.fresh ?? false;

  const [meta, setMeta] = useState<ApiMeta | null>(null);
  // A form saved just before leaving to sign in with Google/GitHub comes back here.
  const [restored] = useState(() => readPendingBrief());
  // Cleared after mounting, not while reading: React may run the initializer twice in development.
  useEffect(() => clearPendingBrief(), []);
  const [brief, setBrief] = useState<IdeaBrief>(restored ?? EMPTY_BRIEF);
  const auth = useAuth();
  const briefRef = useRef(brief);
  briefRef.current = brief;
  useEffect(() => auth.beforeLeave(() => savePendingBrief(briefRef.current)), [auth.beforeLeave]);
  const [council, setCouncil] = useState<Council>({ mode: "single", single: "", mixed: [] });
  // How the run is paid for. A visitor's own keys live only in this tab (and localStorage if they opt in).
  const [ownKeys, setOwnKeys] = useState<OwnKey[]>(() => loadRememberedKeys());
  const [keyMode, setKeyMode] = useState<KeyMode>(() => (loadRememberedKeys().length ? "own" : "free"));
  const [quota, setQuota] = useState<Quota | null>(null);
  const pendingSelect = useRef<string | undefined>(undefined);
  // The "just type your idea" popup opens by itself on the home page, unless the visitor opted out.
  const [draftOpen, setDraftOpen] = useState(() => !id && !quickStartDismissed() && !restored);
  const currentBrief = brief;
  const [idea, setIdea] = useState<IdeaRecord | null>(null);
  // "Fix my idea": the corner button bumps this; the results card scrolls into view and starts.
  const [fixSignal, setFixSignal] = useState(0);
  const [fixReady, setFixReady] = useState(false);
  useEffect(() => {
    setFixSignal(0);
    setFixReady(false);
  }, [id]);
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
  const phone = useNarrow(PHONE_QUERY);

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
    loadMeta().catch((e) => setFormError(`Can't reach the server (${e.message}). Check that it's running.`));
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
        const { sliders, title, description, targetAudience, pricingModel, competitors, kind = "startup", productContext = "", hidden = false } = state.idea;
        setBrief({ title, description, targetAudience, pricingModel, competitors, sliders, kind, productContext, hidden });
        setVerdicts(new Map(state.verdicts.map((v) => [v.personaId, v])));
        setFailures(new Map(state.failures.map((f) => [f.personaId, f])));
        setSynthesis(state.synthesis);
        if (state.idea.status === "failed") setRunError(state.idea.error ?? "No result: too few personas answered.");
        if (state.idea.status !== "running") return;
        unsub.current = api.streamIdea(id, {
          onSnapshot: (snap) => {
            setVerdicts(new Map(snap.verdicts.map((v: PersonaVerdict) => [v.personaId, v])));
            setFailures(new Map(snap.failures.map((f: PersonaFailure) => [f.personaId, f])));
            if (snap.synthesis) setSynthesis(snap.synthesis);
            if (snap.status && snap.status !== "running") {
              setIdea((p) => (p ? { ...p, status: snap.status } : p));
              if (snap.status === "failed") setRunError(snap.error ?? "No result: too few personas answered.");
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
      // A private run looks exactly like a missing one to anyone but its owner (the server says "not found" for both).
      .catch((e) => setRunError(e.message === "not found" ? "NOT_FOUND" : e.message));
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

  async function submit(override?: IdeaBrief) {
    const brief = override ?? currentBrief;
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
      const msg = e instanceof Error ? e.message : String(e);
      if (/sign in to keep/i.test(msg)) {
        // Private run without an account (or the session ran out): sign in, then send it again.
        auth.openSignIn({ reason: "Sign in to keep this run private. Your idea stays as it is.", onDone: () => void submit(brief) });
      } else {
        setFormError(msg);
      }
      void loadQuota();
    } finally {
      setSubmitting(false);
    }
  }

  /** On phones the small card is a full-width sheet, so closing the full review must not bring it back over the page. */
  function closeDrawer() {
    setDrawer(null);
    if (narrow) setSelected(null);
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
          {f && <span>Didn’t vote</span>}
        </div>
        <p className="bubble-line">
          {v ? `“${toV(v.verdict) === "b" ? v.topAppeal : v.topConcern}”` : f ? explainFailure(f, short).short : stage === "idle" ? selPersona.tagline : "Still thinking. Their answer shows up here as soon as it’s in."}
        </p>
        {v?.fix && <p className="bubble-fix">Would change their mind: {v.fix}</p>}
        <div className="bubble-actions">
          {(v || f) && (
            <button type="button" className="gbtn gbtn-sm" onClick={() => setDrawer(selPersona.id)}>
              {f ? "Why didn’t they vote? →" : "Read their full answer →"}
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
    ? `No. ${judged} of ${total} voted, and a result only needs 80%. Their vote is left out, not guessed.`
    : idea?.status === "failed"
      ? "Yes. Too few personas answered, so there’s no result this time."
      : "Their vote is left out. The result uses everyone else, as long as at least 80% answer.";

  const drawerPersona = drawer ? personas.find((p) => p.id === drawer) : undefined;

  const banner = synthesis
    ? { word: { build: "BUILD IT", maybe: "MAYBE", dont_build: "DON’T BUILD" }[synthesis.overallVerdict], score: synthesis.overallScore, color: VSTYLE[toV(synthesis.overallVerdict)].bright }
    : stage === "failed"
      ? { word: "NO RESULT", score: "–", color: "#A5B4FC" }
      : null;

  const planText = idea?.sendPlan ? planFromServer(idea.sendPlan, total) : null;

  // Why the council can't be summoned right now, if it can't.
  const runBlocked =
    keyMode === "own"
      ? ownKeys.length === 0
        ? "Add your API key above first."
        : null
      : quota && quota.site.left === 0
        ? `You’ve used your ${quota.site.limit} free runs for today. Use your own key, or come back tomorrow.`
        : null;

  /** "Just type your idea": the AI drafts the brief on the same key the run will use. */
  const councilKeys = council.mode === "single" ? (council.single ? [council.single] : []) : council.mixed;
  const draftKey = keyMode === "own" ? ownKeys.find((k) => councilKeys.includes(k.provider)) ?? ownKeys[0] : undefined;
  const draftSource =
    keyMode === "own"
      ? draftKey
        ? `your own ${draftKey.provider} key`
        : "your own key (add it first)"
      : meta?.mock
        ? "simulated AI (this site has no AI key)"
        : `a free run${quota ? ` (${quota.site.left} of ${quota.site.limit} left today)` : ""}`;
  const helperKeys = () => {
    if (keyMode === "own" && !draftKey) throw new Error("Add your API key first.");
    return { keyMode, ownKeys: draftKey ? [{ provider: draftKey.provider, apiKey: draftKey.apiKey, model: draftKey.model }] : undefined };
  };
  const draftIdea = (text: string) => {
    try {
      // Quick start knows about feature mode: the AI drafts the feature against the product description.
      return api.draftIdea({ idea: text, ...helperKeys(), kind: brief.kind, productContext: brief.kind === "feature" ? brief.productContext : "" });
    } catch (e) {
      return Promise.reject(e);
    }
  };
  /** "Fix my idea with AI" on the results page; one call, same key the run used. */
  const improveIdea = () => {
    try {
      return api.improveIdea(idea!.id, helperKeys());
    } catch (e) {
      return Promise.reject(e);
    }
  };
  /** Put the revised brief in the form; asking the council again is then one explicit click (a new run). */
  function useRevised(b: IdeaBrief) {
    setBrief(b);
    setSelected(null);
    navigate("/");
    window.scrollTo({ top: 0 });
  }
  const hud = {
    idle: { title: "Waiting for your idea", sub: `${total} personas in 5 groups`, foot: "Describe your idea on the left, then press “Ask the council”." },
    assembly: { title: "Everyone is heading to the square…", sub: "Getting ready", foot: planText ?? "Each person sets off when their question is sent." },
    thinking: { title: "Everyone is thinking", sub: `0 of ${total} answered`, foot: planText ?? "Each persona answers on their own. No one sees the others’ answers." },
    deciding: { title: synthesizing ? "Everyone has answered. Summing up…" : "Answers are coming in", sub: `${arrival.length} of ${total} answered`, foot: counts.f ? "Tap anyone with a ! on their house to see why they didn’t vote." : planText && arrival.length < total ? planText : "Each answer sends that person to a side." },
    result: { title: "Everyone has voted", sub: `${arrival.length} of ${total} done`, foot: "Your results are below ↓" },
    failed: { title: "No result this time", sub: `${judged} of ${total} answered`, foot: runError ?? "" },
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

  const panelModel = meta ? (meta.mock ? "Simulated AI (no key)" : meta.providers.filter((p) => p.usable).map((p) => `${p.name} / ${p.model}`).join(" · ") || "No AI working") : "Connecting…";

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
              <span className="g-brand-sub">{total} AI personas tell you if your idea is worth building</span>
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
              All ideas
            </Link>
            <AccountButton />
            <span className="model-chip">
              <span aria-hidden="true" className="ok-dot" />
              {panelModel}
            </span>
          </div>
        </div>
      </header>

      {id && !idea && runError && (
        <div className="g-wrap">
          <div className="hist-state run-missing" role="alert">
            <h2>{runError === "NOT_FOUND" ? "Can’t open this run" : "Couldn’t load this run"}</h2>
            <p className="muted">
              {runError === "NOT_FOUND"
                ? "It may be private (only the person who ran it can open it), deleted, or the link may be wrong."
                : runError}
            </p>
            <Link to="/" className="gbtn gbtn-sm hist-cta" onClick={() => setRunError(null)}>
              Ask the council about your own idea →
            </Link>
          </div>
        </div>
      )}
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
              submitLabel={submitting ? "Sending…" : "Ask the council"}
              onSubmit={() => submit()}
              onQuickStart={() => setDraftOpen(true)}
              error={formError}
              blocked={runBlocked}
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
              <h2 id="village-h">The village</h2>
              <span className="muted">{narrow ? "Tap a person to read their answer." : "Hover over a person to see who they are. Click to read their answer."}</span>
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
                  sheet={narrow}
                  onDismiss={() => setSelected(null)}
                  expandable={phone}
                  shape={narrow ? "tall" : "wide"}
                />
              ) : (
                <div className="village-loading">{formError ? "Can't load the village." : "Building the village…"}</div>
              )}
              {drawerPersona && (
                <>
                  <div className="sheet-backdrop" onClick={closeDrawer} aria-hidden="true" />
                  <ReviewPanel persona={drawerPersona} index={idxOf.get(drawerPersona.id) ?? 0} verdict={verdicts.get(drawerPersona.id)} failure={failures.get(drawerPersona.id)} impact={impact} onClose={closeDrawer} />
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
                <span><i style={{ background: VSTYLE.f.solid }} />{counts.f} didn’t vote</span>
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
                onImprove={improveIdea}
                onUseRevised={useRevised}
                improveSignal={fixSignal}
                onPlanReady={() => setFixReady(true)}
              />
            )}
            {stage === "failed" && (
              <section className="results">
                <div className="card">
                  <h2 className="card-h">No result this time</h2>
                  <p>{runError}</p>
                  <p className="muted">Tap the people marked ! to see what went wrong, then try again.</p>
                </div>
              </section>
            )}
          </div>
        </div>
      </main>
      {/* Past submissions go last, below everything else on the page. */}
      {stage === "idle" && (
        <div className="g-wrap g-recent">
          <RecentProposals />
        </div>
      )}
      {stage === "result" && synthesis && idea && (idea.yours || ownerTokenFor(idea.id)) && !fixReady && (
        <FixNudge
          ideaId={idea.id}
          verdict={synthesis.overallVerdict}
          // Out of the way while a persona's card or full answer is open.
          hidden={!!selected || !!drawer || fixSignal > 0}
          onFix={() => setFixSignal((n) => n + 1)}
        />
      )}
      <DraftDialog
        open={draftOpen}
        onClose={() => setDraftOpen(false)}
        hideNextTime={quickStartDismissed()}
        onHideNextTime={setQuickStartDismissed}
        draft={draftIdea}
        source={draftSource}
        featureOf={brief.kind === "feature" && brief.productContext ? productName(brief.productContext) || "your product" : null}
        blocked={runBlocked}
        settings={{ kind: brief.kind, productContext: brief.productContext, hidden: brief.hidden }}
        onSettings={(patch) => setBrief((b) => ({ ...b, ...patch }))}
        onDone={(b, run) => {
          // The quick draft fills in the idea; keep the startup/feature choice, product description and privacy.
          const merged = { ...b, kind: brief.kind, productContext: brief.productContext, hidden: brief.hidden };
          setBrief(merged);
          setDraftOpen(false);
          if (run) void submit(merged);
        }}
      />
      <footer className="g-wrap g-foot muted">These answers come from AI personas. Treat them as a second opinion, not a promise.</footer>
    </div>
  );
}

const QUICK_OFF = "bon.quickstart.off";
function quickStartDismissed(): boolean {
  try {
    return localStorage.getItem(QUICK_OFF) === "1";
  } catch {
    return false;
  }
}
function setQuickStartDismissed(off: boolean) {
  try {
    if (off) localStorage.setItem(QUICK_OFF, "1");
    else localStorage.removeItem(QUICK_OFF);
  } catch {
    /* storage blocked: it just shows again next time */
  }
}

/** Phones, upright or turned sideways (a sideways phone is wider than 760px but short). */
const PHONE_QUERY = "(max-width: 760px), (pointer: coarse) and (max-height: 500px)";

/** True below the given viewport width (phones / small tablets), or when the given media query matches. */
function useNarrow(px: number | string): boolean {
  const query = typeof px === "string" ? px : `(max-width: ${px}px)`;
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

const PENDING = "bon.pendingBrief";
/** Keep the half-filled form while the visitor signs in on Google/GitHub (this tab only). */
function savePendingBrief(b: IdeaBrief) {
  try {
    sessionStorage.setItem(PENDING, JSON.stringify(b));
  } catch {
    /* storage blocked: the form starts empty after signing in */
  }
}
function readPendingBrief(): IdeaBrief | null {
  try {
    const v = sessionStorage.getItem(PENDING);
    return v ? (JSON.parse(v) as IdeaBrief) : null;
  } catch {
    return null;
  }
}
function clearPendingBrief() {
  try {
    sessionStorage.removeItem(PENDING);
  } catch {
    /* nothing to clear */
  }
}
