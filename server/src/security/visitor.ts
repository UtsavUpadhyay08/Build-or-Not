/**
 * Per-visitor daily limits. A visitor is their IP address, hashed with a server secret so raw IPs
 * are never stored. Counts live in MongoDB (Store.takeQuota), so a restart or the host putting the
 * app to sleep doesn't hand out fresh runs.
 */
import { createHmac } from "node:crypto";
import type { Request } from "express";
import { clientIp } from "./clientIp.js";
import { config, MOCK_MODE } from "../config.js";
import type { Store } from "../store/store.js";

let warned = false;
export function visitorId(req: Request): string {
  if (!config.ipHashSecret && !warned && process.env.NODE_ENV === "production") {
    warned = true;
    console.warn("IP_HASH_SECRET is not set: visitor IPs are hashed with a built-in secret. Set a long random value on the host.");
  }
  const ip = clientIp(req);
  return createHmac("sha256", config.ipHashSecret || "build-or-not/visitor").update(ip).digest("base64url").slice(0, 32);
}

export type QuotaKind = "free" | "sim" | "own" | "draft";

export function today() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10); // UTC day
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { day, resetsAt };
}

/** Which limit a run on the site's own key counts against: real free tier, or simulated models. */
export const freeKind = (): QuotaKind => (MOCK_MODE ? "sim" : "free");

export function limitFor(kind: QuotaKind): number {
  return kind === "free" ? config.limits.freeRunsPerDay : kind === "sim" ? config.limits.simRunsPerDay : kind === "draft" ? config.limits.draftsPerDay : config.limits.ownRunsPerDay;
}

export function quotaBucket(kind: QuotaKind, req: Request) {
  const { day, resetsAt } = today();
  return { bucket: `${kind}:${day}:${visitorId(req)}`, expiresAt: resetsAt, resetsAt };
}

/** Take one run. Returns a release function (call it if the run then fails to start), or null when the limit is reached. */
export async function takeRun(store: Store, req: Request, kind: QuotaKind): Promise<(() => Promise<void>) | null> {
  const { bucket, expiresAt } = quotaBucket(kind, req);
  const n = await store.takeQuota(bucket, limitFor(kind), expiresAt);
  if (n === null) return null;
  return () => store.returnQuota(bucket);
}

export interface QuotaStatus {
  /** Runs on the site's own key: "free" (real models) or "sim" (no key on the server: simulated models). */
  site: { kind: "free" | "sim"; limit: number; used: number; left: number };
  own: { allowed: boolean; limit: number; used: number; left: number };
  resetsAt: string;
}

export async function quotaStatus(store: Store, req: Request): Promise<QuotaStatus> {
  const kind = freeKind() as "free" | "sim";
  const [siteUsed, ownUsed] = await Promise.all([store.quotaUsed(quotaBucket(kind, req).bucket), store.quotaUsed(quotaBucket("own", req).bucket)]);
  const siteLimit = limitFor(kind);
  const ownLimit = limitFor("own");
  return {
    site: { kind, limit: siteLimit, used: siteUsed, left: Math.max(0, siteLimit - siteUsed) },
    own: { allowed: config.allowOwnKeys, limit: ownLimit, used: ownUsed, left: Math.max(0, ownLimit - ownUsed) },
    resetsAt: today().resetsAt.toISOString(),
  };
}
