# Sign-in setup

Accounts are optional for visitors: anyone can run an idea without one. Signing in lets them keep
runs **private** and see **all their runs on any device** ("My runs").

Each sign-in option switches on by itself once its keys are in `.env` (locally) or in Render's
Environment tab (deployed). Options without keys simply don't show on the sign-in screen.

| Option | Cost | What you need |
|---|---|---|
| Google | Free | An OAuth client in Google Cloud Console |
| GitHub | Free | An OAuth app in GitHub settings |
| Email code | Free (100 emails/day) | A Resend account. Locally, no setup: the code is printed in the server log |

Set this first, everywhere you deploy:

```
PUBLIC_URL=https://your-app.onrender.com
```

Every **callback URL** below is `PUBLIC_URL` + `/api/auth/<provider>/callback`. For local
development, register the `http://localhost:5174/...` version as well (the dev site's address).

---

## Google

1. Go to <https://console.cloud.google.com/> → create a project (any name).
2. **APIs & Services → OAuth consent screen**: External, app name "Build or Not", your email.
   Scopes: `openid`, `email`, `profile` (the defaults). Publish the app when you're ready for
   everyone (while in "Testing", only test users you list can sign in).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → *Web application*.
4. **Authorized redirect URIs**:
   - `https://your-app.onrender.com/api/auth/google/callback`
   - `http://localhost:5174/api/auth/google/callback`
5. Copy the client ID and secret:

```
GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

## GitHub

1. <https://github.com/settings/developers> → **OAuth Apps → New OAuth App**.
2. Homepage URL: your site. **Authorization callback URL**:
   `https://your-app.onrender.com/api/auth/github/callback`
   (GitHub allows one callback per app: make a second app for local development with
   `http://localhost:5174/api/auth/github/callback`.)
3. **Generate a new client secret**, then:

```
GITHUB_CLIENT_ID=Ov23li...
GITHUB_CLIENT_SECRET=...
```

## Email code

1. Sign up at <https://resend.com> → **API Keys → Create**.
2. To send from your own domain, add it under **Domains** and verify the DNS records. Without a
   domain you can only send test emails to your own address (from `onboarding@resend.dev`).

```
RESEND_API_KEY=re_...
EMAIL_FROM=Build or Not <signin@yourdomain.com>
```

Locally, leave `RESEND_API_KEY` empty: the 6-digit code is printed in the server log.

---

## How it works (and why it's safe)

- **Sessions**: a random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` on https).
  The database stores only its SHA-256, so a database leak doesn't hand out logins. Sign-out deletes
  it on the server. Sessions last 30 days.
- **OAuth**: authorization-code flow with a one-time `state` stored on the server, PKCE for
  Google and GitHub, and an OIDC `nonce`. Google's ID token is verified against Google's published
  keys (signature, issuer, audience, expiry, nonce). After sign-in, people only ever go back to a page on this site.
- **Email codes**: 6 digits, 10 minutes, one use, 5 wrong tries then locked, stored hashed. At most
  5 codes per address and 10 per visitor each hour. The answer is the same whether or not an
  account exists.
- **One account, many ways in**: signing in with a different option that has the same *verified*
  email joins the same account. An unverified email never links to anything.
- **CSRF**: signed-in requests that change something must come from this site's own origin.
- **Private runs**: anyone but the owner gets "not found", link or not. The account id is never
  sent to browsers.
- **Runs from before signing in** (made in the same browser) are moved onto the account at sign-in.

Tests: `server/src/auth/auth.test.ts` (fake Google and GitHub, real signed tokens).
Sign in with Apple is deliberately left out (it needs the $99/year Apple Developer Program);
`server/src/auth/apple.test.ts` checks it stays off.
