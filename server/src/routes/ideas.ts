import { Router, type NextFunction, type Request, type Response } from "express";
import { currentUser } from "../auth/session.js";
import type { User } from "../auth/authStore.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ownKeySchema } from "./keys.js";
import { freeKind, limitFor, quotaStatus, takeRun } from "../security/visitor.js";
import { redactSecrets } from "../llm/redact.js";
import { countVisit } from "./stats.js";
import { z } from "zod";
import { config, MOCK_MODE } from "../config.js";
import { PERSONAS, PERSONA_LIBRARY_VERSION } from "../personas.js";
import type { Store } from "../store/store.js";
import { PRODUCT_CONTEXT_MAX, publicIdea, type IdeaFullState, type IdeaRecord } from "../types.js";
import { existingEmitter, type ProgressEvent } from "../panel/runPanel.js";
import { isRunning, prepareRun, startPanel } from "../panel/service.js";
import { hasUsableProvider, panelProviders, primaryProvider, privateCouncil, providerHealth, providerKey } from "../llm/registry.js";
import { callStructured } from "../llm/structured.js";
import { DRAFT_FEATURE_SYSTEM, DRAFT_SCHEMA, DRAFT_SYSTEM, draftZ } from "../panel/draft.js";
import { buildImproveUser, IMPROVE_SCHEMA, IMPROVE_SYSTEM, improveZ, settlePlan } from "../panel/improve.js";
import { PERSONA_BY_ID } from "../personas.js";

const slider = z.number().min(1).max(10);
const ideaBriefSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().min(1, "Description is required").max(4000),
  targetAudience: z.string().trim().max(1000).default(""),
  pricingModel: z.string().trim().max(1000).default(""),
  competitors: z.string().trim().max(1000).default(""),
  sliders: z.object({ reach: slider, buildCost: slider, userImportance: slider, complexity: slider, value: slider, risk: slider }),
  hidden: z.boolean().default(false),
  kind: z.enum(["startup", "feature"]).default("startup"),
  productContext: z.string().trim().max(PRODUCT_CONTEXT_MAX, `Keep the product description under ${PRODUCT_CONTEXT_MAX.toLocaleString("en")} characters: every persona reads it.`).default(""),
  panelMode: z.enum(["single", "mixed"]).optional(),
  /** Provider names for this run: one for "single", two or more for "mixed". Omit for defaults. */
  providers: z.array(z.string().trim().min(1)).max(10).optional(),
  /** "free": the site's key (capped per visitor per day). "own": the keys below, for this run only. */
  keyMode: z.enum(["free", "own"]).default("free"),
  ownKeys: z.array(ownKeySchema).max(6).optional(),
});

const draftRequestSchema = z.object({
  idea: z.string().trim().min(3, "Describe your idea in a sentence or two.").max(1000, "Keep it under 1,000 characters. AI fills in the rest."),
  kind: z.enum(["startup", "feature"]).default("startup"),
  productContext: z.string().trim().max(PRODUCT_CONTEXT_MAX).default(""),
  keyMode: z.enum(["free", "own"]).default("free"),
  ownKeys: z.array(ownKeySchema).max(6).optional(),
});

/** Express 4 doesn't catch rejected promises from async handlers — forward them to the error middleware. */
const ah = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function ideasRouter(store: Store): Router {
  const r = Router();

  /**
   * Public runs: anyone. Private runs: only their owner (account or owner token). To everyone else a
   * private run is "not found", exactly like one that doesn't exist.
   */
  const canSee = async (idea: IdeaRecord, req: Request) => !idea.hidden || isOwner(idea, req, await currentUser(store, req));

  /** How many runs this visitor has left today, on the site's key and with their own. */
  r.get(
    "/quota",
    ah(async (req, res) => {
      res.json(await quotaStatus(store, req));
    }),
  );

  /**
   * "Fill it in with AI": one sentence or two in, a complete brief out. Runs on the same key the
   * visitor would run the council with (the site's, or their own for this request only).
   */
  r.post(
    "/draft",
    ah(async (req, res) => {
      const parsed = draftRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Describe your idea first." });
      const { idea, keyMode, ownKeys = [], kind, productContext } = parsed.data;
      const feature = kind === "feature" && productContext.length >= 40;

      let provider;
      if (keyMode === "own") {
        if (!config.allowOwnKeys) return res.status(403).json({ error: "This site doesn’t allow your own key." });
        const built = await privateCouncil(ownKeys.slice(0, 1));
        if (!built.providers.length) return res.status(400).json({ error: built.problems[0]?.message ?? "Your key didn’t work." });
        provider = built.providers[0];
      } else {
        if (!MOCK_MODE && !hasUsableProvider()) return res.status(503).json({ error: "Free runs aren’t working right now. You can use your own key instead." });
        provider = primaryProvider();
      }
      const release = await takeRun(store, req, "draft");
      if (!release) return res.status(429).json({ error: `You’ve used your ${limitFor("draft")} AI fill-ins for today. Fill in the form yourself, or try again tomorrow.` });

      try {
        const { value } = await callStructured(
          provider,
          {
            system: feature ? DRAFT_FEATURE_SYSTEM : DRAFT_SYSTEM,
            user: feature ? `The product:\n<<<PRODUCT\n${productContext}\nPRODUCT>>>\n\nFeature idea: ${idea}` : `Idea: ${idea}`,
            schemaName: "submit_draft",
            schemaDescription: "Submit the complete idea brief.",
            schema: DRAFT_SCHEMA,
            maxTokens: 1200,
          },
          draftZ,
        );
        await countVisit(store, req, { drafts: 1 });
        res.json({ brief: value, model: `${provider.name === "mock" ? "simulated" : provider.name} · ${provider.model}`, simulated: provider.name === "mock" });
      } catch (err) {
        await release();
        const msg = redactSecrets(err instanceof Error ? err.message : String(err), ownKeys.map((k) => k.apiKey));
        res.status(502).json({ error: `AI couldn’t fill in the form this time (${msg.slice(0, 200)}). Try again, or fill it in yourself.` });
      }
    }),
  );

  /**
   * "Fix my idea with AI": after a run, one call groups every persona's ask into a few small
   * changes, weighted by how unhappy each asker was (11 - score; our arithmetic, not the model's),
   * and applies them to a revised brief. Shares the daily AI fill-in allowance with /draft.
   */
  const improveRequestSchema = z.object({ keyMode: z.enum(["free", "own"]).default("free"), ownKeys: z.array(ownKeySchema).max(6).optional() });
  r.post(
    "/:id/improve",
    ah(async (req, res) => {
      const parsed = improveRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Bad request." });
      const { keyMode, ownKeys = [] } = parsed.data;

      const idea = await store.getIdea(req.params.id);
      if (!idea || !(await canSee(idea, req))) return res.status(404).json({ error: "not found" });
      if (idea.status === "running") return res.status(409).json({ error: "The council is still voting. Ask again when the result is in." });
      const verdicts = await store.getVerdicts(idea.id);
      if (verdicts.length < 5) return res.status(409).json({ error: "Too few personas answered this run to build a fix plan from." });

      let provider;
      if (keyMode === "own") {
        if (!config.allowOwnKeys) return res.status(403).json({ error: "This site doesn’t allow your own key." });
        const built = await privateCouncil(ownKeys.slice(0, 1));
        if (!built.providers.length) return res.status(400).json({ error: built.problems[0]?.message ?? "Your key didn’t work." });
        provider = built.providers[0];
      } else {
        if (!MOCK_MODE && !hasUsableProvider()) return res.status(503).json({ error: "Free runs aren’t working right now. You can use your own key instead." });
        provider = primaryProvider();
      }
      const release = await takeRun(store, req, "draft");
      if (!release) return res.status(429).json({ error: `You’ve used your ${limitFor("draft")} AI fill-ins for today (fix plans share that allowance). Try again tomorrow.` });

      try {
        const { value } = await callStructured(
          provider,
          {
            system: IMPROVE_SYSTEM,
            user: buildImproveUser(idea, verdicts, PERSONA_BY_ID),
            schemaName: "submit_improve",
            schemaDescription: "Submit the grouped changes and the revised brief.",
            schema: IMPROVE_SCHEMA,
            maxTokens: 1600,
          },
          improveZ,
        );
        await countVisit(store, req, { drafts: 1 });
        const plan = settlePlan(value, verdicts, idea);
        res.json({ plan, model: `${provider.name === "mock" ? "simulated" : provider.name} · ${provider.model}`, simulated: provider.name === "mock" });
      } catch (err) {
        await release();
        const msg = redactSecrets(err instanceof Error ? err.message : String(err), ownKeys.map((k) => k.apiKey));
        res.status(502).json({ error: `AI couldn’t build the fix plan this time (${msg.slice(0, 200)}). Try again in a minute.` });
      }
    }),
  );

  r.post(
    "/",
    ah(async (req, res) => {
      const parsed = ideaBriefSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Please add a title and a description.", issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) });
      const { panelMode = config.panelMode, providers = [], keyMode, ownKeys = [], ...brief } = parsed.data;
      const user = await currentUser(store, req);
      if (brief.hidden && !user) return res.status(401).json({ error: "Sign in to keep a run private.", needsSignIn: true });
      if (brief.kind === "feature" && brief.productContext.length < 40) {
        return res.status(400).json({ error: "For a new feature, add a short description of your product (upload its description.md or paste a few lines)." });
      }
      if (brief.kind !== "feature") brief.productContext = "";
      if (panelMode === "mixed" && providers.length === 1) return res.status(400).json({ error: "To mix models, pick at least 2." });

      let ownProviders: Awaited<ReturnType<typeof privateCouncil>>["providers"] | undefined;
      let release: (() => Promise<void>) | null;

      if (keyMode === "own") {
        if (!config.allowOwnKeys) return res.status(403).json({ error: "This site doesn’t allow your own key." });
        if (!ownKeys.length) return res.status(400).json({ error: "Add your API key first." });
        release = await takeRun(store, req, "own");
        if (!release) return res.status(429).json({ error: `You’ve used ${limitFor("own")} runs with your own key today, the most we allow. Try again tomorrow.`, quota: await quotaStatus(store, req) });
        // Built for this request only: fresh providers, never registered or cached, never stored.
        const built = await privateCouncil(ownKeys);
        if (!built.providers.length) {
          await release();
          return res.status(400).json({ error: built.problems.map((p) => p.message).join(" ") || "Your key didn’t work." });
        }
        ownProviders = built.providers;
        const names = new Set(ownProviders.map(providerKey));
        const missing = providers.filter((n) => !names.has(n));
        if (missing.length) {
          await release();
          return res.status(400).json({ error: `Your ${missing.join(", ")} key didn’t work. ${built.problems.map((p) => p.message).join(" ")}` });
        }
      } else {
        if (!MOCK_MODE && !hasUsableProvider()) {
          const problems = providerHealth().filter((h) => h.status !== "ok").map((h) => h.message);
          return res.status(503).json({ error: `Free runs aren’t working right now. You can use your own key instead.` });
        }
        const usable = new Set<string>(panelProviders().map(providerKey));
        const unusable = providers.filter((n) => !usable.has(n));
        if (unusable.length) return res.status(400).json({ error: `${unusable.join(", ")} isn’t working right now. Pick another AI model.` });
        const kind = freeKind();
        release = await takeRun(store, req, kind);
        if (!release) {
          await countVisit(store, req, { capHits: 1 });
          const msg =
            kind === "free"
              ? `You’ve used your ${limitFor("free")} free runs for today. Use your own API key to keep going (a free Groq key takes a minute to get), or come back tomorrow.`
              : `You’ve used your ${limitFor("sim")} runs for today. Come back tomorrow.`;
          return res.status(429).json({ error: msg, quota: await quotaStatus(store, req) });
        }
      }

      try {
        // Preliminary check: how many calls can these keys take right now? The run is sized to it.
        const prepared = await prepareRun(brief, panelMode, providers, ownProviders);
        const ownerToken = randomBytes(24).toString("base64url");
        const idea: IdeaRecord = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          status: "running",
          mock: keyMode === "own" ? false : MOCK_MODE,
          panelMode,
          personaLibraryVersion: PERSONA_LIBRARY_VERSION,
          providers: prepared.council.map(providerKey),
          sendPlan: prepared.plan,
          keyMode,
          ownerHash: hashToken(ownerToken),
          ...(user ? { userId: user.id } : {}),
          error: null,
          ...brief,
        };
        await store.insertIdea(idea);
        await countVisit(store, req, { runs: 1, [keyMode === "own" ? "ownKeyRuns" : "freeRuns"]: 1 });
        startPanel(store, idea.id, brief, prepared); // fire-and-forget; client follows over SSE
        // The owner token is shown once, to the submitter: it's what lets them delete the idea later.
        res.status(201).json({ id: idea.id, mock: idea.mock, totalPersonas: PERSONAS.length, sendPlan: prepared.plan, ownerToken, quota: await quotaStatus(store, req) });
      } catch (err) {
        await release();
        throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), ownKeys.map((k) => k.apiKey)));
      }
    }),
  );

  /**
   * This browser's own ideas, private ones included: it sends the ids and owner tokens it holds,
   * and gets back only the ones whose token matches. Nothing is revealed for a wrong token.
   */
  const mineSchema = z.object({ owned: z.array(z.object({ id: z.string().max(64), token: z.string().max(200) })).max(200) });
  r.post(
    "/mine",
    ah(async (req, res) => {
      const parsed = mineSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Bad request." });
      const found = await Promise.all(parsed.data.owned.map(async ({ id, token }) => {
        const idea = await store.getIdea(id);
        return idea?.ownerHash && sameHash(idea.ownerHash, hashToken(token)) ? idea : null;
      }));
      // Signed in: every run on the account too, from any device.
      const user = await currentUser(store, req);
      const byId = new Map<string, IdeaRecord>();
      for (const i of [...found, ...(user ? await store.listIdeasByUser(user.id) : [])]) if (i) byId.set(i.id, i);
      const ideas = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const syntheses = await store.getSyntheses(ideas.map((i) => i.id));
      res.json(ideas.map((idea) => ({ idea: { ...publicIdea(idea), productContext: undefined, yours: true }, synthesis: syntheses.get(idea.id) ?? null })));
    }),
  );

  r.get(
    "/",
    ah(async (_req, res) => {
      // Private runs never appear here, not even for their owner (they fetch theirs with POST /mine).
      const ideas = (await store.listIdeas()).filter((i) => !i.hidden);
      const syntheses = await store.getSyntheses(ideas.map((i) => i.id));
      // The list leaves out product descriptions (they can be long); the idea's own page has it.
      res.json(ideas.map((idea) => ({ idea: { ...publicIdea(idea), productContext: undefined }, synthesis: syntheses.get(idea.id) ?? null })));
    }),
  );

  r.get(
    "/:id",
    ah(async (req, res) => {
      const idea = await store.getIdea(req.params.id);
      if (!idea || !(await canSee(idea, req))) return res.status(404).json({ error: "not found" });
      const [verdicts, failures, synthesis] = await Promise.all([store.getVerdicts(idea.id), store.getFailures(idea.id), store.getSynthesis(idea.id)]);
      const yours = isOwner(idea, req, await currentUser(store, req));
      const state: IdeaFullState = { idea: { ...publicIdea(idea), ...(yours ? { yours: true } : {}) }, verdicts, failures, synthesis, totalPersonas: PERSONAS.length };
      res.json(state);
    }),
  );

  r.delete(
    "/:id",
    ah(async (req, res) => {
      if (isRunning(req.params.id)) return res.status(409).json({ error: "This idea is still being judged. Wait for it to finish." });
      const idea = await store.getIdea(req.params.id);
      if (!idea) return res.status(404).json({ error: "not found" });
      // Only its owner may delete it: the account that ran it, or the browser holding its token.
      if (!isOwner(idea, req, await currentUser(store, req))) return res.status(idea.hidden ? 404 : 403).json({ error: idea.hidden ? "not found" : "Only the person who asked about this idea can delete it." });
      await store.deleteIdea(req.params.id);
      res.status(204).end();
    }),
  );

  /**
   * SSE progress stream. On every (re)connect it first sends a full snapshot from the database,
   * then relays live events. EventSource reconnects automatically after a drop, and because the
   * snapshot is authoritative the client can never end up missing a verdict — no event ids or
   * replay buffer needed. Heartbeat comments keep proxies from closing an idle connection.
   */
  r.get(
    "/:id/stream",
    ah(async (req, res) => {
      const idea = await store.getIdea(req.params.id);
      if (!idea || !(await canSee(idea, req))) return res.status(404).json({ error: "not found" });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      res.write("retry: 2000\n\n");

      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Subscribe BEFORE reading the snapshot, buffering live events, so nothing that lands
      // between the DB read and the subscription can be lost.
      const emitter = existingEmitter(idea.id);
      const buffered: ProgressEvent[] = [];
      let live = false;
      const onProgress = (e: ProgressEvent) => (live ? send("progress", e) : buffered.push(e));
      emitter?.on("progress", onProgress);

      const [verdicts, failures, synthesis, fresh] = await Promise.all([store.getVerdicts(idea.id), store.getFailures(idea.id), store.getSynthesis(idea.id), store.getIdea(idea.id)]);
      send("snapshot", { verdicts, failures, synthesis, status: fresh?.status, error: fresh?.error ?? null });
      for (const e of buffered) send("progress", e); // duplicates are harmless: the client keys verdicts by personaId
      live = true;

      if (fresh?.status !== "running" || !emitter) {
        emitter?.off("progress", onProgress);
        return res.end();
      }

      const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
      const onDone = (e: ProgressEvent) => {
        if (e.type === "done" || e.type === "error") cleanup(true);
      };
      emitter.on("progress", onDone);
      function cleanup(end: boolean) {
        clearInterval(heartbeat);
        emitter!.off("progress", onProgress);
        emitter!.off("progress", onDone);
        if (end) res.end();
      }
      req.on("close", () => cleanup(false));
    }),
  );

  return r;
}

/**
 * Whether this request may see the idea. Public ideas: anyone. Private ones: only with the owner
 * token, from the x-owner-token header (fetch) or ?t= (EventSource can't set headers).
 */
function ownsByToken(idea: IdeaRecord, req: Request): boolean {
  const token = req.get("x-owner-token") ?? (typeof req.query.t === "string" ? req.query.t : "");
  return !!idea.ownerHash && !!token && sameHash(idea.ownerHash, hashToken(token));
}

/** Whether this request is the run's owner: its account, or the browser holding its owner token. */
function isOwner(idea: IdeaRecord, req: Request, user: User | null): boolean {
  return (!!user && !!idea.userId && idea.userId === user.id) || ownsByToken(idea, req);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
