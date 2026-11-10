/**
 * Dataset loaders. Each turns raw data into EvalItems with a binary outcome label.
 *
 * YC (default): the community-maintained mirror of YC's public directory
 *   https://yc-oss.github.io/api/companies/all.json — each company has a batch and a status
 *   (Active / Acquired / Public / Inactive).
 *
 * Threats to validity, handled or at least named (put these in the report and be ready to discuss them):
 *  - Memorization: the model may simply KNOW a famous company's fate. Mitigations: drop YC "top
 *    companies", strip the company name/slug/domain from the text, and keep the sample to less-famous
 *    companies. It can't be fully eliminated; that's why we compare conditions on the SAME items —
 *    leakage inflates every condition, so the *difference* between them is still meaningful.
 *  - Maturity: recent batches haven't had time to fail. Default batch window is 2012–2020.
 *  - Hindsight in descriptions: surviving companies keep editing their descriptions (pivots, polish);
 *    dead companies' text is frozen. This biases toward "well-written = alive". Named, not fixed.
 *  - "Alive" ≠ "good idea": Active includes zombies; Acquired includes acqui-hires. The `exit` label
 *    mode (Public/Acquired vs Inactive, Active excluded) is offered as a sensitivity check.
 */
import fs from "node:fs";
import type { EvalItem } from "./types.js";

export type LabelMode = "alive" | "exit";

interface YCCompany {
  id?: number;
  name: string;
  slug: string;
  website?: string;
  one_liner?: string;
  long_description?: string;
  batch?: string;
  status?: string;
  industries?: string[];
  top_company?: boolean;
}

export const YC_URL = "https://yc-oss.github.io/api/companies/all.json";

export async function downloadYC(dest: string): Promise<number> {
  const res = await fetch(YC_URL);
  if (!res.ok) throw new Error(`Failed to download ${YC_URL}: HTTP ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(dest, text);
  return (JSON.parse(text) as unknown[]).length;
}

/** "W15" -> 2015, "S2012"/"Summer 2012" -> 2012. Returns null if unparseable. */
export function batchYear(batch: string | undefined): number | null {
  if (!batch) return null;
  const four = batch.match(/(20\d\d)/);
  if (four) return Number(four[1]);
  const two = batch.match(/^[A-Za-z]+\s*(\d\d)$/);
  return two ? 2000 + Number(two[1]) : null;
}

export function anonymize(text: string, c: Pick<YCCompany, "name" | "slug" | "website">): string {
  const terms = [c.name, c.slug, c.slug?.replace(/-/g, " ")];
  if (c.website) {
    try {
      terms.push(new URL(c.website).hostname.replace(/^www\./, ""));
    } catch {
      /* ignore bad URLs */
    }
  }
  let out = text;
  for (const t of terms.filter((t): t is string => !!t && t.length >= 3)) {
    out = out.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "the company");
  }
  return out;
}

export function loadYC(file: string, opts: { labelMode: LabelMode; fromYear: number; toYear: number }): EvalItem[] {
  const raw: YCCompany[] = JSON.parse(fs.readFileSync(file, "utf8"));
  const items: EvalItem[] = [];
  for (const c of raw) {
    if (c.top_company) continue; // famous -> memorization risk
    const year = batchYear(c.batch);
    if (year === null || year < opts.fromYear || year > opts.toYear) continue;
    const desc = [c.one_liner, c.long_description].filter(Boolean).join("\n\n").trim();
    if (desc.length < 80) continue; // too thin to judge

    let label: 0 | 1 | null = null;
    if (c.status === "Inactive") label = 0;
    else if (opts.labelMode === "alive" && (c.status === "Active" || c.status === "Acquired" || c.status === "Public")) label = 1;
    else if (opts.labelMode === "exit" && (c.status === "Acquired" || c.status === "Public")) label = 1;
    if (label === null) continue;

    items.push({
      id: `yc-${c.slug}`,
      text: anonymize(desc, c).slice(0, 2500),
      label,
      meta: { batch: c.batch ?? "", status: c.status ?? "", industries: (c.industries ?? []).join(", ") },
    });
  }
  return items;
}

/** Generic CSV: you pick the text, label and id columns. Label column values are matched against `positive`. */
export function loadCsv(file: string, opts: { textCols: string[]; labelCol: string; positive: string[]; negative: string[]; idCol?: string }): EvalItem[] {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const [header, ...body] = rows;
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV has no column "${name}". Columns: ${header.join(", ")}`);
    return i;
  };
  const textIdx = opts.textCols.map(col);
  const labelIdx = col(opts.labelCol);
  const idIdx = opts.idCol ? col(opts.idCol) : -1;
  const items: EvalItem[] = [];
  body.forEach((r, n) => {
    const lv = r[labelIdx]?.trim().toLowerCase();
    const label = opts.positive.includes(lv) ? 1 : opts.negative.includes(lv) ? 0 : null;
    if (label === null) return;
    const text = textIdx.map((i) => r[i]).filter(Boolean).join("\n");
    if (!text.trim()) return;
    items.push({ id: `csv-${idIdx >= 0 ? r[idIdx] : n}`, text: text.slice(0, 2500), label, meta: {} });
  });
  return items;
}

/** RFC-4180-ish CSV parser: quoted fields, escaped quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Seeded PRNG (mulberry32) so the same --seed always picks the same sample. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Balanced sample: n/2 successes and n/2 failures, so AUC/Brier aren't dominated by the base rate. */
export function balancedSample(items: readonly EvalItem[], n: number, seed: number): EvalItem[] {
  const rand = seededRandom(seed);
  const pos = shuffle(items.filter((i) => i.label === 1), rand);
  const neg = shuffle(items.filter((i) => i.label === 0), rand);
  const half = Math.floor(n / 2);
  if (pos.length < half || neg.length < half) {
    throw new Error(`Not enough data for a balanced sample of ${n}: ${pos.length} positive, ${neg.length} negative available.`);
  }
  return shuffle([...pos.slice(0, half), ...neg.slice(0, half)], rand);
}
