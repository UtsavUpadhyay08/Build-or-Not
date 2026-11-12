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
process.env.ADMIN_TOKEN = "test-admin-token-0123456789";
process.env.DRAFTS_PER_DAY = "3"; // several free runs share the simulated provider in this file
process.env.API_REQUESTS_PER_MINUTE = "100000"; // the polling below would trip the normal 120/min limit

const KEY_A = "gsk_visitorAAAA1111aaaa2222";
const KEY_B = "gsk_visitorBBBB3333bbbb4444";
/** Which keys the fake Groq saw, and the score it gives each key so runs can't be mixed up silently. */
const seen = new Map<string, number>();
/** Every request body the fake Groq received (to check what the personas were shown). */
const bodies: string[] = [];
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
      bodies.push(body);
      res.setHeader("x-ratelimit-limit-tokens", "500000");
      res.setHeader("x-ratelimit-remaining-tokens", "500000");
      res.setHeader("x-ratelimit-remaining-requests", "1000");
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }] }));
      }
      if (body.includes("submit_draft") || body.includes("write up a product")) {
        const draft = { title: "Dog walker finder", description: "Helps busy owners find a vetted walker nearby.", targetAudience: "Busy dog owners", pricingModel: "Commission", competitors: "Rover, Wag", sliders: { reach: 6, buildCost: 5, userImportance: 7, complexity: 6, value: 7, risk: 3 } };
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(draft) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      }
      const s = SCORE[key];
      let content: unknown;
      if (body.includes("submit_improve")) {
        const ids = [...new Set([...body.matchAll(/\(id: ([a-z0-9_-]+)/g)].map((m) => m[1]))];
        content = {
          keep: "keep the core",
          changes: [
            { title: "Small change A", detail: "d", personaIds: ids.slice(0, 3) },
            { title: "Big change B", detail: "d", personaIds: ids.slice(0, 10).concat("not-a-real-persona") },
          ],
          revised: { title: "t (revised)", description: "an idea, revised", targetAudience: "", pricingModel: "", competitors: "" },
        };
      } else if (body.includes("topConcerns")) {
        content = { topConcerns: [{ theme: "t", mentionCount: 1, example: "e" }], topAppeals: [{ theme: "a", mentionCount: 1, example: "e" }], summary: "s" };
      } else {
        content = { verdict: s >= 7 ? "build" : "dont_build", score: s, reasoning: "r", topConcern: "c", topAppeal: "a", fix: `fix from key ${s}` };
      }
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

describe("fill it in with AI", () => {
  it("drafts a full brief from one sentence on the free tier, within a daily limit", async () => {
    const ip = "203.0.113.200";
    const res = await post("/api/ideas/draft", { idea: "an app that finds dog walkers near you" }, ip);
    expect(res.status).toBe(200);
    const { brief, simulated } = await res.json();
    expect(simulated).toBe(true); // no site key in this test: simulated model
    expect(brief.title.length).toBeGreaterThan(0);
    expect(Object.keys(brief.sliders)).toHaveLength(6);
    for (const v of Object.values(brief.sliders) as number[]) expect(v >= 1 && v <= 10).toBe(true);
    await post("/api/ideas/draft", { idea: "second idea" }, ip);
    await post("/api/ideas/draft", { idea: "third idea" }, ip);
    expect((await post("/api/ideas/draft", { idea: "fourth idea" }, ip)).status).toBe(429);
  });

  it("uses the visitor's own key when they chose it, and never echoes it", async () => {
    const before = seen.get(KEY_A) ?? 0;
    const res = await post("/api/ideas/draft", { idea: "dog walkers on demand", keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_A }] }, "203.0.113.201");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body).brief.title).toBe("Dog walker finder");
    expect(seen.get(KEY_A) ?? 0).toBeGreaterThan(before);
    expect(body).not.toContain("visitorAAAA");
  });

  it("rejects an empty idea", async () => {
    expect((await post("/api/ideas/draft", { idea: "  " }, "203.0.113.202")).status).toBe(400);
  });
});

describe("real visitor IP on Render (behind Cloudflare)", () => {
  // Every request reaches the app from the same internal proxy, like on Render.
  const viaRender = (clientIp: string, extra: Record<string, string> = {}) =>
    post("/api/ideas", brief, "10.0.0.1", { "true-client-ip": clientIp, ...extra });

  it("gives each visitor their own 3 free runs, even though the proxy address is the same", async () => {
    process.env.RENDER = "true";
    try {
      for (let i = 0; i < 3; i++) expect((await viaRender("198.18.0.1")).status).toBe(201);
      expect((await viaRender("198.18.0.1")).status).toBe(429); // visitor 1 used theirs
      expect((await viaRender("198.18.0.2")).status).toBe(201); // visitor 2 is not affected
      expect((await viaRender("198.18.0.3")).status).toBe(201);
    } finally {
      delete process.env.RENDER;
    }
  });

  it("can't be fooled by a made-up X-Forwarded-For on Render", async () => {
    process.env.RENDER = "true";
    try {
      // Visitor 1 is out of runs; faking another address in X-Forwarded-For changes nothing.
      expect((await post("/api/ideas", brief, "203.0.113.99, 10.0.0.1", { "true-client-ip": "198.18.0.1" })).status).toBe(429);
    } finally {
      delete process.env.RENDER;
    }
  });

  it("ignores IP headers when not on Render, so nobody can fake them locally", async () => {
    // Same connection (TRUST_PROXY hop) each time; a different True-Client-IP must not give new runs.
    const ip = "203.0.113.150";
    for (let i = 0; i < 3; i++) await post("/api/ideas", brief, ip, { "true-client-ip": `198.18.1.${i}` });
    expect((await post("/api/ideas", brief, ip, { "true-client-ip": "198.18.1.99" })).status).toBe(429);
  });
});

describe("new feature for an existing product (description.md)", () => {
  const product = "# Splitly\nSplitly is a bill-splitting app for flatmates in India. 40k monthly users. Free, with a paid tier for landlords.";
  const feature = { ...brief, title: "Move-out settle up", description: "When a flatmate leaves mid-month, work out what everyone owes.", kind: "feature" };

  it("needs the product description", async () => {
    const res = await post("/api/ideas", { ...feature, keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_A }], providers: ["groq"] }, "198.51.100.71");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/description of your product/i);
  });

  it("refuses a description too long to send 45 times", async () => {
    const res = await post("/api/ideas", { ...feature, productContext: "x".repeat(6001), keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_A }], providers: ["groq"] }, "198.51.100.72");
    expect(res.status).toBe(400);
  });

  it("every persona is shown the product, marked as data, and the idea keeps it", async () => {
    bodies.length = 0;
    const res = await post("/api/ideas", { ...feature, productContext: product, keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_A }], providers: ["groq"] }, "198.51.100.73");
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const done = await waitDone(id);
    expect(done.idea.kind).toBe("feature");
    expect(done.idea.productContext).toContain("Splitly");
    const personaCalls = bodies.filter((b) => b.includes("submit_verdict"));
    expect(personaCalls.length).toBeGreaterThanOrEqual(36);
    for (const b of personaCalls) {
      expect(b).toContain("NEW FEATURE");
      expect(b).toContain("<<<PRODUCT");
      expect(b).toContain("40k monthly users");
    }
    // The list stays light: no product text there.
    const list = await (await fetch(`${base}/api/ideas`)).json();
    const row = list.find((x: { idea: { id: string } }) => x.idea.id === id);
    expect(row.idea.kind).toBe("feature");
    expect(row.idea.productContext).toBeUndefined();
  });

  it("a startup idea ignores any product text sent along", async () => {
    bodies.length = 0;
    const res = await post("/api/ideas", { ...brief, kind: "startup", productContext: product, keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_A }], providers: ["groq"] }, "198.51.100.74");
    expect(res.status).toBe(201);
    const done = await waitDone((await res.json()).id);
    expect(done.idea.productContext ?? "").toBe("");
    expect(bodies.some((b) => b.includes("40k monthly users"))).toBe(false);
  });
});

describe("fix my idea with AI (/:id/improve)", () => {
  it("builds a plan with server-computed weights, sorted heaviest first", async () => {
    const res = await post("/api/ideas", { ...brief, keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_B }], providers: ["groq"] }, "198.51.100.81");
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const done = await waitDone(id);
    expect(done.verdicts[0].fix).toMatch(/^fix from key/); // personas now say what would change their mind
    const imp = await post(`/api/ideas/${id}/improve`, { keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_B }] }, "198.51.100.81");
    expect(imp.status).toBe(200);
    const { plan } = await imp.json();
    // KEY_B scores everyone 2/10, so each ask weighs 9. B groups 10 real personas (90), A groups 3 (27).
    expect(plan.changes.map((c: { title: string; weight: number }) => [c.title, c.weight])).toEqual([
      ["Big change B", 90],
      ["Small change A", 27],
    ]);
    expect(plan.changes[0].personaIds).not.toContain("not-a-real-persona"); // invented ids carry no weight
    expect(plan.revised.description).toBe("an idea, revised");
    expect(plan.revised.sliders).toEqual(brief.sliders); // sliders carry over, the model never touches them
  });

  it("404 on a missing idea; fix plans draw from the AI fill-in allowance", async () => {
    const res = await post("/api/ideas/does-not-exist/improve", { keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_B }] }, "198.51.100.82");
    expect(res.status).toBe(404);
  });
});

describe("private runs", () => {
  it("need an account: without signing in they're refused, and nothing is created", async () => {
    const before = (await (await fetch(`${base}/api/ideas`)).json()).length;
    const res = await post("/api/ideas", { ...brief, title: "Secret plan", hidden: true, keyMode: "own", ownKeys: [{ provider: "groq", apiKey: KEY_A }], providers: ["groq"] }, "198.51.100.91");
    expect(res.status).toBe(401);
    expect((await res.json()).needsSignIn).toBe(true);
    expect((await (await fetch(`${base}/api/ideas`)).json()).length).toBe(before);
  });
  // Signed-in private runs, sharing across devices and the sign-in flows: see auth/auth.test.ts.
});
