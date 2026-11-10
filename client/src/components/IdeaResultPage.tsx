import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { IdeaRecord, PersonaFailure, PersonaVerdict, Synthesis } from "../types";
import { ResultsDashboard } from "./ResultsDashboard";

export function IdeaResultPage() {
  const { id } = useParams<{ id: string }>();
  const [idea, setIdea] = useState<IdeaRecord | null>(null);
  const [totalPersonas, setTotalPersonas] = useState(45);
  const [verdictsById, setVerdictsById] = useState<Map<string, PersonaVerdict>>(new Map());
  const [failuresById, setFailuresById] = useState<Map<string, PersonaFailure>>(new Map());
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthesis, setSynthesis] = useState<Synthesis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!id) return;
    setIdea(null);
    setVerdictsById(new Map());
    setFailuresById(new Map());
    setSynthesis(null);
    setSynthesizing(false);
    setError(null);
    setNotFound(false);
    unsubscribeRef.current?.();

    const stop = () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
    const addVerdict = (v: PersonaVerdict) =>
      setVerdictsById((prev) => new Map(prev).set(v.personaId, v));
    const addFailure = (f: PersonaFailure) =>
      setFailuresById((prev) => new Map(prev).set(f.personaId, f));

    api
      .getIdea(id)
      .then((state) => {
        setIdea(state.idea);
        setTotalPersonas(state.totalPersonas);
        setVerdictsById(new Map(state.verdicts.map((v) => [v.personaId, v])));
        setFailuresById(new Map(state.failures.map((f) => [f.personaId, f])));
        if (state.synthesis) setSynthesis(state.synthesis);
        if (state.idea.status === "failed") setError(state.idea.error ?? "The panel run failed.");
        if (state.idea.status !== "running") return;

        // Still running — follow it live. Verdicts are keyed by personaId, so a snapshot after a
        // reconnect and a live event for the same persona simply overwrite each other.
        unsubscribeRef.current = api.streamIdea(id, {
          onSnapshot: (snap) => {
            setVerdictsById(new Map(snap.verdicts.map((v: PersonaVerdict) => [v.personaId, v])));
            setFailuresById(new Map(snap.failures.map((f: PersonaFailure) => [f.personaId, f])));
            if (snap.synthesis) setSynthesis(snap.synthesis);
            if (snap.status && snap.status !== "running") {
              setIdea((prev) => (prev ? { ...prev, status: snap.status } : prev));
              if (snap.status === "failed") setError(snap.error ?? "The panel run failed.");
              stop(); // finished — don't let EventSource auto-reconnect forever
            }
          },
          onProgress: (data) => {
            if (data.type === "verdict") {
              addVerdict(data.verdict);
              setFailuresById((prev) => {
                if (!prev.has(data.verdict.personaId)) return prev;
                const next = new Map(prev);
                next.delete(data.verdict.personaId);
                return next;
              });
            } else if (data.type === "failure") addFailure(data.failure);
            else if (data.type === "synthesizing") setSynthesizing(true);
            else if (data.type === "done") {
              setSynthesizing(false);
              setSynthesis(data.synthesis);
              setIdea((prev) => (prev ? { ...prev, status: "completed" } : prev));
              stop();
            } else if (data.type === "error") {
              setSynthesizing(false);
              setError(data.message);
              setIdea((prev) => (prev ? { ...prev, status: "failed" } : prev));
              stop();
            }
          },
        });
      })
      .catch((e) => {
        if (e instanceof Error && e.message === "not found") setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      });

    return () => unsubscribeRef.current?.();
  }, [id]);

  const verdicts = useMemo(() => Array.from(verdictsById.values()), [verdictsById]);
  const failures = useMemo(() => Array.from(failuresById.values()), [failuresById]);

  if (notFound) return <div className="card error-box">No idea found with that id.</div>;
  if (!idea) return <div className="card muted">Loading…</div>;

  return (
    <ResultsDashboard
      idea={idea}
      verdicts={verdicts}
      failures={failures}
      totalPersonas={totalPersonas}
      synthesis={synthesis}
      synthesizing={synthesizing}
      error={error}
    />
  );
}
