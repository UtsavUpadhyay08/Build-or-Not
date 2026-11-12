import type { ImprovePlan, ApiMeta, Capacity, IdeaBrief, IdeaFullState, IdeaRecord, PanelMode, Quota, SendPlan, Synthesis } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  getMeta: () => request<ApiMeta>("/meta"),
  listIdeas: () => request<{ idea: IdeaRecord; synthesis: Synthesis | null }[]>("/ideas"),
  /** Sends this browser's owner token when it has one, so private runs open for their owner. */
  getIdea: (id: string) => {
    const t = ownerTokenFor(id);
    return request<IdeaFullState>(`/ideas/${id}`, t ? { headers: { "Content-Type": "application/json", "x-owner-token": t } } : undefined);
  },
  /** This browser's own ideas, private ones included (proved with the owner tokens it holds). */
  listMine: () => {
    // Always asked, even with no tokens here: a signed-in account's runs come from the server.
    const all = Object.entries(owned()).map(([id, token]) => ({ id, token }));
    return request<{ idea: IdeaRecord; synthesis: Synthesis | null }[]>("/ideas/mine", { method: "POST", body: JSON.stringify({ owned: all.slice(-200) }) });
  },
  submitIdea: (brief: IdeaBrief & { panelMode?: PanelMode; providers?: string[]; keyMode?: "free" | "own"; ownKeys?: { provider: string; apiKey: string; model?: string }[] }) =>
    request<{ id: string; mock: boolean; totalPersonas: number; sendPlan: SendPlan; ownerToken: string; quota: Quota }>("/ideas", { method: "POST", body: JSON.stringify(brief) }),
  getQuota: () => request<Quota>("/ideas/quota"),
  /** "Fill it in with AI": a sentence or two in, a complete brief out. */
  draftIdea: (body: { idea: string; keyMode: "free" | "own"; ownKeys?: { provider: string; apiKey: string; model?: string }[]; kind?: "startup" | "feature"; productContext?: string }) =>
    request<{ brief: IdeaBrief; model: string; simulated: boolean }>("/ideas/draft", { method: "POST", body: JSON.stringify(body) }),
  improveIdea: (id: string, body: { keyMode: "free" | "own"; ownKeys?: { provider: string; apiKey: string; model?: string }[] }) => {
    const t = ownerTokenFor(id);
    return request<{ plan: ImprovePlan; model: string; simulated: boolean }>(`/ideas/${id}/improve`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(t ? { "x-owner-token": t } : {}) },
    });
  },
  /** Owner-only numbers, unlocked with ADMIN_TOKEN. */
  getStats: (token: string, days = 30) => request<SiteStats>(`/admin/stats?days=${days}`, { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } }),
  /** Check a visitor's own key and measure its limits. The server keeps nothing. */
  checkKey: (provider: string, apiKey: string, model?: string) =>
    request<{ ok: true; provider: string; model: string; capacity: Capacity }>("/keys/check", { method: "POST", body: JSON.stringify({ provider, apiKey, model: model || undefined }) }),
  /** Only works with the token handed out when this browser submitted the idea. */
  /** The owner token if this browser has one; a signed-in owner can delete without it. */
  deleteIdea: (id: string, ownerToken?: string | null) =>
    request<void>(`/ideas/${id}`, { method: "DELETE", headers: { "Content-Type": "application/json", ...(ownerToken ? { "x-owner-token": ownerToken } : {}) } }),

  /** SSE progress stream for one idea's run. Returns an unsubscribe function. */
  streamIdea(
    id: string,
    handlers: { onSnapshot: (data: any) => void; onProgress: (data: any) => void; onOpenError?: () => void },
  ): () => void {
    // EventSource reconnects by itself after a drop; every (re)connect starts with a full snapshot.
    // EventSource can't send headers, so a private run's owner token goes in the query string.
    const t = ownerTokenFor(id);
    const source = new EventSource(`/api/ideas/${id}/stream${t ? `?t=${encodeURIComponent(t)}` : ""}`);
    source.addEventListener("snapshot", (ev) => {
      handlers.onSnapshot(JSON.parse((ev as MessageEvent).data));
    });
    source.addEventListener("progress", (ev) => {
      handlers.onProgress(JSON.parse((ev as MessageEvent).data));
    });
    source.onerror = () => {
      handlers.onOpenError?.();
    };
    return () => source.close();
  },
};

// ---------- ideas this browser submitted (their delete tokens) ----------

const OWNED = "bon.owned.v1";
function owned(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(OWNED) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
export function rememberOwned(id: string, token: string) {
  try {
    localStorage.setItem(OWNED, JSON.stringify({ ...owned(), [id]: token }));
  } catch {
    /* storage blocked: the idea just can't be deleted from this browser later */
  }
}
/** Every run this browser submitted, with its owner token (to claim them for an account). */
export function ownedTokens(): { id: string; token: string }[] {
  return Object.entries(owned()).map(([id, token]) => ({ id, token }));
}

export function ownerTokenFor(id: string): string | null {
  return owned()[id] ?? null;
}
export function forgetOwned(id: string) {
  const all = owned();
  delete all[id];
  try {
    localStorage.setItem(OWNED, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/**
 * Tell the server a page was opened: which kind of page, and which site the visitor came from
 * (the server keeps only that site's name). Fire-and-forget; never blocks or breaks the page.
 */
export function recordVisit(path: string) {
  try {
    void fetch("/api/visit", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ref: document.referrer || "" }),
    }).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

export interface SiteStats {
  days: number;
  since: string;
  totals: {
    uniqueVisitors: number;
    returningVisitors: number;
    pageViews: number;
    visitorsWhoRan: number;
    runs: number;
    freeRuns: number;
    ownKeyRuns: number;
    completed: number;
    failed: number;
    hitFreeLimit: number;
    verdicts: { build: number; maybe: number; dont_build: number };
  };
  pages: { home: number; idea: number; history: number };
  referrers: { host: string; visitors: number }[];
  direct: number;
  daily: { day: string; visitors: number; views: number; runs: number; freeRuns: number; ownKeyRuns: number; completed: number; failed: number; hitFreeLimit: number }[];
  recentRuns: { id: string; title: string; createdAt: string; status: string; keyMode: string; panelMode?: string; verdict: string | null; score: number | null }[];
}
