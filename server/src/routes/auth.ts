/**
 * /api/auth: sign in, sign out, who am I.
 *
 *   GET  /me                       { user | null, providers: which sign-in options are switched on }
 *   GET  /:provider/start          redirect to Google / GitHub
 *   GET  /:provider/callback       and back here
 *   POST /email/start  {email}     send a 6-digit code
 *   POST /email/verify {email, code}
 *   POST /logout
 *   POST /claim {owned}            attach this browser's earlier runs to the account
 *
 * Every failure on the way back from a provider sends the person to /?signin_error=<reason> with
 * a plain message; the details only go to the server log.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store/store.js";
import { authorizeUrl, configuredProviders, finishSignIn, type OAuthProviderName } from "../auth/providers.js";
import { currentUser, endSession, publicOrigin, randomToken, sha256, startSession } from "../auth/session.js";
import { devEmail, sendSignInCode } from "../auth/email.js";
import { visitorId } from "../security/visitor.js";
import type { User } from "../auth/authStore.js";

const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

const OAUTH: OAuthProviderName[] = ["google", "github"];
const STATE_MINUTES = 10;
const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;

/** Only send people back to a page on this site ("/ideas/123"), never to another site. */
export function safeReturnTo(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") && s.length < 300 ? s : "/";
}

/** What the browser is told about the signed-in person. */
export function publicUser(u: User | null) {
  return u ? { id: u.id, email: u.email, name: u.name, providers: [...new Set(u.identities.map((i) => i.provider))] } : null;
}

const codeHash = (email: string, code: string) => sha256(`${email.toLowerCase()}|${code}|${process.env.IP_HASH_SECRET ?? "bon"}`);

export function authRouter(store: Store) {
  const r = Router();

  r.get(
    "/me",
    ah(async (req, res) => {
      // `dev`: running locally without production settings (the sign-in screen explains what's missing).
      res.json({ user: publicUser(await currentUser(store, req)), providers: configuredProviders(), dev: process.env.NODE_ENV !== "production" });
    }),
  );

  r.get(
    "/:provider/start",
    ah(async (req, res) => {
      const p = req.params.provider as OAuthProviderName;
      if (!OAUTH.includes(p) || !configuredProviders()[p]) return res.redirect(302, `/?signin_error=unavailable`);
      const state = randomToken();
      const verifier = randomToken(48);
      const nonce = randomToken();
      await store.auth.saveOAuthState(state, { provider: p, verifier, nonce, returnTo: safeReturnTo(req.query.returnTo), expiresAt: new Date(Date.now() + STATE_MINUTES * 60_000) });
      res.redirect(302, authorizeUrl(p, { redirectUri: `${publicOrigin(req)}/api/auth/${p}/callback`, state, verifier, nonce }));
    }),
  );

  const callback = ah(async (req, res) => {
    const p = req.params.provider as OAuthProviderName;
    const q = req.query as Record<string, unknown>;
    const back = (reason: string, returnTo = "/") => res.redirect(303, `${returnTo}${returnTo.includes("?") ? "&" : "?"}signin_error=${reason}`);
    if (!OAUTH.includes(p)) return back("unavailable");
    if (typeof q.error === "string") return back(q.error === "access_denied" ? "cancelled" : "failed");
    const state = typeof q.state === "string" ? await store.auth.takeOAuthState(q.state) : null;
    if (!state || state.provider !== p || state.expiresAt.getTime() < Date.now()) return back("expired");
    if (typeof q.code !== "string" || !q.code) return back("failed", state.returnTo);
    try {
      const profile = await finishSignIn(p, {
        code: q.code,
        redirectUri: `${publicOrigin(req)}/api/auth/${p}/callback`,
        verifier: state.verifier,
        nonce: state.nonce,
      });
      const user = await store.auth.signIn(profile);
      await startSession(store, req, res, user.id);
      const to = state.returnTo;
      res.redirect(303, `${to}${to.includes("?") ? "&" : "?"}signed_in=1`);
    } catch (err) {
      console.warn(`[auth] ${p} sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
      back("failed", state.returnTo);
    }
  });
  r.get("/:provider/callback", callback);

  const emailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
  r.post(
    "/email/start",
    ah(async (req, res) => {
      const parsed = emailSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "That doesn’t look like an email address." });
      if (!configuredProviders().email) return res.status(503).json({ error: "Email sign-in isn’t set up on this site yet." });
      const { email } = parsed.data;
      // Limits: a handful of codes per address and per visitor each hour, so this can't be used to spam.
      const hour = new Date().toISOString().slice(0, 13);
      const expires = new Date(Date.now() + 3600_000);
      const perEmail = await store.takeQuota(`emailcode:${hour}:${sha256(email)}`, 5, expires);
      const perVisitor = perEmail === null ? null : await store.takeQuota(`emailcode-ip:${hour}:${visitorId(req)}`, 10, expires);
      if (perEmail === null || perVisitor === null) return res.status(429).json({ error: "Too many codes asked for. Wait a while and try again." });
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      await store.auth.saveEmailCode(email, { codeHash: codeHash(email, code), attempts: 0, expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) });
      try {
        await sendSignInCode(email, code);
      } catch (err) {
        console.warn(`[auth] couldn't send sign-in email: ${err instanceof Error ? err.message : String(err)}`);
        return res.status(502).json({ error: "Couldn’t send the email just now. Try again in a minute." });
      }
      // Same answer whether or not an account exists: nobody can probe which emails are registered.
      // On your own machine without an email service, the code comes back here so you can sign in
      // (never in production: there it's emailed or email sign-in is off).
      res.json({ ok: true, minutes: CODE_MINUTES, ...(devEmail() ? { devCode: code } : {}) });
    }),
  );

  const verifySchema = emailSchema.extend({ code: z.string().trim().regex(/^\d{6}$/) });
  r.post(
    "/email/verify",
    ah(async (req, res) => {
      const parsed = verifySchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Enter the 6-digit code from the email." });
      const { email, code } = parsed.data;
      const rec = await store.auth.getEmailCode(email);
      if (!rec || rec.expiresAt.getTime() < Date.now()) return res.status(400).json({ error: "That code has expired. Ask for a new one." });
      if (rec.attempts >= CODE_ATTEMPTS) {
        await store.auth.deleteEmailCode(email);
        return res.status(429).json({ error: "Too many wrong tries. Ask for a new code." });
      }
      const a = Buffer.from(rec.codeHash);
      const b = Buffer.from(codeHash(email, code));
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        await store.auth.bumpEmailCodeAttempts(email);
        return res.status(400).json({ error: "That code isn’t right. Check the email and try again." });
      }
      await store.auth.deleteEmailCode(email); // one use only
      const user = await store.auth.signIn({ provider: "email", subject: email, email, emailVerified: true, name: "" });
      await startSession(store, req, res, user.id);
      res.json({ user: publicUser(user) });
    }),
  );

  r.post(
    "/logout",
    ah(async (req, res) => {
      await endSession(store, req, res);
      res.json({ ok: true });
    }),
  );

  /** Runs made in this browser before signing in become the account's (only with their owner tokens). */
  const claimSchema = z.object({ owned: z.array(z.object({ id: z.string().max(64), token: z.string().max(200) })).max(200) });
  r.post(
    "/claim",
    ah(async (req, res) => {
      const user = await currentUser(store, req);
      if (!user) return res.status(401).json({ error: "Sign in first." });
      const parsed = claimSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Bad request." });
      let claimed = 0;
      for (const { id, token } of parsed.data.owned) {
        const idea = await store.getIdea(id);
        if (!idea || idea.userId || !idea.ownerHash) continue;
        const x = Buffer.from(idea.ownerHash);
        const y = Buffer.from(sha256(token));
        if (x.length === y.length && timingSafeEqual(x, y)) {
          await store.setIdeaOwner(id, user.id);
          claimed++;
        }
      }
      res.json({ claimed });
    }),
  );

  return r;
}
