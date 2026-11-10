import type { Verdict } from "../types";

const LABELS: Record<Verdict, string> = { build: "Build it", maybe: "Mixed signals", dont_build: "Don't build it" };
const TONES: Record<Verdict, string> = { build: "ok", maybe: "warn", dont_build: "danger" };

export function VerdictPill({ verdict }: { verdict: Verdict }) {
  return <span className={`pill ${TONES[verdict]}`}>{LABELS[verdict]}</span>;
}
