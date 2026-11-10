import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PersonaVerdict } from "../types";

/** Ordinal x-axis (score 1-10), magnitude y (how many personas gave that score) — a single
 * series, so no legend, in the sequential blue ramp's mid step rather than a categorical hue. */
export function ScoreHistogram({ verdicts }: { verdicts: PersonaVerdict[] }) {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ score: i + 1, count: 0 }));
  for (const v of verdicts) {
    const idx = Math.max(1, Math.min(10, Math.round(v.score))) - 1;
    buckets[idx].count++;
  }

  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={buckets} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="score" tick={{ fill: "var(--chart-muted)", fontSize: 12 }} axisLine={{ stroke: "var(--chart-axis)" }} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fill: "var(--chart-muted)", fontSize: 12 }} axisLine={false} tickLine={false} width={28} />
          <Tooltip
            cursor={{ fill: "var(--chart-grid)" }}
            contentStyle={{ background: "var(--surface-1)", border: "1px solid var(--chart-grid)", borderRadius: 8, fontSize: 13 }}
            formatter={(value: number) => [`${value} persona${value === 1 ? "" : "s"}`, "Count"]}
            labelFormatter={(label) => `Score ${label}/10`}
          />
          <Bar dataKey="count" fill="var(--series-seq)" radius={[4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
