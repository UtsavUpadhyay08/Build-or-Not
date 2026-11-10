/**
 * Visit counting and the owner's stats page.
 *
 *   POST /api/visit         the page reports one load: which page, and the site the visitor came from
 *   GET  /api/admin/stats   the owner's numbers, behind ADMIN_TOKEN (404 when it isn't set)
 *
 * Privacy: no cookies, no third-party scripts, no raw IPs. A visitor is an HMAC of their IP (the same
 * hash the daily run limit uses), so the stats count people without identifying them. Only the
 * referring site's host is kept (e.g. "linkedin.com"), never the full URL. Everything expires after 90 days.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store, VisitDay } from "../store/store.js";
import { today, visitorId } from "../security/visitor.js";
import { publicIdea } from "../types.js";

const ah = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const KEEP_DAYS = 90;

const expiry = () => new Date(Date.now() + KEEP_DAYS * 86_400_000);

/** Count something for this visitor today (a page view, a run, hitting the free limit…). Never throws. */
export async function countVisit(store: Store, req: Request, inc: Record<string, number>, first: Record<string, string> = {}): Promise<void> {
  try {
    await store.bumpVisit(today().day, visitorId(req), inc, first, expiry());
  } catch (err) {
    console.error("visit count failed:", (err as Error).message); // stats must never break the app
  }
}

/** "https://www.linkedin.com/feed/" → "linkedin.com"; our own host and junk → "". */
function refHost(ref: string, ownHost: string): string {
  try {
    const host = new URL(ref).hostname.replace(/^www\./, "").toLowerCase();
    if (!host || host === ownHost.replace(/^www\./, "").split(":")[0]) return "";
    return host.slice(0, 100);
  } catch {
    return "";
  }
}

const visitSchema = z.object({
  path: z.string().max(200).default("/"),
  ref: z.string().max(500).default(""),
});

/** Turn page paths into a few readable buckets. */
function pageKind(path: string): string {
  if (path.startsWith("/ideas/")) return "idea";
  if (path.startsWith("/history")) return "history";
  if (path.startsWith("/stats")) return "stats";
  return "home";
}

export function visitRouter(store: Store): Router {
  const r = Router();
  r.post(
    "/",
    ah(async (req, res) => {
      const parsed = visitSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(204).end();
      const kind = pageKind(parsed.data.path);
      if (kind === "stats") return res.status(204).end(); // the owner checking stats isn't a visit
      await countVisit(store, req, { views: 1, [`page_${kind}`]: 1 }, { ref: refHost(parsed.data.ref, req.get("host") ?? ""), firstPage: kind });
      res.status(204).end();
    }),
  );
  return r;
}

// ---------- owner-only stats ----------

function tokenOk(req: Request): boolean {
  const want = process.env.ADMIN_TOKEN?.trim() ?? "";
  const got = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (want.length < 16 || !got) return false;
  // Compare hashes so the comparison is constant-time and length-independent.
  const a = createHash("sha256").update(want).digest();
  const b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b);
}

const sum = (xs: VisitDay[], key: string) => xs.reduce((s, v) => s + (v.counts[key] ?? 0), 0);

export function adminRouter(store: Store): Router {
  const r = Router();
  r.use(
    rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many attempts. Wait 15 minutes." } }),
  );
  r.use((req, res, next) => {
    if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.trim().length < 16) return res.status(404).json({ error: "not found" });
    if (!tokenOk(req)) return res.status(401).json({ error: "Wrong admin token." });
    next();
  });

  r.get(
    "/stats",
    ah(async (req, res) => {
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
      const since = new Date(Date.now() - (days - 1) * 86_400_000);
      const sinceDay = since.toISOString().slice(0, 10);
      const [visits, ideas] = await Promise.all([store.visitsSince(sinceDay), store.ideasSince(`${sinceDay}T00:00:00.000Z`)]);
      const syntheses = await store.getSyntheses(ideas.slice(0, 50).map((i) => i.id));

      // One row per day, oldest first, including days with no visits.
      const byDay = new Map<string, VisitDay[]>();
      for (const v of visits) byDay.set(v.day, [...(byDay.get(v.day) ?? []), v]);
      const ideasByDay = new Map<string, typeof ideas>();
      for (const i of ideas) ideasByDay.set(i.createdAt.slice(0, 10), [...(ideasByDay.get(i.createdAt.slice(0, 10)) ?? []), i]);
      const daily = Array.from({ length: days }, (_, k) => {
        const day = new Date(since.getTime() + k * 86_400_000).toISOString().slice(0, 10);
        const vs = byDay.get(day) ?? [];
        const is = ideasByDay.get(day) ?? [];
        return {
          day,
          visitors: vs.length,
          views: sum(vs, "views"),
          runs: is.length,
          freeRuns: is.filter((i) => i.keyMode !== "own").length,
          ownKeyRuns: is.filter((i) => i.keyMode === "own").length,
          completed: is.filter((i) => i.status === "completed").length,
          failed: is.filter((i) => i.status === "failed").length,
          hitFreeLimit: vs.filter((v) => (v.counts.capHits ?? 0) > 0).length,
        };
      });

      const uniqueVisitors = new Set(visits.map((v) => v.visitor)).size;
      const runners = new Set(visits.filter((v) => (v.counts.runs ?? 0) > 0).map((v) => v.visitor)).size;
      const returning = (() => {
        const seen = new Map<string, number>();
        for (const v of visits) seen.set(v.visitor, (seen.get(v.visitor) ?? 0) + 1);
        return [...seen.values()].filter((n) => n > 1).length;
      })();
      const refs = new Map<string, Set<string>>();
      for (const v of visits) if (v.ref) refs.set(v.ref, (refs.get(v.ref) ?? new Set()).add(v.visitor));
      const verdicts = { build: 0, maybe: 0, dont_build: 0 };
      const allSynth = await store.getSyntheses(ideas.map((i) => i.id));
      for (const s of allSynth.values()) verdicts[s.overallVerdict]++;

      res.json({
        days,
        since: sinceDay,
        totals: {
          uniqueVisitors,
          returningVisitors: returning,
          pageViews: sum(visits, "views"),
          visitorsWhoRan: runners,
          runs: ideas.length,
          freeRuns: ideas.filter((i) => i.keyMode !== "own").length,
          ownKeyRuns: ideas.filter((i) => i.keyMode === "own").length,
          completed: ideas.filter((i) => i.status === "completed").length,
          failed: ideas.filter((i) => i.status === "failed").length,
          hitFreeLimit: visits.filter((v) => (v.counts.capHits ?? 0) > 0).length,
          verdicts,
        },
        pages: { home: sum(visits, "page_home"), idea: sum(visits, "page_idea"), history: sum(visits, "page_history") },
        referrers: [...refs].map(([host, set]) => ({ host, visitors: set.size })).sort((a, b) => b.visitors - a.visitors).slice(0, 15),
        direct: visits.filter((v) => !v.ref).length,
        daily,
        recentRuns: ideas.slice(0, 50).map((i) => {
          const s = syntheses.get(i.id);
          const { title, createdAt, status, keyMode, id, panelMode } = publicIdea(i);
          return { id, title, createdAt, status, keyMode: keyMode ?? "free", panelMode, verdict: s?.overallVerdict ?? null, score: s?.overallScore ?? null };
        }),
      });
    }),
  );
  return r;
}
