# Build or Not: full guide

**Does a panel of independent LLM judges evaluate startup ideas better than one prompt?**

Build or Not is two things:

1. **An app.** You submit an idea brief. 45 fixed personas (end users, investors, critics,
   edge cases, the people who'd have to build and support it) each judge it in their **own,
   independent** LLM call, optionally spread across Claude, GPT and Gemini. The dashboard shows
   the verdict *and how much the panel disagreed*: score spread, verdict entropy, and mean score
   by persona group and by model.
2. **An experiment.** The `eval` module runs the same personas over a few hundred startups whose
   outcome is known (YC companies, alive vs dead) under three conditions, then reports which
   predicts outcomes better:
   - **baseline**: one prompt role-plays all 45 personas at once
   - **panel**: 45 independent calls, one model
   - **mixed**: 45 independent calls, models mixed

The interesting engineering is the fan-out: 45 calls per idea (thousands per eval run) across
providers with different rate limits, without falling over. See [DESIGN.md](../DESIGN.md).

## The game UI

One page, three parts:

- **Proposal (left):** the idea brief, the six idea stats, and **the council**. Pick one model for all 45
  personas, or *mixed models* to share them evenly across the models you tick. Providers whose
  key check failed are listed as switched off, with the reason.
- **Just type your idea:** a popup at the top of the form. Write a sentence or two and the AI writes
  the full brief (title, description, audience, pricing, competitors, the six stats), then either fills
  in the form for you to check or summons the council straight away. It uses the same key as the run
  (the free tier or your own) and is capped at `DRAFTS_PER_DAY` (10) per visitor.
- **The village (right):** 45 characters, each with a house and a name, in five districts. On submit
  they walk to the council square. As each real verdict streams in, that character walks to
  BUILD, MAYBE or DON'T BUILD. Click a character for their short take, then "Read full review"
  for the whole thing. Characters whose call failed walk home and explain why: what failed, what
  was retried, whether it changes the result, and what you can do about it.
- **Results (below):** verdict, score ring and podium; every number (overall score, agreement,
  score spread, verdict entropy, confidence, responses, tokens, cost); the score histogram; model and
  district scoreboards; the three teams; recurring concerns and appeals; empty seats; and a
  sortable table of all 45 scores. Past runs are under "Past proposals".

## Stack

Node.js + Express + TypeScript · MongoDB · React + Vite · Vitest · Docker Compose · GitHub Actions

## Quick start

```bash
npm install
docker compose up -d mongo      # or set MONGODB_URI to an Atlas cluster
npm run dev                     # server :4100, client http://localhost:5174
```

With no API keys it runs in **mock mode**. That includes three fake providers, so mixed mode works,
and all the real concurrency machinery. To watch retries, re-asks and partial failure for free:

```bash
MOCK_FAILURE_RATE=0.3 MOCK_MALFORMED_RATE=0.1 npm run dev
```

For real judgments, paste a key on the page (see below), or copy `.env.example` to `.env` and set one or more keys.

- **Free:** `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY` and `GEMINI_API_KEY`. Leave
  `*_MODEL` empty and the server picks a current free model at startup, then prints which one.
- **Paid:** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.

With two or more keys set, the form offers the mixed panel.

Free tiers are small. Groq's limit works out to about 6 persona calls a minute, and OpenRouter
gives about 50 requests a day, roughly one panel. Mixed mode spreads the 45 calls across providers.
When one provider's daily cap runs out mid-run, its remaining personas move to the others.

### Free tier or your own key

Under **How to run it**, every visitor picks one of two options.

- **Use the free tier.** Runs on the site's own key (`GROQ_API_KEY` on the server). Each visitor gets
  `FREE_RUNS_PER_DAY` (3) runs a day, counted per IP address and reset at midnight UTC. The count
  is stored in MongoDB, so restarting the server doesn't reset it. Raw IPs are never stored: they're
  hashed with `IP_HASH_SECRET`. With no site key at all, the free tier runs simulated models instead.
- **Use my own API key.** The visitor pastes a key (Groq, OpenRouter, Gemini, OpenCode, OpenAI or
  Anthropic). One tiny request checks it and reads its rate limits, and the card shows what it can take,
  e.g. *"Sends 6 at once, then 6 a minute · 999 left today"*. The key stays in that browser tab
  (and in the browser's storage only if they tick "Remember"). It's sent with that visitor's run and
  nothing else. The server builds a private set of providers for that one run, with their own rate
  limiter. It never caches the key, never writes it to the database or logs, and never uses it for
  anyone else's run. Theme synthesis also runs on the visitor's key, not the site's.

Either way, the limits are measured again on submit. As many questions as the key allows go out at
once and the rest follow at its per-minute rate, as shown on the status bar and the proposal card.
`PANEL_ALL_AT_ONCE=true` sends all 45 regardless, `PANEL_ALL_AT_ONCE=false` paces them, and
`GROQ_BURST=5` (or any provider) pins one key's burst.

Ideas are public: everyone can read every proposal and its results. Only the browser that submitted an
idea can delete it. It gets a delete token at submit time, and the server keeps only its hash.

## Troubleshooting: "No response" from every persona

When the server starts, it checks every key, using free list-model endpoints that spend no tokens. It prints something like:

```
Checking API keys…
  [FAIL] anthropic/claude-haiku-4-5  key sk-ant-…0000 (55 chars)
         anthropic rejected the key in ANTHROPIC_API_KEY. It's wrong, revoked, or from another account. ...
```

The same message appears on the form. Common causes:

- **Key rejected (401, or 400 on Gemini):** the key is wrong, was revoked, or belongs to an old project.
  Create a fresh key in the provider's console, paste it into `.env`, and **restart the server**. `.env` is only read at startup.
- **Old key set in your system environment:** `.env` now overrides it, and the server warns when this happens.
- **"no model called …":** the key works but the model name is retired. Set `ANTHROPIC_MODEL`, `OPENAI_MODEL` or `GEMINI_MODEL`.
- **No credit:** the key is valid but the account has no billing set up.

Providers that fail the check are taken off the panel. If a key stops working in the middle of a
run, the first rejected call opens a circuit breaker and the remaining personas move to a provider
that still works, so you lose 1 call instead of 45.

## Running the experiment

```bash
cd server
npm run eval -- fetch-yc                                   # downloads YC's public company list
npm run eval -- run --run-id yc-100 --n 100 --budget-usd 5 # balanced sample, hard spend cap
npm run eval -- run --run-id yc-100 --n 100 --budget-usd 10  # same command again = resume
npm run eval -- report --run-id yc-100                     # -> server/eval-reports/yc-100.md
```

- **Resumable.** Every judgment is upserted under `runId:condition:item:persona`. Ctrl-C at any
  point and re-run.
- **Budget cap.** It stops starting new calls once `--budget-usd` is spent. Raise it and re-run to
  continue.
- **Cost.** About 91 calls per item for all three conditions (1 baseline + 45 + 45). Start with
  `--n 20` to check the cost per item before scaling up.
- **Dataset options.** `--label exit` (Public/Acquired vs Inactive) works as a sensitivity check.
  `--dataset csv --file … --text-cols … --label-col … --positive … --negative …` loads any labeled CSV
  (e.g. Kaggle's Kickstarter data).

The report includes AUC, Brier, calibration, diversity metrics, paired-bootstrap confidence
intervals for every comparison, a **"why 45?" curve** (AUC vs panel size, computed by subsampling
with no extra calls), and threats to validity.

## Tests

```bash
npm test                                                             # unit tests
MONGODB_TEST_URI=mongodb://127.0.0.1:27017/build-or-not-test npm test  # + 4 MongoDB integration tests
```

CI runs both against a Mongo service container, then builds the Docker image.

## Production-style run

```bash
docker compose --profile app up --build    # app + mongo, served on http://localhost:4100
```

## Deploy for free (Render + MongoDB Atlas)

Everything below is on free plans: Render's free web service runs the Docker image, a MongoDB Atlas
free cluster holds the data, and your free Groq key powers the free tier.

### 1. Put the code on GitHub

```bash
git init
git status          # .env must NOT be listed. It's in .gitignore; if you see it, stop.
git add -A
git commit -m "Build or Not"
git branch -M main
git remote add origin https://github.com/<you>/build-or-not.git
git push -u origin main
```

### 2. Database: MongoDB Atlas free cluster

1. Sign in at cloud.mongodb.com and create a **Free** cluster. Pick a region near Singapore (where the
   app will run).
2. **Database Access → Add New Database User.** Use password authentication and let Atlas generate a
   long password; copy it. Under privileges, choose *Specific Privileges → readWrite* on the database
   `build-or-not` only, so the app's user can't touch anything else.
3. **Network Access → Add IP Address.** Render's free services don't have a fixed outbound IP, so
   allow `0.0.0.0/0`. The connection is still encrypted (TLS), and the long password is what keeps
   the database private. If your Render service page lists outbound IP addresses, allow just those
   instead.
4. **Connect → Drivers** and copy the `mongodb+srv://...` string. Put your password in, and add the
   database name before the `?`:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/build-or-not?retryWrites=true&w=majority`

### 3. App: Render free web service

1. Sign in at render.com with GitHub. **New → Blueprint**, pick the repo. Render reads `render.yaml`.
2. It asks for two secrets: paste the `MONGODB_URI` from step 2 and your `GROQ_API_KEY`. Click **Apply**.
   (`IP_HASH_SECRET` is generated for you.)
3. Wait for the build (a few minutes), then open `https://build-or-not.onrender.com` (or whatever URL
   Render shows).
4. **Set the proxy count.** After your first visit, open the service's **Logs** and find the line
   starting `[visitor IP]`. If it says `set TRUST_PROXY=N`, go to **Environment**, set `TRUST_PROXY`
   to that N, and save (Render redeploys). This is what makes the 3-a-day limit count each visitor
   separately and stops anyone faking their IP to get more runs.

### 4. Check it before you share the link

- **Headers:** scan your URL at securityheaders.com. You should see CSP, HSTS, X-Frame-Options,
  X-Content-Type-Options, Referrer-Policy and Permissions-Policy.
- **Daily limit:** run 3 ideas on the free tier; the 4th is refused. Your phone on mobile data (a
  different IP) still has its own 3.
- **Can't fake an IP:** once you've used your 3 runs, this must still be refused (HTTP 429):
  ```bash
  curl -i -X POST https://<your-app>.onrender.com/api/ideas -H "Content-Type: application/json" \
    -H "X-Forwarded-For: 1.2.3.4" \
    -d '{"title":"t","description":"d","sliders":{"reach":5,"buildCost":5,"userImportance":5,"complexity":5,"value":5,"risk":5}}'
  ```
  If it's accepted, `TRUST_PROXY` is too high. Lower it by one.
- **Ideas:** in a private window you can open other people's ideas but see no Delete button.
- **Own key:** run once with your own key, then search Render's logs for the first few characters
  of the key. Nothing should come up.

### Seeing who visits: the stats page

Open `https://<your-app>.onrender.com/stats` and paste the `ADMIN_TOKEN` from Render's
**Environment** tab (Render generated it for you). It shows, for the last 7, 30 or 90 days:

- visitors, returning visitors and page views, per day
- where visitors came from (linkedin.com, github.com, …) or direct
- how many ran an idea, free tier vs own key, finished vs failed, and who hit the 3-a-day limit
- the latest 50 runs with their verdicts

It counts people by a one-way hash of their IP and keeps only the referring site's name, with no
cookies and no third-party trackers, so there's nothing personal to leak and no cookie banner needed.
Data deletes itself after 90 days. Nobody else can open it: without the token the API answers 401,
and with `ADMIN_TOKEN` unset the page is switched off entirely (404).

Other places with numbers: Render's **Metrics** tab (CPU, memory, bandwidth, and request counts),
Render's **Logs**, and in Atlas, **Browse Collections** (the raw `ideas` and `visits` data).

### Good to know

- **Sleeping.** A free Render service sleeps after 15 minutes without visitors; the next visit takes
  about a minute to wake it. If it restarts mid-run, free-tier runs pick up where they left off.
  Own-key runs can't (the key was never stored), so the page asks the visitor to run again.
- **Atlas pauses** a free cluster after 30 days with no connections. Resume it from the Atlas page.
- **Never make a paid key the site key.** The daily limit is per IP, and someone with many IPs can
  get around it. With a free Groq key the worst case is the free tier running out for the day, not a
  bill. If the key leaks, delete it in Groq's console and paste a new one into Render's Environment tab.
- **Secrets** live only in Render's dashboard and your local `.env`. `.gitignore` and `.dockerignore`
  keep `.env` out of the repo and the image.

## Layout

```
server/src/
  index.ts       startup: key checks, measuring keys, resume interrupted runs
  app.ts         Express app: security headers, rate limits, routes
  config.ts      every setting, read from the environment
  personas.ts    the 45 personas
  core/          tokenBucket · workerPool · retry            (no dependencies, fully unit-tested)
  llm/           providers (Anthropic, OpenAI, Gemini, Groq, OpenRouter, OpenCode, mock)
                 managed (rate limit + retry + circuit breaker) · registry (councils, own-key councils)
                 capacity (measure a key, size the run) · keyCheck · structured (zod + re-ask) · redact
  panel/         prompts · judge · aggregate (verdict + disagreement math) · runPanel · service
  routes/        ideas (REST + live progress over SSE, daily limits) · keys (check a visitor's key)
  security/      visitor (hashed IP, daily limits) · security tests
  store/         Store interface · MongoStore · MemoryStore (tests)
  eval/          datasets · runEval · metrics · report · cli
client/src/
  game/          GamePage · Village · ProposalForm · ProposalSummary · RunOptions · ReviewPanel · Results
  history/       HistoryPage (every proposal; delete your own)
  api.ts · types.ts · exportMarkdown.ts
```
