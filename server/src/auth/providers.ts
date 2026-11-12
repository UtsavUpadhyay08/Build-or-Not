/**
 * "Sign in with Google / GitHub": the OAuth 2.0 authorization-code flow, done by hand so
 * every step is visible.
 *
 *   1. /start      make a one-time `state` (+ PKCE verifier, + OIDC nonce), store it, redirect to the provider
 *   2. provider    the person signs in there and is sent back with ?code=…&state=…
 *   3. /callback   take the state (once), swap the code for tokens server-to-server, verify who it is
 *
 * Google returns a signed ID token: its signature (against Google's published keys),
 * issuer, audience, expiry and our nonce are all checked with `jose`. GitHub isn't OpenID Connect,
 * so we ask its API for the user and their verified primary email.
 *
 * Each provider switches on only when its keys are set. Endpoints can be overridden by env for
 * tests (a fake provider), never needed in normal use.
 */
import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthProvider, SignInProfile } from "./authStore.js";

export type OAuthProviderName = Exclude<AuthProvider, "email">;

const env = (k: string) => process.env[k]?.trim() || "";
const endpoint = (k: string, dflt: string) => env(k) || dflt;

export function configuredProviders(): Record<AuthProvider, boolean> {
  return {
    google: !!(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET")),
    github: !!(env("GITHUB_CLIENT_ID") && env("GITHUB_CLIENT_SECRET")),
    email: !!env("RESEND_API_KEY") || process.env.NODE_ENV !== "production",
  };
}

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Where to send the person to sign in. */
export function authorizeUrl(p: OAuthProviderName, o: { redirectUri: string; state: string; verifier: string; nonce: string }): string {
  if (p === "google") {
    const u = new URL(endpoint("GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth"));
    u.search = new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      redirect_uri: o.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: o.state,
      nonce: o.nonce,
      code_challenge: pkceChallenge(o.verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return u.toString();
  }
  const u = new URL(endpoint("GITHUB_AUTH_URL", "https://github.com/login/oauth/authorize"));
  u.search = new URLSearchParams({
    client_id: env("GITHUB_CLIENT_ID"),
    redirect_uri: o.redirectUri,
    scope: "read:user user:email",
    state: o.state,
    code_challenge: pkceChallenge(o.verifier),
    code_challenge_method: "S256",
    allow_signup: "true",
  }).toString();
  return u.toString();
}

async function postForm(url: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.error) throw new Error(`token exchange failed (${res.status}${data.error ? `: ${String(data.error)}` : ""})`);
  return data;
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function keysAt(url: string) {
  if (!jwks.has(url)) jwks.set(url, createRemoteJWKSet(new URL(url)));
  return jwks.get(url)!;
}

/** Verify an OpenID Connect ID token: signature, issuer, audience, expiry, and our nonce. */
async function verifyIdToken(token: string, o: { jwksUrl: string; issuer: string | string[]; audience: string; nonce: string }): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, keysAt(o.jwksUrl), { issuer: o.issuer, audience: o.audience });
  if (payload.nonce !== o.nonce) throw new Error("nonce mismatch");
  return payload;
}

const truthy = (v: unknown) => v === true || v === "true";

/** Swap the code for tokens and work out who signed in. Throws on anything unexpected. */
export async function finishSignIn(
  p: OAuthProviderName,
  o: { code: string; redirectUri: string; verifier: string; nonce: string },
): Promise<SignInProfile> {
  if (p === "google") {
    const tok = await postForm(endpoint("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"), {
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      code: o.code,
      code_verifier: o.verifier,
      grant_type: "authorization_code",
      redirect_uri: o.redirectUri,
    });
    const c = await verifyIdToken(String(tok.id_token ?? ""), {
      jwksUrl: endpoint("GOOGLE_JWKS_URL", "https://www.googleapis.com/oauth2/v3/certs"),
      issuer: env("GOOGLE_ISSUER") ? [env("GOOGLE_ISSUER")] : ["https://accounts.google.com", "accounts.google.com"],
      audience: env("GOOGLE_CLIENT_ID"),
      nonce: o.nonce,
    });
    return { provider: "google", subject: String(c.sub), email: String(c.email ?? ""), emailVerified: truthy(c.email_verified), name: String(c.name ?? "") };
  }

  if (p === "github") {
    const tok = await postForm(endpoint("GITHUB_TOKEN_URL", "https://github.com/login/oauth/access_token"), {
      client_id: env("GITHUB_CLIENT_ID"),
      client_secret: env("GITHUB_CLIENT_SECRET"),
      code: o.code,
      code_verifier: o.verifier,
      redirect_uri: o.redirectUri,
    });
    const api = endpoint("GITHUB_API_URL", "https://api.github.com");
    const headers = { authorization: `Bearer ${String(tok.access_token ?? "")}`, accept: "application/vnd.github+json", "user-agent": "build-or-not" };
    const [uRes, eRes] = await Promise.all([fetch(`${api}/user`, { headers, signal: AbortSignal.timeout(10_000) }), fetch(`${api}/user/emails`, { headers, signal: AbortSignal.timeout(10_000) })]);
    if (!uRes.ok) throw new Error(`GitHub user lookup failed (${uRes.status})`);
    const u = (await uRes.json()) as { id: number; login: string; name?: string | null };
    const emails = eRes.ok ? ((await eRes.json()) as { email: string; primary: boolean; verified: boolean }[]) : [];
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    return { provider: "github", subject: String(u.id), email: primary?.email ?? "", emailVerified: !!primary, name: u.name || u.login };
  }
  throw new Error(`unknown provider ${String(p)}`);
}
