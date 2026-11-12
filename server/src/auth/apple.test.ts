/**
 * Sign in with Apple is deliberately not offered (it needs the paid Apple Developer Program).
 * This guards that it stays off: even with Apple-looking keys in the environment, nothing shows
 * and its routes lead nowhere.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.MOCK = "1";
process.env.API_REQUESTS_PER_MINUTE = "100000";
process.env.APPLE_CLIENT_ID = "com.example.web";
process.env.APPLE_TEAM_ID = "TEAM123456";

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

describe("Sign in with Apple is not offered", () => {
  it("isn't listed, and its routes don't sign anyone in", async () => {
    const me = await (await fetch(`${base}/api/auth/me`)).json();
    expect(Object.keys(me.providers).sort()).toEqual(["email", "github", "google"]);
    const start = await fetch(`${base}/api/auth/apple/start`, { redirect: "manual" });
    expect(start.headers.get("location")).toBe("/?signin_error=unavailable");
    const back = await fetch(`${base}/api/auth/apple/callback`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "code=x&state=y",
    });
    expect(back.headers.getSetCookie().some((c) => c.startsWith("bon_sid="))).toBe(false);
  });
});
