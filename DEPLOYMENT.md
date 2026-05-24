# APEX Eagle — Deployment

Condensed quick-start. For the full walkthrough (Firebase project setup, Resend signup, custom domains), see [docs/CONFIGURATION.md](docs/CONFIGURATION.md). The older guide still mentions Anthropic and `VITE_GOOGLE_CLIENT_ID` — this file supersedes it for env vars and secrets.

---

## Prerequisites

- GitHub account
- Cloudflare account (free, no credit card)
- Google Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (starts with `AIza...`)
- Resend account + API key from [resend.com](https://resend.com) (starts with `re_...`)
- Firebase project with Google sign-in enabled — see "Firebase setup" below

---

## Firebase setup (one-time)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. After the project is created → **Project settings** (gear icon) → **Your apps** → click the **`</>` Web** icon → register the app. Copy the `apiKey`, `authDomain`, `projectId`, and `appId` values.
3. **Authentication** → **Sign-in method** → enable **Google**.
4. **Authentication** → **Settings** → **Authorized domains** → add your Pages domain (e.g. `apex-eagle.pages.dev`) once it exists.

No Google Cloud Console or OAuth client ID setup is required — Firebase handles it.

---

## Deploy the web app (Cloudflare Pages)

1. In Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → pick your fork of `apex-eagle`.
2. Build settings:
   - Framework preset: **None** (or Vite)
   - Build command: `npm run build`
   - Build output directory: `dist`
3. **Settings → Environment Variables** (Production + Preview):

   | Variable | Value | Required |
   |---|---|---|
   | `VITE_FIREBASE_API_KEY` | Firebase web API key (`AIza...`) | Yes |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `<project-id>.firebaseapp.com` | Yes |
   | `VITE_FIREBASE_PROJECT_ID` | Firebase project id | Yes |
   | `VITE_FIREBASE_APP_ID` | Firebase web app id | Yes |
   | `VITE_SPECIAL_USER_KEY` | Gemini key for `ingo.taraske@gmail.com` (skips BYOK prompt) | Optional |

   Every push to `main` triggers a rebuild.

> No `VITE_GOOGLE_CLIENT_ID` is needed. Older docs mention it — that was a mistake; the app uses Firebase Auth, not Google Identity Services directly.

---

## Deploy the scheduler (Cloudflare Worker)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Worker** → **Connect to Git** → same repo.
2. Entry point: `worker/scheduler.js`.
3. **Settings → Triggers → Cron Triggers** — add both:
   - `0 6 * * 1` (Monday 06:00 UTC)
   - `0 6 * * 3` (Wednesday 06:00 UTC)
4. **Settings → Variables and Secrets → Secrets**:

   | Secret | Value |
   |---|---|
   | `GEMINI_API_KEY` | Google Gemini API key (`AIza...`) |
   | `RESEND_API_KEY` | Resend key (`re_...`) |

5. (Optional) plain-text env vars:

   | Variable | Default | Description |
   |---|---|---|
   | `RECIPIENT_EMAIL` | `ingo.taraske@gmail.com` | Where to send alerts |
   | `FROM_EMAIL` | `APEX Eagle <apex@resend.dev>` | Sender |
   | `BUDGET` | `10000` | Portfolio budget in USD |
   | `LEVERAGE` | `2` | Max leverage (1–5) |

---

## First-time use

1. Open your Pages URL.
2. Sign in with Google.
3. Paste your Gemini API key (`AIza...`) — saved only in this browser's `localStorage`.
4. Settings tab → add or remove tickers, create your own categories, set Portfolio Budget and Risk Per Trade (both persist).
5. Tap **▶ ANALYZE NOW**.

---

## Manual trigger

To fire the scheduler without waiting for cron:

```
https://<your-worker-subdomain>.workers.dev/trigger?secret=<YOUR_GEMINI_API_KEY>
```

The Gemini API key doubles as the manual-trigger auth token.

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Build fails on Cloudflare Pages | Check build logs; verify `package.json` is in repo root |
| "Firebase is not configured" on login screen | Recheck the four `VITE_FIREBASE_*` env vars and redeploy |
| "Invalid API key" when saving Gemini key | Key must start with `AIza`. Verify it works at [aistudio.google.com](https://aistudio.google.com) |
| Worker not firing on cron | Verify cron expressions in **Settings → Triggers**; crons run in UTC |
| No email arrives | The Worker only emails when at least one BUY signal has confidence ≥65%. Check the Worker's **Logs** tab |
| Email in spam | Mark as not spam, or set up a custom domain in Resend |
| Worker uses hardcoded assets (AMD/NVDA/GOOGL) instead of my watchlist | Known limitation — the scheduler has no per-user state. The watchlist UI affects the web app only |

---

## Architecture

```
GitHub repo
   ├── Push to main
   │       ↓
   │   Cloudflare Pages ── auto-build React app ── apex-eagle.pages.dev
   │
   └── Cloudflare Worker ── auto-redeploy scheduler.js
           ├── Cron: Mon 06:00 UTC
           ├── Cron: Wed 06:00 UTC
           ▼
       Gemini 2.5 Pro (Google Search grounding)
       + Gemini 2.5 Flash grader (outcome loop)
           ▼ BUY signal found (conf ≥ 65%)
       Resend API ── HTML email ── recipient
```
