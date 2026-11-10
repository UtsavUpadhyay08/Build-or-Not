/**
 * "Check my key" for visitors who bring their own. The key is checked and its limits measured,
 * then thrown away: nothing is stored, cached or shared. The visitor's browser sends the key again
 * with the run that uses it (POST /api/ideas with keyMode "own").
 *
 * Rate limited per visitor, so the site can't be used to test stolen keys in bulk.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { clientIp } from "../security/clientIp.js";
import { z } from "zod";
import { config } from "../config.js";
import { measureProvider, OWN_KEY_PROVIDERS, privateCouncil } from "../llm/registry.js";
import { redactSecrets } from "../llm/redact.js";

const ah = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export const ownKeySchema = z.object({
  provider: z.enum(OWN_KEY_PROVIDERS),
  apiKey: z.string().trim().min(8, "That's too short to be an API key.").max(400),
  model: z.string().trim().max(200).optional(),
});

export function keysRouter(): Router {
  const r = Router();

  r.use((_req, res, next) => (config.allowOwnKeys ? next() : res.status(403).json({ error: "This site doesn’t allow your own key." })));

  r.post(
    "/check",
    rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: config.limits.keyChecksPerHour,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: (req) => clientIp(req), // the real visitor, not the host's proxy
      validate: { trustProxy: false, xForwardedForHeader: false },
      message: { error: `You’ve checked ${config.limits.keyChecksPerHour} keys in the last hour. Try again later.` },
    }),
    ah(async (req, res) => {
      const parsed = ownKeySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That doesn’t look like an API key." });
      const { providers, problems } = await privateCouncil([parsed.data]);
      if (!providers.length) return res.status(400).json({ error: problems[0]?.message ?? "That key didn’t work." });
      const p = providers[0];
      const capacity = await measureProvider(p);
      res.json({ ok: true, provider: p.name, model: p.model, capacity: { ...capacity, detail: redactSecrets(capacity.detail, [parsed.data.apiKey]) } });
    }),
  );

  return r;
}
