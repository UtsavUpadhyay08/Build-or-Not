/**
 * Who's signed in, the sign-in dialog, and the account button.
 *
 * The session is an httpOnly cookie the page can't read: this module only ever asks the server
 * (/api/auth/me). Google and GitHub sign-in leave the page and come back, so anything the
 * page wants to keep (the half-filled form) is saved first through `beforeLeave` hooks.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ownedTokens } from "./api";

export type Provider = "google" | "github" | "email";
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  providers: Provider[];
}

interface SignInRequest {
  /** One line on why we're asking (shown at the top of the dialog). */
  reason?: string;
  /** Runs after an in-page sign-in (email code). Google/GitHub reload the page instead. */
  onDone?: () => void;
}

interface AuthState {
  user: AuthUser | null;
  ready: boolean;
  providers: Record<Provider, boolean>;
  openSignIn: (r?: SignInRequest) => void;
  signOut: () => Promise<void>;
  /** Save page state before leaving for Google/GitHub. Returns an unregister function. */
  beforeLeave: (fn: () => void) => () => void;
}

const NONE: Record<Provider, boolean> = { google: false, github: false, email: false };
const Ctx = createContext<AuthState>({ user: null, ready: false, providers: NONE, openSignIn: () => undefined, signOut: async () => undefined, beforeLeave: () => () => undefined });
export const useAuth = () => useContext(Ctx);

async function post(path: string, body?: unknown) {
  const res = await fetch(`/api/auth${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

const ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  expired: "That sign-in took too long or was already used. Try again.",
  unavailable: "That sign-in option isn’t set up on this site.",
  failed: "Sign-in didn’t work this time. Try again, or use another option.",
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [providers, setProviders] = useState(NONE);
  const [dialog, setDialog] = useState<(SignInRequest & { error?: string }) | null>(null);
  const leaveHooks = useRef(new Set<() => void>());
  const location = useLocation();
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me").then((r) => r.json());
      setUser(res.user ?? null);
      setProviders({ ...NONE, ...res.providers });
      return (res.user ?? null) as AuthUser | null;
    } catch {
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  /** Runs made in this browser before signing in move onto the account. */
  const claim = useCallback(async () => {
    const owned = ownedTokens();
    if (owned.length) await post("/claim", { owned }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Back from Google/GitHub: ?signed_in=1 or ?signin_error=… on the page we left from.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const ok = q.get("signed_in");
    const err = q.get("signin_error");
    if (!ok && !err) return;
    q.delete("signed_in");
    q.delete("signin_error");
    navigate({ pathname: location.pathname, search: q.toString() ? `?${q}` : "" }, { replace: true });
    if (ok) void claim().then(refresh);
    if (err) setDialog({ error: ERRORS[err] ?? ERRORS.failed });
  }, [location.search, location.pathname, navigate, claim, refresh]);

  const value: AuthState = {
    user,
    ready,
    providers,
    openSignIn: (r) => setDialog(r ?? {}),
    signOut: async () => {
      await post("/logout").catch(() => undefined);
      setUser(null);
    },
    beforeLeave: (fn) => {
      leaveHooks.current.add(fn);
      return () => leaveHooks.current.delete(fn);
    },
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {dialog && (
        <SignInDialog
          reason={dialog.reason}
          initialError={dialog.error}
          providers={providers}
          onClose={() => setDialog(null)}
          onLeave={() => leaveHooks.current.forEach((fn) => fn())}
          onSignedIn={async () => {
            await claim();
            await refresh();
            const done = dialog.onDone;
            setDialog(null);
            done?.();
          }}
        />
      )}
    </Ctx.Provider>
  );
}

const LABEL: Record<Exclude<Provider, "email">, string> = { google: "Continue with Google", github: "Continue with GitHub" };

function ProviderIcon({ p }: { p: Exclude<Provider, "email"> }) {
  if (p === "google")
    return (
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 48 48">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
    );
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.6.3 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.5 11.5 0 0 0 23.5 12C23.5 5.7 18.3.5 12 .5z" />
    </svg>
  );
}

function SignInDialog({ reason, initialError, providers, onClose, onLeave, onSignedIn }: { reason?: string; initialError?: string; providers: Record<Provider, boolean>; onClose: () => void; onLeave: () => void; onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"pick" | "code">("pick");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const box = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const oauth = (["google", "github"] as const).filter((p) => providers[p]);
  const returnTo = window.location.pathname + window.location.search;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("a, button, input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => (document.removeEventListener("keydown", onKey), prev?.focus());
  }, [busy, onClose]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await post("/email/start", { email });
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await post("/email/verify", { email, code });
      await onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const nothing = !oauth.length && !providers.email;

  return (
    <div className="draft-backdrop game-vars" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={box} className="draft-dialog signin" role="dialog" aria-modal="true" aria-labelledby="signin-h">
        <button type="button" className="draft-x" onClick={onClose} disabled={busy} aria-label="Close">
          ×
        </button>
        <div className="eyebrow">ACCOUNT</div>
        <h2 id="signin-h">{step === "code" ? "Check your email" : "Sign in"}</h2>
        <p className="draft-sub">{step === "code" ? `We sent a 6-digit code to ${email}. It works for 10 minutes.` : reason ?? "Keep runs private and see all your runs on any device."}</p>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        {nothing && <p className="blocked-note">Sign-in isn’t set up on this site yet.</p>}

        {step === "pick" && (
          <>
            {oauth.length > 0 && (
              <div className="signin-providers">
                {oauth.map((p) => (
                  <a key={p} className={`signin-btn signin-${p}`} href={`/api/auth/${p}/start?returnTo=${encodeURIComponent(returnTo)}`} onClick={onLeave}>
                    <ProviderIcon p={p} />
                    <span>{LABEL[p]}</span>
                  </a>
                ))}
              </div>
            )}
            {oauth.length > 0 && providers.email && <div className="signin-or">or</div>}
            {providers.email && (
              <form className="signin-email" onSubmit={sendCode}>
                <label className="field-label">
                  Email
                  <input className="field" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" disabled={busy} />
                </label>
                <button type="submit" className="gbtn gbtn-sm" disabled={busy || !email.includes("@")}>
                  {busy ? "Sending…" : "Email me a code"}
                </button>
              </form>
            )}
          </>
        )}

        {step === "code" && (
          <form className="signin-email" onSubmit={verify}>
            <label className="field-label">
              6-digit code
              <input
                ref={codeRef}
                className="field signin-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                disabled={busy}
              />
            </label>
            <button type="submit" className="gbtn gbtn-sm" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Sign in"}
            </button>
            <button type="button" className="signin-link" onClick={() => (setStep("pick"), setCode(""), setError(null))} disabled={busy}>
              Use a different email
            </button>
          </form>
        )}

        <p className="signin-fine">We only use your email to sign you in. No passwords are stored.</p>
      </div>
    </div>
  );
}

/** Header button: "Sign in", or the account's initial with a small menu. */
export function AccountButton() {
  const { user, ready, openSignIn, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => (document.removeEventListener("mousedown", close), document.removeEventListener("keydown", close));
  }, [open]);

  if (!ready) return null;
  if (!user)
    return (
      <button type="button" className="account-signin" onClick={() => openSignIn()}>
        Sign in
      </button>
    );
  const label = user.name || user.email || "Your account";
  return (
    <div className="account" ref={ref}>
      <button type="button" className="account-chip" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true" className="account-avatar">
          {label.trim()[0]?.toUpperCase() ?? "?"}
        </span>
        <span className="account-name">{label}</span>
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-menu-who">
            <strong>{user.name || "Signed in"}</strong>
            {user.email && <span>{user.email}</span>}
          </div>
          <Link role="menuitem" to="/history?mine=1" onClick={() => setOpen(false)}>
            My runs
          </Link>
          <button role="menuitem" type="button" onClick={() => (setOpen(false), void signOut())}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
