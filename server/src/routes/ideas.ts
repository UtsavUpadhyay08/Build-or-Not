import { Router, type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ownKeySchema } from "./keys.js";
import { freeKind, limitFor, quotaStatus, takeRun } from "../security/visitor.js";
import { redactSecrets } from "../llm/redact.js";
import { countVisit } from "./stats.js";
import { z } from "zod";
import { config, MOCK_MODE } from "../config.js";
import { PERSONAS, PERSONA_LIBRARY_VERSION } from "../personas.js";
import type { Store } from "../store/store.js";
import { publicIdea, type IdeaFullState, type IdeaRecord } from "../types.js";
import { existingEmitter, type ProgressEvent } from "../panel/runPanel.js";
import { isRunning, prepareRun, startPanel } from "../panel/service.js";
import { hasUsableProvider, panelProviders, primaryProvider, privateCouncil, providerHealth, providerKey } from "../llm/registry.js";
import { callStructured } from "../llm/structured.js";
import { DRAFT_SCHEMA, DRAFT_SYSTEM, draftZ } from "../panel/draft.js";

const slider = z.number().min(1).max(10);
const ideaBriefSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().min(1, "Description is required").max(4000),
  targetAudience: z.string().trim().max(1000).default(""),
  pricingModel: z.string().trim().max(1000).default(""),
  competitors: z.string().trim().max(1000).default(""),
  sliders: z.object({ reach: slider, buildCost: slider, userImportance: slider, complexity: slider, value: slider, risk: slider }),
  panelMode: z.enum(["single", "mixed"]).optional(),
  /** Provider names for this run: one for "single", two or more for "mixed". Omit for defaults. */
  providers: z.array(z.string().trim().min(1)).max(10).optional(),
  /** "free": the site's key (capped per visitor per day). "own": the keys below, for this run only. */
  keyMode: z.enum(["free", "own"]).default("free"),
  ownKeys: z.array(ownKeySchema).max(6).optional(),
});

const draftRequestSchema = z.object({
  idea: z.string().trim().min(3, "Describe your idea in a sentence or two.").max(1000, "Keep it under 1,000 characters. AI fills in the rest."),
  keyMode: z.enum(["free", "own"]).default("free"),
  ownKeys: z.array(ownKeySchema).max(6).optional(),
});

/** Express 4 doesn't catch rejected promises from async handlers — forward them to the error middleware. */
const ah = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function ideasRouter(store: Store): Router {
  const r = Router();

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
      const { idea, keyMode, ownKeys = [] } = parsed.data;

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
          { system: DRAFT_SYSTEM, user: `Idea: ${idea}`, schemaName: "submit_draft", schemaDescription: "Submit the complete idea brief.", schema: DRAFT_SCHEMA, maxTokens: 1200 },
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

  r.post(
    "/",
    ah(async (req, res) => {
      const parsed = ideaBriefSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Please add a title and a description.", issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) });
      const { panelMode = config.panelMode, providers = [], keyMode, ownKeys = [], ...brief } = parsed.data;
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

  r.get(
    "/",
    ah(async (_req, res) => {
      const ideas = await store.listIdeas();
      const syntheses = await store.getSyntheses(ideas.map((i) => i.id));
      res.json(ideas.map((idea) => ({ idea: publicIdea(idea), synthesis: syntheses.get(idea.id) ?? null })));
    }),
  );

  r.get(
    "/:id",
    ah(async (req, res) => {
      const idea = await store.getIdea(req.params.id);
      if (!idea) return res.status(404).json({ error: "not found" });
      const [verdicts, failures, synthesis] = await Promise.all([store.getVerdicts(idea.id), store.getFailures(idea.id), store.getSynthesis(idea.id)]);
      const state: IdeaFullState = { idea: publicIdea(idea), verdicts, failures, synthesis, totalPersonas: PERSONAS.length };
      res.json(state);
    }),
  );

  r.delete(
    "/:id",
    ah(async (req, res) => {
      if (isRunning(req.params.id)) return res.status(409).json({ error: "This idea is still being judged. Wait for it to finish." });
      const idea = await store.getIdea(req.params.id);
      if (!idea) return res.status(404).json({ error: "not found" });
      // Ideas are public to read, but only whoever submitted one (holding its token) may delete it.
      const token = req.get("x-owner-token") ?? "";
      if (!idea.ownerHash || !token || !sameHash(idea.ownerHash, hashToken(token))) return res.status(403).json({ error: "Only the person who asked about this idea can delete it." });
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
      if (!idea) return res.status(404).json({ error: "not found" });

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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
