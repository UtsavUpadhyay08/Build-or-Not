import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Must be imported FIRST (see index.ts / eval/cli.ts): config.ts reads process.env at load time.
// .env lives at the repo root, one level above server/.
//
// override: true — by default dotenv does NOT replace a variable that already exists in the shell
// or in Windows' system environment. That silently lets an old ANTHROPIC_API_KEY set years ago
// (or by another tool) win over the key you just pasted into .env. We want .env to win, and we
// say so when it happens.
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
const before = { ...process.env };
const result = dotenv.config({ path: envPath, override: true });

if (result.parsed) {
  for (const [k, v] of Object.entries(result.parsed)) {
    if (before[k] !== undefined && before[k] !== v && /KEY|URI/.test(k)) {
      console.warn(`[env] ${k} was also set in your system/shell environment with a different value; using the one from .env.`);
    }
  }
}
