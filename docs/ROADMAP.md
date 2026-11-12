# Roadmap

What's planned next, roughly in order. Done items move to the changelog in the commit history.

## To do

### API keys saved on your profile
Today a visitor's own API key lives only in their browser (this tab, or localStorage if they tick
"remember"), and is sent with each run. Signed-in users should be able to save keys to their
account once and use them on any device.

Sketch:
- A **Keys** page in the account menu: add / test / remove a key per provider (Groq, OpenRouter,
  Gemini, OpenAI, Anthropic), reusing the existing key check (`POST /api/keys/check`).
- **Encrypted at rest**: AES-256-GCM with a server secret (`KEY_ENCRYPTION_SECRET`), a fresh IV per
  key, the user id as associated data (so a key copied into another account's record won't decrypt).
  Rotating the secret = re-encrypt on next use.
- **Never sent back** to the browser in full: only the provider, a hint (`gsk_…a1b2`), when it was
  added and last used.
- Runs pick the saved key server-side (`keyMode: "account"`), so the key never travels with each
  request. The per-day limits for own-key runs apply per account instead of per IP.
- Deleting the account deletes its keys. Tests: encrypt/decrypt round-trip, wrong user can't
  decrypt, hint never contains the key, run uses the saved key without the client sending it.

### Generate a product description.md from a short form
For feature mode, when someone doesn't have a `description.md`: name, one-line pitch, users, main
features, pricing, market, stage, competitors → one AI call writes the markdown → review, download,
use. Saved for the next feature test.

### Feedback items still open
- Demo mode: a precomputed run that replays in ~30 seconds, for visitors who just want to see it.
- A live feed of persona quotes while the council votes, and a "guess the verdict" game.
- Target market as an input (India, US, …), passed to every persona.
- Share the result as an image with a watermark.
- A competition section (clearly labelled as the AI's guess unless backed by search).
