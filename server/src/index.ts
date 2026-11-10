import "./env.js"; // must be first: loads .env before config.ts reads process.env
import { config, MOCK_MODE } from "./config.js";
import { databaseName, MongoStore, redactMongoUri } from "./store/mongoStore.js";
import { redactSecrets } from "./llm/redact.js";
import { createApp } from "./app.js";
import { resumeInterrupted } from "./panel/service.js";
import { capacityOf, hasUsableProvider, measureAll, panelProviders, runHealthChecks } from "./llm/registry.js";

async function main() {
  let store: MongoStore;
  try {
    store = await MongoStore.connect(config.mongoUri);
  } catch (err) {
    // Never print the URI as-is: it contains the database password.
    console.error(
      `\nCould not connect to MongoDB at ${redactMongoUri(config.mongoUri)} (database "${databaseName(config.mongoUri)}")\n` +
        `  -> Start one with:  docker compose up -d mongo\n` +
        `  -> or set MONGODB_URI in .env (e.g. a free MongoDB Atlas cluster)\n\n${redactSecrets((err as Error).message, [config.mongoUri])}\n`,
    );
    process.exit(1);
  }

  if (!MOCK_MODE) {
    console.log("Checking API keys…");
    for (const h of await runHealthChecks()) {
      const mark = h.status === "ok" ? "OK  " : h.status === "unreachable" ? "??  " : "FAIL";
      console.log(`  [${mark}] ${h.name}/${h.model}  key ${h.keyHint}${h.status === "ok" ? "" : `\n         ${h.message}`}${h.note ? `\n         note: ${h.note}` : ""}`);
    }
    if (!hasUsableProvider()) {
      console.log("\n  No working provider. Paste a key on the page, or fix .env and restart the server.\n");
    }
  }

  // Preliminary check: how many persona calls can each key take at once? (Re-checked on every submit.)
  await measureAll();
  for (const p of panelProviders()) {
    const c = capacityOf(p);
    if (c) console.log(`  [SEND] ${p.name}/${p.model}: ${c.now} at once now, then ${c.perMinute}/min. ${c.detail}`);
  }

  const resumed = await resumeInterrupted(store);
  if (resumed) console.log(`Resuming ${resumed} panel run(s) interrupted by the last shutdown.`);

  const server = createApp(store).listen(config.port, () => {
    const providers = config.providers.map((p) => `${p.name}/${p.model}`).join(", ");
    console.log(`Build or Not server on http://localhost:${config.port} — ${MOCK_MODE ? "MOCK MODE (no API keys set)" : providers} — panel mode: ${config.panelMode} — send mode: ${config.sendMode}`);
    if (MOCK_MODE) console.log("  No site key: the free tier runs on simulated models. Visitors can still use their own keys.");
  });

  const shutdown = async () => {
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
