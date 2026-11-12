/**
 * Sign-in end to end against fake Google and GitHub servers (real HTTP, real JWT signatures),
 * plus email codes, sessions, the CSRF guard, and private runs that follow the account.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

process.env.MOCK = "1";
process.env.MOCK_LATENCY_MS = "0";
process.env.SIM_RUNS_PER_DAY = "1000";
process.env.DRAFTS_PER_DAY = "1000";
process.env.API_REQUESTS_PER_MINUTE = "100000";
process.env.TRUST_PROXY = "1"; // tests stand in for different visitors with X-Forwarded-For
process.env.GOOGLE_CLIENT_ID = "google-client";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
process.env.GITHUB_CLIENT_ID = "github-client";
process.env.GITHUB_CLIENT_SECRET = "github-secret";
delete process.env.RESEND_API_KEY;
delete process.env.PUBLIC_URL;

let fake: http.Server;
let app: http.Server;
let base = "";
let fakeBase = "";
let sentCodes: { email: string; code: string }[];
let signGoogle: (claims: Record<string, unknown>) => Promise<string>;
/** What the fake Google puts in its next ID token. */
let nextGoogle: Record<string, unknown> = {};

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  signGoogle = (claims) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://fake-google").setAudience("google-client").setIssuedAt().setExpirationTime("5m").sign(privateKey);

  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const json = (x: unknown, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(x)));
      const form = new URLSearchParams(body);
      if (req.url === "/g/jwks") return json({ keys: [jwk] });
      if (req.url === "/g/token") {
        if (form.get("client_secret") !== "google-secret" || !form.get("code_verifier")) return json({ error: "invalid_client" }, 401);
        return json({ id_token: await signGoogle(nextGoogle) });
      }
      if (req.url === "/gh/token") {
        if (form.get("client_secret") !== "github-secret" || form.get("code") !== "gh-code" || !form.get("code_verifier")) return json({ error: "bad_verification_code" });
        return json({ access_token: "gho_test" });
      }
      if (req.url === "/gh/api/user") return json({ id: 4242, login: "utsav-dev", name: "Utsav" });
      if (req.url === "/gh/api/user/emails") return json([{ email: "utsav@example.com", primary: true, verified: true }]);
      json({ error: "not found" }, 404);
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    GOOGLE_TOKEN_URL: `${fakeBase}/g/token`,
    GOOGLE_JWKS_URL: `${fakeBase}/g/jwks`,
    GOOGLE_ISSUER: "https://fake-google",
    GITHUB_TOKEN_URL: `${fakeBase}/gh/token`,
    GITHUB_API_URL: `${fakeBase}/gh/api`,
  });

  const { createApp } = await import("../app.js");
  const { MemoryStore } = await import("../store/memoryStore.js");
  sentCodes = (await import("./email.js")).sentCodes;
  app = createApp(new MemoryStore()).listen(0, "127.0.0.1");
  await new Promise((r) => app.once("listening", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(() => {
  app?.close();
  fake?.close();
});

const brief = { title: "Secret plan", description: "Something only I should see for now.", targetAudience: "", pricingModel: "", competitors: "", sliders: { reach: 5, buildCost: 5, userImportance: 5, complexity: 5, value: 5, risk: 5 } };

const sid = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("bon_sid="))?.split(";")[0] ?? null;
const call = (path: string, o: { method?: string; body?: unknown; cookie?: string | null; headers?: Record<string, string> } = {}) =>
  fetch(base + path, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    redirect: "manual",
    headers: { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
const me = async (cookie: string | null) => (await (await call("/api/auth/me", { cookie })).json()).user;

let visitor = 0;
async function emailSignIn(email: string): Promise<string> {
  // Each sign-in from its own address: the per-visitor code limit is tested separately.
  const ip = `203.0.113.${++visitor}`;
  expect((await call("/api/auth/email/start", { body: { email }, headers: { "x-forwarded-for": ip } })).status).toBe(200);
  const { code } = sentCodes.filter((c) => c.email === email).at(-1)!;
  const res = await call("/api/auth/email/verify", { body: { email, code } });
  expect(res.status).toBe(200);
  return sid(res)!;
}

async function waitDone(id: string, cookie: string | null) {
  for (let i = 0; i < 300; i++) {
    const s = await (await call(`/api/ideas/${id}`, { cookie })).json();
    if (s.idea?.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("run did not finish");
}

describe("who's signed in", () => {
  it("anonymous by default, and lists only the sign-in options that are set up", async () => {
    const res = await (await call("/api/auth/me")).json();
    expect(res.user).toBeNull();
    expect(res.providers).toEqual({ google: true, github: true, email: true });
  });
});

describe("email code", () => {
  it("signs in with the right code, once; the cookie is httpOnly and SameSite", async () => {
    const email = "first@example.com";
    await call("/api/auth/email/start", { body: { email } });
    const { code } = sentCodes.at(-1)!;
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await call("/api/auth/email/verify", { body: { email, code: code === "000000" ? "111111" : "000000" } });
    expect(wrong.status).toBe(400);
    const ok = await call("/api/auth/email/verify", { body: { email, code } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.getSetCookie().find((c) => c.startsWith("bon_sid="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect((await me(sid(ok))).email).toBe(email);
    // The same code can't be used twice.
    expect((await call("/api/auth/email/verify", { body: { email, code } })).status).toBe(400);
  });

  it("locks the code after 5 wrong tries", async () => {
    const email = "guesser@example.com";
    await call("/api/auth/email/start", { body: { email } });
    const { code } = sentCodes.at(-1)!;
    const bad = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) expect((await call("/api/auth/email/verify", { body: { email, code: bad } })).status).toBe(400);
    expect((await call("/api/auth/email/verify", { body: { email, code } })).status).toBe(429);
  });

  it("limits how many codes one address can ask for", async () => {
    const email = "spam-target@example.com";
    for (let i = 0; i < 5; i++) expect((await call("/api/auth/email/start", { body: { email } })).status).toBe(200);
    expect((await call("/api/auth/email/start", { body: { email } })).status).toBe(429);
  });
});

describe("GitHub sign-in (OAuth with PKCE)", () => {
  it("redirects out with state and a PKCE challenge, and back in with a session", async () => {
    const start = await call("/api/auth/github/start?returnTo=/history");
    expect(start.status).toBe(302);
    const out = new URL(start.headers.get("location")!);
    expect(out.origin + out.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(out.searchParams.get("code_challenge_method")).toBe("S256");
    const state = out.searchParams.get("state")!;
    const back = await call(`/api/auth/github/callback?code=gh-code&state=${state}`);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/history?signed_in=1");
    const user = await me(sid(back));
    expect(user.email).toBe("utsav@example.com");
    expect(user.providers).toEqual(["github"]);
    // A state works once only.
    const again = await call(`/api/auth/github/callback?code=gh-code&state=${state}`);
    expect(again.headers.get("location")).toMatch(/signin_error=expired/);
  });

  it("never sends people to another site after signing in", async () => {
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      const start = await call(`/api/auth/github/start?returnTo=${encodeURIComponent(bad)}`);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const back = await call(`/api/auth/github/callback?code=gh-code&state=${state}`);
      expect(back.headers.get("location")).toBe("/?signed_in=1");
    }
  });

  it("a made-up state is refused", async () => {
    const back = await call(`/api/auth/github/callback?code=gh-code&state=forged`);
    expect(back.headers.get("location")).toMatch(/signin_error=expired/);
    expect(sid(back)).toBeNull();
  });
});

describe("Google sign-in (OpenID Connect)", () => {
  async function googleRound(claims: (nonce: string) => Record<string, unknown>) {
    const start = await call("/api/auth/google/start");
    const out = new URL(start.headers.get("location")!);
    nextGoogle = claims(out.searchParams.get("nonce")!);
    return call(`/api/auth/google/callback?code=g-code&state=${out.searchParams.get("state")}`);
  }

  it("verifies the signed ID token and links to the same verified email", async () => {
    const back = await googleRound((nonce) => ({ sub: "g-1", email: "utsav@example.com", email_verified: true, name: "Utsav", nonce }));
    expect(back.headers.get("location")).toBe("/?signed_in=1");
    const user = await me(sid(back));
    // Same verified email as the GitHub sign-in above: one account, two ways in.
    expect(user.providers.sort()).toEqual(["github", "google"]);
  });

  it("refuses a token whose nonce doesn't match (replayed token)", async () => {
    const back = await googleRound(() => ({ sub: "g-2", email: "x@example.com", email_verified: true, nonce: "someone-elses" }));
    expect(back.headers.get("location")).toMatch(/signin_error=failed/);
    expect(sid(back)).toBeNull();
  });

  it("an unverified email never joins an existing account", async () => {
    const back = await googleRound((nonce) => ({ sub: "g-3", email: "utsav@example.com", email_verified: false, nonce }));
    const user = await me(sid(back));
    expect(user.providers).toEqual(["google"]);
    expect(user.email).toBe("");
  });
});

describe("sessions", () => {
  it("logout ends the session on the server, not just in the browser", async () => {
    const cookie = await emailSignIn("leaver@example.com");
    expect(await me(cookie)).not.toBeNull();
    await call("/api/auth/logout", { method: "POST", cookie });
    expect(await me(cookie)).toBeNull();
  });

  it("refuses signed-in writes from another site (CSRF)", async () => {
    const cookie = await emailSignIn("csrf@example.com");
    const res = await call("/api/auth/logout", { method: "POST", cookie, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(await me(cookie)).not.toBeNull();
  });
});

describe("runs on an account", () => {
  it("a private run opens on any device signed in to the account, and for nobody else", async () => {
    const laptop = await emailSignIn("owner@example.com");
    const res = await call("/api/ideas", { body: { ...brief, hidden: true }, cookie: laptop });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    await waitDone(id, laptop);

    // "Phone": a fresh sign-in to the same account, no owner token anywhere.
    const phone = await emailSignIn("owner@example.com");
    const onPhone = await call(`/api/ideas/${id}`, { cookie: phone });
    expect(onPhone.status).toBe(200);
    expect((await onPhone.json()).idea.yours).toBe(true);
    const mine = await (await call("/api/ideas/mine", { body: { owned: [] }, cookie: phone })).json();
    expect(mine.map((x: { idea: { id: string } }) => x.idea.id)).toContain(id);

    // Anyone else: as if it didn't exist.
    expect((await call(`/api/ideas/${id}`)).status).toBe(404);
    const stranger = await emailSignIn("stranger@example.com");
    expect((await call(`/api/ideas/${id}`, { cookie: stranger })).status).toBe(404);
    expect((await call(`/api/ideas/${id}`, { method: "DELETE", cookie: stranger })).status).toBe(404);
    const list = await (await call("/api/ideas")).json();
    expect(list.some((x: { idea: { id: string } }) => x.idea.id === id)).toBe(false);
    // The account id is never sent to browsers.
    expect(JSON.stringify(await (await call(`/api/ideas/${id}`, { cookie: phone })).json())).not.toMatch(/userId/);

    // The owner can delete it from the other device.
    expect((await call(`/api/ideas/${id}`, { method: "DELETE", cookie: phone })).status).toBe(204);
  });

  it("runs made before signing in can be claimed with their owner tokens", async () => {
    const res = await call("/api/ideas", { body: { ...brief, title: "Made anonymously" } });
    const { id, ownerToken } = await res.json();
    await waitDone(id, null);
    const cookie = await emailSignIn("claimer@example.com");
    const wrong = await (await call("/api/auth/claim", { body: { owned: [{ id, token: "not-it" }] }, cookie })).json();
    expect(wrong.claimed).toBe(0);
    const ok = await (await call("/api/auth/claim", { body: { owned: [{ id, token: ownerToken }] }, cookie })).json();
    expect(ok.claimed).toBe(1);
    const other = await emailSignIn("claimer@example.com");
    const mine = await (await call("/api/ideas/mine", { body: { owned: [] }, cookie: other })).json();
    expect(mine.map((x: { idea: { id: string } }) => x.idea.id)).toContain(id);
  });
});
