import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config, MOCK_MODE } from "./config.js";
import { PERSONAS, PERSONA_LIBRARY_VERSION } from "./personas.js";
import { ideasRouter } from "./routes/ideas.js";
import { allProviders, capacityOf, providerHealth, providerKey } from "./llm/registry.js";
import { keysRouter } from "./routes/keys.js";
import { redactSecrets } from "./llm/redact.js";
import type { Store } from "./store/store.js";

export function createApp(store: Store) {
  const app = express();
  // Behind a host's proxy (Render: 1 hop) req.ip must come from X-Forwarded-For, or every visitor
  // looks like the proxy and shares one daily limit. Off by default so it can't be spoofed locally.
  app.set("trust proxy", config.trustProxy);

  // Hosts don't always document how many proxies sit in front of the app. For the first few API
  // requests, log the shape of X-Forwarded-For (counts only, no addresses) and the TRUST_PROXY value
  // that matches it, so the owner can set it from the host's log after the first visit.
  let ipChecks = 0;
  app.use("/api", (req, _res, next) => {
    if (ipChecks < 3 && process.env.NODE_ENV === "production") {
      ipChecks++;
      const xff = (req.get("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const extra = ["true-client-ip", "cf-connecting-ip", "x-real-ip"].filter((h) => req.get(h)).join(", ") || "none";
      const suggest = xff.length;
      const status = config.trustProxy === suggest ? "matches" : `set TRUST_PROXY=${suggest} (now ${config.trustProxy})`;
      console.log(`[visitor IP] X-Forwarded-For has ${xff.length} address${xff.length === 1 ? "" : "es"}; other IP headers: ${extra}. ${suggest ? status : "No proxy in front, TRUST_PROXY=0 is right."} (Valid when this request came straight from a browser.)`);
    }
    next();
  });

  // Security headers. The CSP allows only this site's own scripts, plus Google Fonts.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], // React/recharts set inline styles
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false, // Google Fonts aren't served with CORP headers
      referrerPolicy: { policy: "no-referrer" },
      strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true }, // browsers ignore it over plain http (localhost)
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    next();
  });

  // Same-origin by default (the API serves the client). Cross-origin only if CORS_ORIGIN names one.
  if (config.corsOrigin) app.use("/api", cors({ origin: config.corsOrigin.split(",").map((o) => o.trim()) }));

  app.use(express.json({ limit: "64kb" }));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); // API answers can carry per-visitor data
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: config.limits.apiPerMinute,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (req) => req.path === "/health",
      message: { error: "Too many requests. Slow down and try again in a minute." },
    }),
  );

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/meta", (_req, res) => {
    res.json({
      mock: MOCK_MODE,
      personaCount: PERSONAS.length,
      personaLibraryVersion: PERSONA_LIBRARY_VERSION,
      panelMode: config.panelMode,
      sendMode: config.sendMode,
      ownKeys: config.allowOwnKeys,
      limits: { freeRunsPerDay: config.limits.freeRunsPerDay, simRunsPerDay: config.limits.simRunsPerDay, ownRunsPerDay: config.limits.ownRunsPerDay },
      // The site's own keys (the free tier). Their key hints are never sent: not even masked.
      providers: allProviders().map((p) => ({
        key: providerKey(p),
        name: p.name,
        model: p.model,
        stats: p.stats,
        usable: !p.unavailableReason,
        reason: p.unavailableReason,
        source: p.name === "mock" ? "mock" : "env",
        capacity: capacityOf(p),
      })),
      health: providerHealth().map(({ keyHint: _hidden, ...h }) => h),
      personas: PERSONAS.map((p) => ({ id: p.id, name: p.name, category: p.category, tagline: p.tagline })),
    });
  });

  app.use("/api/ideas", ideasRouter(store));
  app.use("/api/keys", keysRouter());

  // In production (docker), serve the built client from the same origin.
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
  }

  // Unexpected errors: log them (keys scrubbed), but tell the visitor nothing about the internals.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) console.error(redactSecrets(err instanceof Error ? err.stack ?? err.message : String(err)));
    if (res.headersSent) return;
    if (status < 500) return res.status(status).json({ error: status === 413 ? "That's too much text." : status === 400 ? "That request didn't make sense." : "Request refused." });
    res.status(500).json({ error: "Something went wrong on the server. Try again in a moment." });
  });

  return app;
}
