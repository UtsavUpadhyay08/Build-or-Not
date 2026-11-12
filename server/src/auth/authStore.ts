/**
 * Accounts, sessions and the short-lived records sign-in needs.
 *
 *   users        { _id, email, name, identities: [{ provider, subject }], createdAt }
 *   sessions     { _id: sha256(session token), userId, expiresAt }          TTL on expiresAt
 *   oauth_states { _id: state, provider, verifier, nonce, returnTo, expiresAt } TTL, taken once
 *   email_codes  { _id: email, codeHash, attempts, expiresAt }               TTL
 *
 * Only hashes of session tokens and email codes are stored: a database leak doesn't hand out
 * logins. OAuth state lives on the server (not in a cookie), so it can be used exactly once.
 */
import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";

export type AuthProvider = "google" | "github" | "email";

export interface Identity {
  provider: AuthProvider;
  /** The provider's stable id for the person (Google "sub", GitHub user id, or the email). */
  subject: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  identities: Identity[];
  createdAt: string;
}

/** What a provider tells us about the person who just signed in. */
export interface SignInProfile extends Identity {
  email: string;
  /** Only verified emails link to an existing account, so nobody can claim someone else's by typing it. */
  emailVerified: boolean;
  name: string;
}

export interface OAuthState {
  provider: AuthProvider;
  verifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: Date;
}

export interface EmailCode {
  codeHash: string;
  attempts: number;
  expiresAt: Date;
}

export interface AuthStore {
  /** Find the account for this sign-in, link it to one with the same verified email, or create one. */
  signIn(profile: SignInProfile): Promise<User>;
  getUser(id: string): Promise<User | null>;

  createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  getSession(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null>;
  deleteSession(tokenHash: string): Promise<void>;

  saveOAuthState(state: string, data: OAuthState): Promise<void>;
  /** Returns and deletes it in one step, so a state can only ever be used once. */
  takeOAuthState(state: string): Promise<OAuthState | null>;

  saveEmailCode(email: string, code: EmailCode): Promise<void>;
  getEmailCode(email: string): Promise<EmailCode | null>;
  bumpEmailCodeAttempts(email: string): Promise<void>;
  deleteEmailCode(email: string): Promise<void>;
}

const normEmail = (e: string) => e.trim().toLowerCase();

function decide(existing: User | null, byEmail: User | null, p: SignInProfile): { user: User; isNew: boolean } {
  // An unverified email is never stored, so it can't later be used to link into someone's account.
  const email = p.emailVerified ? normEmail(p.email) : "";
  if (existing) {
    // Same login again: keep the name/email fresh (a provider may only send them the first time).
    return { user: { ...existing, email: existing.email || email, name: existing.name || p.name }, isNew: false };
  }
  if (byEmail && email) {
    return { user: { ...byEmail, identities: [...byEmail.identities, { provider: p.provider, subject: p.subject }], name: byEmail.name || p.name }, isNew: false };
  }
  return {
    user: { id: randomUUID(), email, name: p.name || email.split("@")[0] || "You", identities: [{ provider: p.provider, subject: p.subject }], createdAt: new Date().toISOString() },
    isNew: true,
  };
}

export class MemoryAuthStore implements AuthStore {
  users = new Map<string, User>();
  sessions = new Map<string, { userId: string; expiresAt: Date }>();
  states = new Map<string, OAuthState>();
  codes = new Map<string, EmailCode>();

  async signIn(p: SignInProfile) {
    const all = [...this.users.values()];
    const existing = all.find((u) => u.identities.some((i) => i.provider === p.provider && i.subject === p.subject)) ?? null;
    const byEmail = p.email && p.emailVerified ? (all.find((u) => u.email === normEmail(p.email)) ?? null) : null;
    const { user } = decide(existing, byEmail, p);
    this.users.set(user.id, structuredClone(user));
    return user;
  }
  async getUser(id: string) {
    return this.users.get(id) ?? null;
  }
  async createSession(h: string, userId: string, expiresAt: Date) {
    this.sessions.set(h, { userId, expiresAt });
  }
  async getSession(h: string) {
    return this.sessions.get(h) ?? null;
  }
  async deleteSession(h: string) {
    this.sessions.delete(h);
  }
  async saveOAuthState(s: string, d: OAuthState) {
    this.states.set(s, d);
  }
  async takeOAuthState(s: string) {
    const d = this.states.get(s) ?? null;
    this.states.delete(s);
    return d;
  }
  async saveEmailCode(e: string, c: EmailCode) {
    this.codes.set(normEmail(e), { ...c });
  }
  async getEmailCode(e: string) {
    return this.codes.get(normEmail(e)) ?? null;
  }
  async bumpEmailCodeAttempts(e: string) {
    const c = this.codes.get(normEmail(e));
    if (c) c.attempts++;
  }
  async deleteEmailCode(e: string) {
    this.codes.delete(normEmail(e));
  }
}

type UserDoc = Omit<User, "id"> & { _id: string };

export class MongoAuthStore implements AuthStore {
  private users: Collection<UserDoc>;
  private sessions: Collection<{ _id: string; userId: string; expiresAt: Date }>;
  private states: Collection<OAuthState & { _id: string }>;
  private codes: Collection<EmailCode & { _id: string }>;

  constructor(db: Db) {
    this.users = db.collection("users");
    this.sessions = db.collection("sessions");
    this.states = db.collection("oauth_states");
    this.codes = db.collection("email_codes");
  }

  async ensureIndexes() {
    await Promise.all([
      this.users.createIndex({ "identities.provider": 1, "identities.subject": 1 }),
      this.users.createIndex({ email: 1 }),
      this.sessions.createIndex({ userId: 1 }),
      // Expired sessions, sign-in states and codes delete themselves.
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined),
      this.states.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined),
      this.codes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined),
    ]);
  }

  async signIn(p: SignInProfile) {
    const existing = await this.users.findOne({ identities: { $elemMatch: { provider: p.provider, subject: p.subject } } });
    const byEmail = p.email && p.emailVerified ? await this.users.findOne({ email: normEmail(p.email) }) : null;
    const { user } = decide(existing && fromDoc(existing), byEmail && fromDoc(byEmail), p);
    const { id, ...rest } = user;
    await this.users.replaceOne({ _id: id }, rest, { upsert: true });
    return user;
  }
  async getUser(id: string) {
    const d = await this.users.findOne({ _id: id });
    return d ? fromDoc(d) : null;
  }
  async createSession(h: string, userId: string, expiresAt: Date) {
    await this.sessions.insertOne({ _id: h, userId, expiresAt });
  }
  async getSession(h: string) {
    const d = await this.sessions.findOne({ _id: h });
    return d ? { userId: d.userId, expiresAt: d.expiresAt } : null;
  }
  async deleteSession(h: string) {
    await this.sessions.deleteOne({ _id: h });
  }
  async saveOAuthState(s: string, d: OAuthState) {
    await this.states.insertOne({ _id: s, ...d });
  }
  async takeOAuthState(s: string) {
    const d = await this.states.findOneAndDelete({ _id: s });
    if (!d) return null;
    const { _id, ...rest } = d;
    return rest;
  }
  async saveEmailCode(e: string, c: EmailCode) {
    await this.codes.replaceOne({ _id: normEmail(e) }, c, { upsert: true });
  }
  async getEmailCode(e: string) {
    const d = await this.codes.findOne({ _id: normEmail(e) });
    if (!d) return null;
    const { _id, ...rest } = d;
    return rest;
  }
  async bumpEmailCodeAttempts(e: string) {
    await this.codes.updateOne({ _id: normEmail(e) }, { $inc: { attempts: 1 } });
  }
  async deleteEmailCode(e: string) {
    await this.codes.deleteOne({ _id: normEmail(e) });
  }
}

function fromDoc({ _id, ...rest }: UserDoc): User {
  return { id: _id, ...rest };
}
