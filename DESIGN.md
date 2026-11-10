# Design notes

These are the decisions, why each was made, and the questions each one should prepare you for.
If you can't explain a section without looking at the code, re-read the file it points to until you can.

## 1. Why 45 separate calls instead of one prompt?

That's the hypothesis the project tests, not a claim it assumes. A single prompt that role-plays
45 personas lets later "personas" read earlier ones, so they anchor and converge, and you get one
model's blind spots. Independent calls can't see each other, can get different models, and their
spread is a real uncertainty signal. Whether that actually predicts outcomes better is measured
in `eval/` against the single-prompt baseline, using the same personas and aggregation, with
independence as the only variable.

**Be ready for:** "What if the panel doesn't win?" Then that's the finding. The report also says
*where* any gain comes from: the "inside the mixed panel" table checks whether mixing beats every
single provider or just rides on one strong model.

## 2. Bounded worker pool, `core/workerPool.ts`

`Promise.all(personas.map(call))` starts all 45 requests at once: a thundering herd that blows
straight through rate limits. Instead, N worker loops pull from a shared cursor.

- `cursor++` is safe without locks because Node runs JS on one thread: nothing can interleave
  between the read and the increment. The concurrency is **I/O concurrency**. While one worker
  awaits a socket, the event loop runs the others.
- Failures never reject the pool. Every item settles, so 3 failed personas don't throw away 42 good ones.
- Abort stops new pulls, and unstarted items are reported as `skipped`, not lost.

**Be ready for:** "Why not p-limit?" It's 30 lines, the semantics (settle-all, skip on abort) are
specific to this app, and you can explain every line of it.

## 3. Token bucket per provider, `core/tokenBucket.ts`

The pool caps how many calls are *in flight*. The bucket caps the *rate* (requests/min) **per provider**,
because Anthropic, OpenAI and Gemini each have their own limits. Capacity = allowed burst, refill = sustained RPM.

- Lazy refill (computed from elapsed time) with one timer armed only while someone waits. No work when idle.
- FIFO waiters, so no starvation.
- `pauseFor()` gives shared backpressure: when one worker gets a 429, the whole provider pauses,
  instead of 6 workers each discovering the limit separately.
- Buckets are keyed by provider, not model, because limits are per account.
- Tests use a virtual clock, so they don't sleep and don't flake.

**Be ready for:** "Token bucket vs leaky bucket vs sliding window?" A token bucket allows bursts up to
capacity and then enforces the average rate, which matches how provider RPM limits behave. "What about
token-per-minute limits?" `acquire(cost)` already supports weighted costs, so passing estimated tokens
is the extension.

## 3b. Measuring each key before a run (`llm/capacity.ts`)

Hard-coded rates are wrong for almost everyone: a free Groq key and a paid OpenAI key differ by 100x.
So the buckets are sized from what the provider itself reports, at two moments: when a key is added
(the preliminary check) and again on every submit, because limits are per minute and earlier runs
use them up.

- **What's read.** Groq and OpenAI send `x-ratelimit-*` headers on every response, Anthropic sends
  `anthropic-ratelimit-*`, and OpenRouter has `GET /key` with free requests left today. One tiny
  completion (16 tokens) is enough to read them. Groq's request headers are per *day* and its token
  headers per *minute*; the parser keeps those apart. Gemini reports nothing, so its documented free
  rate is assumed and labelled as such.
- **The arithmetic.** Calls per minute = min(request cap, tokens per minute / tokens per call). Calls
  that can start *now* = min(that, requests left this minute, tokens left this minute / tokens per call,
  requests left today). On Groq's free tier the token cap decides: 8,000 / ~1,260 = 6, not the 30
  requests a minute it also allows.
- **Tokens per call** starts as an estimate from the real prompts (every persona's system prompt plus
  this idea) and a safe output allowance for reasoning models. After a run, the average real usage
  replaces it, so the plan gets more accurate with use.
- **Applying it.** `TokenBucket.reconfigure(burst, perMinute/60, now)` resizes the bucket in place,
  and the worker pool is sized to the sum of bursts. The first wave starts together; the rest are paced.
- **Being wrong is cheap.** If the estimate is low, a 429 still pauses the bucket and the call retries,
  exactly as before. Against a simulated 8k-TPM Groq, a 45-persona run started 7 at once and finished
  45/45 with two 429s, where sending all 45 at once mostly fails.

**Be ready for:** "Why not just retry on 429?" Retrying works, but a burst that's 7x over the limit
wastes requests, trips the circuit breaker (3 failures in a row) and sends personas home. Measuring
first turns a retry storm into an orderly queue. "Why re-measure on every submit?" The minute's budget
is shared with whatever ran before; the preliminary number is a forecast, the submit-time one is a fact.

## 4. Retries, `core/retry.ts`

Exponential backoff with **full jitter**: `random(0, min(max, base·2^attempt))`. Without jitter,
workers that failed together retry together and collide again. Errors are classified: 408/409/429/5xx,
timeouts and connection resets are retried, while 400/401/403 fail immediately (retrying a bad key
just wastes time). `Retry-After` is honoured when present.

## 5. Structured output: validate, then re-ask once (`llm/structured.ts`)

Each provider has a structured-output mode (Anthropic forced tool call, OpenAI `json_schema`, Gemini
`responseSchema`), but output is still never trusted. Zod validates it. If it fails, the model is
re-asked **once** with the exact validation errors. If it fails again, that persona counts as failed.
One re-ask, not a loop, because a model that can't fix it with the error in hand rarely fixes it on the
third try, and the panel tolerates individual failures anyway. Out-of-range scores are clamped rather
than rejected (a 14/10 still clearly means "loves it").

## 5b. Free providers with uneven features (`llm/openaiCompatible.ts`)

Groq, OpenRouter and OpenCode Zen all speak the OpenAI Chat Completions format, so one adapter covers them.
Free models differ in what they support, so structured output degrades step by step: `json_schema`, then
`json_object` with the schema in the prompt, then plain prompting. The first mode that works for each model
is cached. Replies are cleaned (`<think>` blocks, code fences, surrounding prose) before zod validates them.
A free tier's *daily* cap (429 "per day") is classified as permanent for the day: no retries, the breaker
opens, and the remaining personas move to another provider.

## 6. Partial failure and quorum (`panel/runPanel.ts`)

Each persona's result is saved the moment it arrives. If fewer than `PANEL_QUORUM` (default 80%)
succeed, the run **fails honestly** rather than publishing a verdict from 12 voices. If only the
theme-synthesis call fails, the numeric verdict is still published, because it's computed locally
from the persona scores, not by the LLM.

## 6b. Fail fast on permanent errors: key check and circuit breaker (`llm/keyCheck.ts`, `llm/managed.ts`)

Retries only help with *transient* failures. A rejected key fails identically every time, so retrying it,
or sending 44 more personas at it, only adds noise. At startup each provider's key and model are checked
through the free "get model" endpoint, and failing providers are removed from the panel. During a run,
the first 401/403/404 opens that provider's breaker: later calls fail instantly, and `runPanel` moves the
remaining personas to a provider that still works. Transient errors (429/5xx) never open the breaker.

**Be ready for:** "Why not a classic half-open breaker?" A bad key doesn't heal itself, so there's
nothing to probe. The fix is a human editing `.env` and restarting. A half-open state would matter
for outages, which are a natural next step.

## 7. Resumability and idempotency

Judgments are stored under deterministic ids (`ideaId:personaId`, or `runId:condition:item:persona`
for eval) using `replaceOne(..., {upsert: true})`. Writing twice is harmless, a success always
replaces an earlier failure, and a resumed run just skips ids that already exist. On boot, any idea
still marked `running` is resumed, so only the missing personas are called. This is tested by
`kill -9` on the server mid-run.

## 8. Why MongoDB

The data is document-shaped (idea brief + nested sliders, persona verdicts, synthesis with nested
theme arrays), and it's on the resume. Verdicts live in their **own collection** rather than embedded
in the idea document because 45 concurrent workers write them independently. Separate small upserts
avoid read-modify-write contention on one document and the 16MB document cap.

**Be ready for:** "Why not Postgres?" Postgres would work fine, and there's no relational query here
that Mongo makes hard. The honest answer: document-shaped data, a stack I know, and the idempotent
deterministic-`_id` pattern maps cleanly onto upserts.

## 9. SSE with snapshot-on-connect (`routes/ideas.ts`)

The server subscribes to live events **before** reading the DB snapshot and buffers anything that
arrives in between, then sends snapshot → buffered → live. Because every (re)connect starts with an
authoritative snapshot and the client keys verdicts by `personaId`, a dropped connection can't lose
or duplicate a verdict. No event ids or replay log needed. Heartbeats keep proxies from closing idle streams.

**Be ready for:** "Why SSE and not WebSockets?" Traffic is one-way (server → browser), SSE reconnects
automatically, and it's plain HTTP.

## 10. Experiment design (`eval/`)

- **Ground truth:** YC companies from the 2012–2020 batches. Alive (Active/Acquired/Public) vs Inactive,
  or `--label exit` as a sensitivity check.
- **Balanced, seeded sample**, so AUC/Brier aren't driven by the base rate and resumes use the same items.
- **Metrics:** AUC (Mann-Whitney with tied ranks), Brier, ECE, diversity (score SD, verdict entropy,
  lexical diversity of concerns), and **paired bootstrap** CIs on ΔAUC over the same items.
- **"Why 45?"** comes from subsampling k of the stored judgments per item. Zero extra API cost.
- **Threats to validity**, stated in every report: memorization (names stripped, top companies dropped,
  and since it inflates all conditions equally, the *differences* still mean something), hindsight in
  descriptions, and "alive" ≠ "good idea".

## 11. Running it in public: keys, limits, headers

Threat model: anonymous visitors, one free site key worth protecting, and visitors' own keys
worth even more.

- **A visitor's key is scoped to their run.** It arrives with the submit request. `privateCouncil()`
  builds providers for that request only, each with its own token bucket (not the shared per-provider
  one), marked so the capacity cache and `/api/meta` never record them. Theme synthesis and the
  circuit-breaker reroute stay inside that council, so an own-key run can't fall back to the site key,
  and the site key's runs can't reach a visitor's. When the run ends, nothing references the key.
  It's never written to MongoDB. Failure text is saved with public ideas, and some providers quote part
  of a bad key in their errors, so `redactSecrets()` scrubs key-shaped strings before anything is
  stored, streamed or logged. A test runs two visitors with different keys at once against a fake Groq
  that scores per key, and checks that each run only got its own key's answers.
- **3 free runs per IP per day, enforced atomically.** One `findOneAndUpdate({_id, n: {$lt: 3}},
  {$inc: {n: 1}}, {upsert: true})`. At the limit the filter misses, the upsert collides on `_id` (E11000),
  and that means "no". Two simultaneous requests can't both take the last run. Counters live in Mongo
  (a sleeping or restarting free host would otherwise hand out fresh runs), keyed by HMAC(IP), with a
  TTL index that deletes them at midnight UTC. A run that fails to start gives its slot back.
- **The real visitor IP.** Behind a proxy, `req.ip` is only right if `trust proxy` equals the number
  of hops: too low and everyone shares one counter, too high and anyone can fake an IP with
  `X-Forwarded-For`. This bit me in production: on Render the chain is visitor → Cloudflare → Render's
  internal proxy, `trust proxy` was 1, so every visitor got the internal proxy's address and the whole
  internet shared 3 free runs. The fix stops counting hops: on Render (`RENDER=true`) the app reads
  `True-Client-IP`, which Render's Cloudflare edge sets to the real address and overwrites if a client
  sends its own. Headers are trusted only there (or when `CLIENT_IP_HEADER` names one), never locally,
  so they can't be faked. Tests replay Render's setup: same proxy address, different `True-Client-IP`,
  separate counters; a fake `X-Forwarded-For` changes nothing.
- **Headers.** helmet with a strict CSP: own scripts only, Google Fonts for styles and fonts,
  `frame-ancestors 'none'`, `object-src 'none'`. Plus HSTS, nosniff, `Referrer-Policy: no-referrer`,
  a Permissions-Policy denying camera, mic and location, and `Cache-Control: no-store` on the API. No
  CORS unless `CORS_ORIGIN` is set, because the API serves its own client.
- **Everything else.** 64 KB body limit; zod limits on every field and list; 120 API requests a
  minute and 10 key checks an hour per IP (so the site isn't a stolen-key tester); 500s answer with a
  generic message. Ideas are public to read, but deleting one needs the token handed to its submitter
  (only its SHA-256 is stored, compared in constant time). `npm audit` is clean.

**Be ready for:** "Why IP and not accounts?" Accounts add sign-up friction for a demo and a password
database to protect. IP is a speed bump, not a wall: someone with many IPs gets more runs. That's
acceptable only because the site key is a free-tier key, so the worst case is the free tier running
out for the day, never a bill. "Why not keep visitors' keys server-side to resume after restarts?"
Storing them would make the database worth stealing. Losing an in-flight run on a restart is the
better trade.

## What I'd do next

- Token-weighted buckets (TPM limits), and a half-open circuit breaker for provider *outages*
  (the current breaker only covers permanent errors like bad keys).
- Embedding-based diversity instead of lexical Jaccard.
- Prompt caching for the persona system prompts (identical across ideas) to cut cost.

### Many people on the shared key at once: taking turns

Six visitors clicked "Fill it in and ask the council" in the same second. All six runs started, but
the queue was first-come: after 70 s the first idea had 21 answers and the other five had 6, 0, 0, 0, 0.
The first council took every slot the shared keys freed up.

Now each call names its run (`fairKey` = idea id) and the token bucket keeps one line per run. Runs
take turns, one call each, round and round; inside a run it's still first-come. Re-running the same
test, the first idea keeps the head start it got from the free burst, then all six move at the same
pace (each about 4 answers a minute on 3 free keys). The send plan also says how many other ideas
are being judged on the free key, so nobody is promised "18 questions go out now" when that's shared.
A visitor's own key has its own bucket, so it never waits behind anyone.
