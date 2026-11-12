/**
 * Sessions: a random 32-byte token in an httpOnly cookie. The server stores only its SHA-256,
 * so neither page scripts nor a leaked database can produce a working login.
 *
 *   HttpOnly           page scripts can't read it
 *   SameSite=Lax       not sent on cross-site POSTs (CSRF), still sent when a link brings you back
 *   Secure             over https (the deployed site); left off on http://localhost
 */
import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Store } from "../store/store.js";
import type { User } from "./authStore.js";

export const SESSION_COOKIE = "bon_sid";
const SESSION_DAYS = 30;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** The site's public address (for OAuth redirect URIs and the CSRF origin check). */
export function publicOrigin(req: Request): string {
  const env = process.env.PUBLIC_URL?.trim();
  if (env) return new URL(env).origin;
  return `${req.protocol}://${req.get("host")}`;
}

function secureCookies(req: Request): boolean {
  return publicOrigin(req).startsWith("https://");
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function cookieHeader(req: Request, value: string, maxAgeSec: number): string {
  return [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`, secureCookies(req) ? "Secure" : ""].filter(Boolean).join("; ");
}

export async function startSession(store: Store, req: Request, res: Response, userId: string): Promise<void> {
  // A fresh token on every sign-in (never reuse one from before signing in).
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await store.auth.createSession(sha256(token), userId, expiresAt);
  res.append("Set-Cookie", cookieHeader(req, token, SESSION_DAYS * 86400));
}

export async function endSession(store: Store, req: Request, res: Response): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await store.auth.deleteSession(sha256(token));
  res.append("Set-Cookie", cookieHeader(req, "", 0));
}

const CACHE = Symbol("bonUser");

/** The signed-in user for this request, or null. Looked up once per request. */
export async function currentUser(store: Store, req: Request): Promise<User | null> {
  const r = req as Request & { [CACHE]?: Promise<User | null> };
  if (!r[CACHE]) {
    r[CACHE] = (async () => {
      const token = readCookie(req, SESSION_COOKIE);
      if (!token || token.length > 200) return null;
      const s = await store.auth.getSession(sha256(token));
      if (!s || s.expiresAt.getTime() < Date.now()) return null;
      return store.auth.getUser(s.userId);
    })().catch(() => null);
  }
  return r[CACHE];
}

/**
 * CSRF guard for cookie-carrying requests that change something: a browser always sends Origin on
 * a cross-site POST, and it must be this site. (SameSite=Lax already keeps the cookie off most of
 * them; this closes the rest.)
 */
export function sameOriginWrites(allowed: string[] = []) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!readCookie(req, SESSION_COOKIE)) return next();
    const origin = req.get("origin");
    if (!origin) return next(); // not a browser cross-site request (browsers send Origin on POST)
    const ok = origin === publicOrigin(req) || allowed.includes(origin);
    if (!ok) return res.status(403).json({ error: "Request refused." });
    next();
  };
}
