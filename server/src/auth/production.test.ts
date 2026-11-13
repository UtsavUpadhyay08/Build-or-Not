/** In production the email code is never handed back to the page: it's emailed, or email sign-in is off. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.MOCK = "1";
process.env.NODE_ENV = "production";
process.env.API_REQUESTS_PER_MINUTE = "100000";
delete process.env.RESEND_API_KEY;

let app: http.Server;
let base = "";
beforeAll(async () => {
  const { createApp } = await import("../app.js");
  const { MemoryStore } = await import("../store/memoryStore.js");
  app = createApp(new MemoryStore()).listen(0, "127.0.0.1");
  await new Promise((r) => app.once("listening", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => app?.close());

describe("email sign-in in production", () => {
  it("is switched off without an email service, and never returns a code", async () => {
    const me = await (await fetch(`${base}/api/auth/me`)).json();
    expect(me.providers.email).toBe(false);
    expect(me.dev).toBe(false);
    const res = await fetch(`${base}/api/auth/email/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }) });
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/devCode|\d{6}/);
  });
});
