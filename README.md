# Build or Not

**45 AI personas judge your startup idea, each on its own, and show you where they disagree.**

<!-- SCREENSHOT 1 (hero): the home page with the proposal form and the village. Save as docs/screenshots/hero.png -->
![Build or Not: the proposal form next to the village of 45 personas](docs/screenshots/hero.png)

## What it is

You describe an idea. A council of 45 fixed personas judges it: end users, investors, critics, edge-case
users, and the people who'd have to build and support it. Each persona answers in its **own,
independent** AI call, so nobody anchors on anyone else. You get a Build / Maybe / Don't build verdict,
and more usefully, *who* disagreed and why.

It's also an experiment. An eval mode runs the council over YC companies whose outcome is known and
measures whether 45 independent judges actually predict better than a single prompt.

## How it looks

| | |
|---|---|
| <!-- SCREENSHOT 2: mid-run, characters walking to BUILD / MAYBE / DON'T BUILD. Save as docs/screenshots/council.png --> ![The council deliberating in the village square](docs/screenshots/council.png) | <!-- SCREENSHOT 3: a character clicked, showing their review. Save as docs/screenshots/review.png --> ![One persona's review](docs/screenshots/review.png) |
| **The council meets.** On submit, everyone walks to the square. As each verdict arrives, that character walks to their side. | **Every voice is readable.** Click anyone for their score, reasoning, top concern and what they liked. |
| <!-- SCREENSHOT 4: the results section (score ring, verdict, the numbers). Save as docs/screenshots/results.png --> ![Results: verdict, score and disagreement metrics](docs/screenshots/results.png) | <!-- SCREENSHOT 5: the "How to run it" box (free tier vs own key). Save as docs/screenshots/keys.png --> ![Free tier or your own API key](docs/screenshots/keys.png) |
| **Results that show disagreement.** Overall score, score spread, verdict entropy, recurring concerns, and scores by persona group and by model. | **Free tier or your own key.** 3 free runs a day, or paste your own key (used only for your run, never stored). |

## How it works

- **45 independent calls per idea**, spread over one model or several (Groq, OpenRouter, Gemini, OpenAI,
  Anthropic), through a bounded worker pool with retries, backoff and a circuit breaker.
- **Sized to the key.** Before each run it reads the key's real rate limits and sends as many calls at once
  as the key allows, then paces the rest. A free Groq key gets about 6 at once instead of a wall of 429s.
- **Survives failure.** A persona whose call fails "goes home" and explains why. A verdict needs 80% of
  the council, and runs resume after a restart.
- **Safe to put online.** Visitors' keys are scoped to their own run. Free runs are capped per IP per day,
  atomically, in MongoDB. Strict security headers, rate limits, and keys scrubbed from anything stored.

The reasoning behind each choice, written for interview prep, is in [DESIGN.md](DESIGN.md).

## Run it

```bash
npm install
docker compose up -d mongo      # or set MONGODB_URI to a free Atlas cluster
npm run dev                     # http://localhost:5174
```

With no API key it runs on simulated models. For real answers, paste a free Groq key on the page or put
`GROQ_API_KEY` in `.env` (see `.env.example`).

## More

- [Full guide](docs/GUIDE.md): setup, providers, troubleshooting, the YC experiment, tests
- [Deploy for free](docs/GUIDE.md#deploy-for-free-render--mongodb-atlas): Render + MongoDB Atlas, step by step
- [Design notes](DESIGN.md): concurrency, rate limits, measuring keys, security

**Stack:** Node.js · Express · TypeScript · MongoDB · React · Vite · Vitest · Docker · Render
