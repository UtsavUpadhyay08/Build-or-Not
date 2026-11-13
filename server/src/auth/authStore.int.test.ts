/**
 * Accounts against a real MongoDB. Skipped unless MONGODB_TEST_URI is set, e.g. (PowerShell)
 *   $env:MONGODB_TEST_URI="mongodb://127.0.0.1:27017/build-or-not-test"; npm test
 * Uses its own database name: it drops it first, so never point it at your real data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { MongoStore } from "../store/mongoStore.js";

const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)("accounts in MongoDB (integration)", () => {
  let store: MongoStore;

  beforeAll(async () => {
    const c = new MongoClient(uri!);
    await c.connect();
    await c.db().dropDatabase();
    await c.close();
    store = await MongoStore.connect(uri!);
  });
  afterAll(async () => store?.close());

  it("creates an account, finds it again, and links a second sign-in with the same verified email", async () => {
    const a = await store.auth.signIn({ provider: "email", subject: "u@example.com", email: "U@Example.com", emailVerified: true, name: "" });
    expect(a.email).toBe("u@example.com");
    const again = await store.auth.signIn({ provider: "email", subject: "u@example.com", email: "u@example.com", emailVerified: true, name: "" });
    expect(again.id).toBe(a.id);
    const viaGithub = await store.auth.signIn({ provider: "github", subject: "42", email: "u@example.com", emailVerified: true, name: "U" });
    expect(viaGithub.id).toBe(a.id);
    expect((await store.auth.getUser(a.id))?.identities.map((i) => i.provider).sort()).toEqual(["email", "github"]);
    // Unverified email: a separate account, never linked.
    const other = await store.auth.signIn({ provider: "google", subject: "g-9", email: "u@example.com", emailVerified: false, name: "" });
    expect(other.id).not.toBe(a.id);
  });

  it("sessions, one-time sign-in states and email codes", async () => {
    const u = await store.auth.signIn({ provider: "email", subject: "s@example.com", email: "s@example.com", emailVerified: true, name: "" });
    const exp = new Date(Date.now() + 60_000);
    await store.auth.createSession("hash1", u.id, exp);
    expect((await store.auth.getSession("hash1"))?.userId).toBe(u.id);
    await store.auth.deleteSession("hash1");
    expect(await store.auth.getSession("hash1")).toBeNull();

    await store.auth.saveOAuthState("st", { provider: "github", verifier: "v", nonce: "n", returnTo: "/", expiresAt: exp });
    expect((await store.auth.takeOAuthState("st"))?.verifier).toBe("v");
    expect(await store.auth.takeOAuthState("st")).toBeNull(); // used once only

    await store.auth.saveEmailCode("S@Example.com", { codeHash: "h", attempts: 0, expiresAt: exp });
    await store.auth.bumpEmailCodeAttempts("s@example.com");
    expect((await store.auth.getEmailCode("s@example.com"))?.attempts).toBe(1);
    await store.auth.deleteEmailCode("s@example.com");
    expect(await store.auth.getEmailCode("s@example.com")).toBeNull();
  });

  it("runs belong to accounts", async () => {
    const base = {
      createdAt: new Date().toISOString(), status: "completed" as const, mock: true, panelMode: "single" as const, personaLibraryVersion: "1", error: null,
      title: "t", description: "d", targetAudience: "", pricingModel: "", competitors: "", sliders: { reach: 1, buildCost: 1, userImportance: 1, complexity: 1, value: 1, risk: 1 },
    };
    await store.insertIdea({ ...base, id: "acct-1", userId: "user-x", hidden: true });
    await store.insertIdea({ ...base, id: "anon-1" });
    await store.setIdeaOwner("anon-1", "user-x");
    await store.setIdeaOwner("acct-1", "someone-else"); // already owned: unchanged
    expect((await store.listIdeasByUser("user-x")).map((i) => i.id).sort()).toEqual(["acct-1", "anon-1"]);
  });
});
