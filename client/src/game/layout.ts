/**
 * Pure layout math for the village (1280×736 design space): house positions, gathering spots
 * around the council square, and the BUILD / MAYBE / DON'T BUILD zones. No React here, so it's
 * easy to test and reason about.
 */
import type { PersonaMeta } from "../types";
import { DISTRICTS, districtOf, type V } from "./model";

export const W = 1280;
export const H = 736;
const CX = 640;
const CY = 425;

export interface Home {
  id: string;
  x: number; // feet position when standing at the door
  y: number;
  hx: number; // house top-left
  hy: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Each district holds up to 9 houses in a 3×3 grid, in persona-library order. */
export function computeHomes(personas: PersonaMeta[]): Map<string, Home> {
  const perDistrict = new Map<string, number>();
  const homes = new Map<string, Home>();
  for (const p of personas) {
    const d = districtOf(p.category);
    const j = perDistrict.get(d.category) ?? 0;
    perDistrict.set(d.category, j + 1);
    const hx = d.x + (j % 3) * 72 + 4;
    const hy = d.y + 26 + Math.floor(j / 3) * 70;
    homes.set(p.id, { id: p.id, x: hx + 32, y: hy + 52, hx, hy });
  }
  return homes;
}

/** Hex-packed spots around the square's centre, matched to personas by the direction of their home. */
export function computeGatherSpots(homes: Map<string, Home>): Map<string, Point> {
  const pts: (Point & { d: number })[] = [];
  for (let r = -6; r <= 6; r++)
    for (let q = -7; q <= 7; q++) {
      const x = 26 * (q + r / 2);
      const y = 23 * r;
      pts.push({ x: CX + x, y: CY + y + 14, d: x * x + y * y });
    }
  pts.sort((a, b) => a.d - b.d);
  const ang = (p: Point) => Math.atan2(p.y - CY, p.x - CX);
  const ids = [...homes.keys()];
  const slots = pts.slice(0, ids.length).sort((a, b) => ang(a) - ang(b));
  const byAngle = ids.sort((a, b) => ang(homes.get(a)!) - ang(homes.get(b)!));
  const out = new Map<string, Point>();
  byAngle.forEach((id, k) => out.set(id, { x: slots[k].x, y: slots[k].y }));
  return out;
}

const ZONES: Record<Exclude<V, "f">, { x0: number; y0: number; dy: number; cols: number }> = {
  b: { x0: 405, y0: 352, dy: 30, cols: 5 },
  d: { x0: 749, y0: 352, dy: 30, cols: 5 },
  m: { x0: 575, y0: 514, dy: 28, cols: 5 },
};

/** Spot in its side's zone for each decided persona, filled in arrival order. */
export function computeZoneSpots(arrival: string[], verdictOf: (id: string) => V | undefined): { spots: Map<string, Point>; counts: Record<V, number> } {
  const counts: Record<V, number> = { b: 0, m: 0, d: 0, f: 0 };
  const spots = new Map<string, Point>();
  for (const id of arrival) {
    const v = verdictOf(id);
    if (!v) continue;
    const n = counts[v]++;
    if (v === "f") continue;
    const z = ZONES[v];
    // Overflow (a very one-sided panel) keeps stacking rows; the zone box just grows visually.
    spots.set(id, { x: z.x0 + (n % z.cols) * 26 + 12, y: z.y0 + Math.floor(n / z.cols) * z.dy + 30 });
  }
  return { spots, counts };
}

export const ROADS = DISTRICTS.map((d) => {
  const x = d.x + 108;
  const y = d.y + 120;
  const dx = CX - x;
  const dy = CY - y;
  return { x, y, len: Math.round(Math.hypot(dx, dy)), deg: Math.round((Math.atan2(dy, dx) * 180) / Math.PI) };
});

export const TREES = [[290, 96, 34], [318, 290, 28], [262, 420, 38], [318, 640, 30], [946, 92, 36], [926, 288, 28], [986, 432, 34], [940, 640, 32], [446, 150, 26], [814, 150, 30], [424, 678, 34], [836, 676, 30], [352, 520, 24], [906, 520, 24]].map(([x, y, s]) => ({ x, y, s }));

export const PATCHES = [[300, 180, 120, 60, "#C0DEA2"], [880, 200, 140, 56, "#C0DEA2"], [250, 560, 110, 50, "#D2EABB"], [900, 600, 130, 54, "#D2EABB"], [560, 650, 160, 50, "#C0DEA2"], [700, 90, 90, 40, "#D2EABB"], [150, 300, 100, 44, "#D2EABB"], [1110, 330, 110, 46, "#C0DEA2"]].map(([x, y, w, h, c]) => ({ x: x as number, y: y as number, w: w as number, h: h as number, c: c as string }));
