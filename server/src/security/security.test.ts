/**
 * Public-site guarantees, tested against the real app (MemoryStore, simulated models for the free
 * tier, and a fake Groq for visitors' own keys):
 *   - security headers on every response
 *   - 3 free runs per visitor IP per day, counted per IP
 *   - a visitor's own key is used for their run only: never for anyone else's, never stored, never shown
 *   - ideas are public to read, deletable only by whoever submitted them
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Limits and fakes must be in place before config is first imported.
process.env.SIM_RUNS_PER_DAY = "3";
process.env.OWN_RUNS_PER_DAY = "5";
process.env.KEY_CHECKS_PER_HOUR = "50";
process.env.TRUST_PROXY = "1";
process.env.MOCK_LATENCY_MS = "5";
process.env.PANEL_QUORUM = "0.8";
process.env.GROQ_BURST = "45"; // the fake Groq has no real limits; don't make the test wait on the documented 30/min
process.env.MOCK_RPM = "60000";
process.env.ADMIN_TOKEN = "test-admin-token-0123456789"; // several free runs share the simulated provider in this file
process.env.API_REQUESTS_PER_MINUTE = "100000"; // the polling below would trip the normal 120/min limit

const KEY_A = "gsk_visitorAAAA1111aaaa2222";
const KEY_B = "gsk_visitorBBBB3333bbbb4444";
/** Which keys the fake Groq saw, and the score it gives each key so runs can't be mixed up silently. */
const seen = new Map<string, number>();
const SCORE: Record<string, number> = { [KEY_A]: 9, [KEY_B]: 2 };

let fakeGroq: http.Server;
let app: http.Server;
let base = "";
let MemoryStoreRef: typeof import("../store/memoryStore.js").MemoryStore;
let store: InstanceType<typeof MemoryStoreRef>;

beforeAll(async () => {
  fakeGroq = http.createServer((req, res) => {
    const key = (req.headers.authorization ?? "").replace("Bearer ", "");
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!(key in SCORE)) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `Invalid API Key provided: ${key}` } }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("x-ratelimit-limit-tokens", "500000");
      res.setHeader("x-ratelimit-remaining-tokens", "500000");
      res.setHeader("x-ratelimit-remaining-requests", "1000");
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }] }));
      }
      const synth = body.includes("topConcerns");
      const s = SCORE[key];
      const content = synth
        ? { topConcerns: [{ theme: "t", mentionCount: 1, example: "e" }], topAppeals: [{ theme: "a", mentionCount: 1, example: "e" }], summary: "s" }
        : { verdict: s >= 7 ? "build" : "dont_build", score: s, reasoning: "r", topConcern: "c", topAppeal: "a" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: body.length < 200 ? "hi" : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => fakeGroq.listen(0, "127.0.0.1", r));
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${(fakeGroq.address() as AddressInfo).port}`;

  const { createApp } = await import("../app.js");
  MemoryStoreRef = (await import("../store/memoryStore.js")).MemoryStore;
  store = new MemoryStoreRef();
  app = createApp(store).listen(0, "127.0.0.1");
  await new Promise((r) => app.once("listening", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(() => {
  app?.close();
  fakeGroq?.close();
});

const brief = { title: "t", description: "an idea", targetAudience: "", pricingModel: "", competitors: "", sliders: { reach: 5, buildCost: 5, userImportance: 5, complexity: 5, value: 5, risk: 5 } };
const post = (path: string, body: unknown, ip: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, body: JSON.stringify(body) });

async function waitDone(id: string) {
  for (let i = 0; i < 200; i++) {
    const s = await (await fetch(`${base}/api/ideas/${id}`)).json();
    if (s.idea.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run did not finish");
}

describe("security headers", () => {
  it("sends CSP, HSTS, nosniff, no framing, no referrer, permissions policy; hides the framework", async () => {
    const res = await fetch(`${base}/api/health`);
    const h = res.headers;
    expect(h.get("content-security-policy")).toContain("default-src 'self'");
    expect(h.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(h.get("content-security-policy")).toContain("script-src 'self'");
    expect(h.get("strict-transport-security")).toContain("max-age=31536000");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("no-referrer");
    expect(h.get("permissions-policy")).toContain("camera=()");
    expect(h.get("x-powered-by")).toBeNull();
    expect(h.get("access-control-allow-origin")).toBeNull(); // no open CORS
  });

  it("never sends the site's key hints, even masked", async () => {
    const meta = await (await fetch(`${base}/api/meta`)).json();
    expect(JSON.stringify(meta)).not.toMatch(/keyHint/);
  });

  it("answers server errors without internals", async () => {
    const res = await fetch(`${base}/api/ideas`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).not.toMatch(/JSON|position|Unexpected/);
  });
});

describe("free tier: 3 runs per visitor IP per day", () => {
  it("allows 3, refuses the 4th, and counts each IP separately", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 3; i++) expect((await post("/api/ideas", brief, ip)).status).toBe(201);
    const fourth = await post("/api/ideas", brief, ip);
    expect(fourth.status).toBe(429);
    expect((await fourth.json()).quota.site.left).toBe(0);
    expect((await post("/api/ideas", brief, "203.0.113.11")).status).toBe(201); // another visitor is unaffected
    const q = await (await fetch(`${base}/api/ideas/quota`, { headers: { "x-forwarded-for": ip } })).json();
    expect(q.site).toMatchObject({ limit: 3, used: 3, left: 0 });
  });

  it("stores no raw IP: counters are keyed by a hash", async () => {
    const quotas = (store as unknown as { quotas: Map<string, unknown> }).quotas;
    const keys = [...quotas.keys()].join(" ");
    expect(keys).not.toContain("203.0.113");
  });
});

describe("own keys are private to their run", () => {
  it("checks a key without keeping it anywhere", async () => {
    const res = await post("/api/keys/check", { provider: "groq", apiKey: KEY_A }, "198.51.100.1");
    expect(res.status).toBe(200);
    const meta = await (await fetch(`${base}/api/meta`)).json();
    expect(meta.providers.map((p: { name: string }) => p.name)).not.toContain("groq"); // not added to the site's council
  });

  it("rejects a bad key without echoing it", async () => {
    const res = await post("/api/keys/check", { provider: "groq", apiKey: "gsk_wrongwrongwrong9999" }, "198.51.100.1");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("wrongwrongwrong");
  });

  it("two visitors running at once each get only their own key's answers", async () => {
    const [ra, rb] = await Promise.all([
      post("/api/ideas", { ...brief, keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_A }], providers: ["groq"] }, "198.51.100.1"),
      post("/api/ideas", { ...brief, keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_B }], providers: ["groq"] }, "198.51.100.2"),
    ]);
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    const [a, b] = await Promise.all([waitDone((await ra.json()).id), waitDone((await rb.json()).id)]);
    expect(a.idea.status).toBe("completed");
    expect(b.idea.status).toBe("completed");
    expect(a.verdicts.every((v: { score: number }) => v.score === 9)).toBe(true); // all from key A
    expect(b.verdicts.every((v: { score: number }) => v.score === 2)).toBe(true); // all from key B
    expect(a.idea.keyMode).toBe("own");
  });

  it("free-tier runs never use a visitor's key", async () => {
    const before = (seen.get(KEY_A) ?? 0) + (seen.get(KEY_B) ?? 0);
    const r = await post("/api/ideas", brief, "203.0.113.50");
    await waitDone((await r.json()).id);
    expect((seen.get(KEY_A) ?? 0) + (seen.get(KEY_B) ?? 0)).toBe(before);
  });

  it("no key is ever written to the database or returned by the API", async () => {
    const dump = JSON.stringify([...(store as unknown as { ideas: Map<string, unknown> }).ideas.values(), ...(store as unknown as { judgments: Map<string, unknown> }).judgments.values()]);
    expect(dump).not.toContain("visitorAAAA");
    expect(dump).not.toContain("visitorBBBB");
    const list = await (await fetch(`${base}/api/ideas`)).text();
    expect(list).not.toContain("visitorAAAA");
    expect(list).not.toContain("ownerHash");
  });
});

describe("ideas: public to read, deletable only by their submitter", () => {
  it("anyone can read; only the submitter's token deletes", async () => {
    const r = await post("/api/ideas", brief, "192.0.2.7");
    const { id, ownerToken } = await r.json();
    expect(ownerToken).toBeTruthy();
    await waitDone(id);
    expect((await fetch(`${base}/api/ideas/${id}`, { headers: { "x-forwarded-for": "192.0.2.99" } })).status).toBe(200); // someone else can read
    expect((await fetch(`${base}/api/ideas/${id}`, { method: "DELETE" })).status).toBe(403);
    expect((await fetch(`${base}/api/ideas/${id}`, { method: "DELETE", headers: { "x-owner-token": "guess" } })).status).toBe(403);
    expect((await fetch(`${base}/api/ideas/${id}`, { method: "DELETE", headers: { "x-owner-token": ownerToken } })).status).toBe(204);
  });
});

describe("redaction", async () => {
  const { redactSecrets } = await import("../llm/redact.js");
  it("hides anything key-shaped in stored text", () => {
    expect(redactSecrets("Incorrect API key provided: sk-proj-abc*********************xyz12")).not.toContain("sk-proj");
    expect(redactSecrets("Invalid API Key: gsk_abcdef123456")).toBe("Invalid API Key: [key hidden]");
    expect(redactSecrets("key AIzaSyA-1234567890abcdef rejected")).not.toContain("AIza");
    expect(redactSecrets("bad sk-or-v1-abcdef123456")).not.toContain("sk-or");
    expect(redactSecrets("token mysecretvalue123", ["mysecretvalue123"])).toBe("token [key hidden]");
  });
});

describe("visit stats: private to the owner, no personal data", () => {
  it("counts page loads with only the referring site's host", async () => {
    const send = (ip: string, ref: string, path = "/") => post("/api/visit", { path, ref }, ip);
    expect((await send("100.64.0.1", "https://www.linkedin.com/in/someone/details?x=secret")).status).toBe(204);
    await send("100.64.0.1", "", "/ideas/abc");
    await send("100.64.0.2", "https://github.com/me/build-or-not");
    const dump = JSON.stringify([...(store as unknown as { visits: Map<string, unknown> }).visits.values()]);
    expect(dump).toContain("linkedin.com");
    expect(dump).not.toContain("someone"); // no path or query from the referrer
    expect(dump).not.toContain("100.64.0"); // no raw IPs
  });

  it("stats need the admin token", async () => {
    expect((await fetch(`${base}/api/admin/stats`)).status).toBe(401);
    expect((await fetch(`${base}/api/admin/stats`, { headers: { authorization: "Bearer wrong-token-0000000000" } })).status).toBe(401);
    const res = await fetch(`${base}/api/admin/stats`, { headers: { authorization: "Bearer test-admin-token-0123456789" } });
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.totals.uniqueVisitors).toBeGreaterThanOrEqual(2);
    expect(s.referrers.map((r: { host: string }) => r.host)).toEqual(expect.arrayContaining(["linkedin.com", "github.com"]));
    expect(s.totals.runs).toBeGreaterThan(0);
    expect(s.totals.hitFreeLimit).toBeGreaterThanOrEqual(1); // the free-tier test above hit the cap
    expect(s.daily).toHaveLength(30);
    expect(JSON.stringify(s)).not.toContain("ownerHash");
  });
});
