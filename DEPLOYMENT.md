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

## Using the web app

### Accessing the site

- **Default URL:** `https://<your-pages-project>.pages.dev/` (Cloudflare assigns this when the Pages project is created — visible in the Pages dashboard).
- **Path:** the entire app is served at the root path `/`. It's a single-page React app — Signals / Settings / Portfolio are in-app tabs (React state), not separate URL routes. There are no other paths on the Pages domain.
- **Custom domain (optional):** Pages project → **Custom domains** → **Set up a custom domain** → follow the DNS instructions. HTTPS is provisioned automatically.
- **Authorized domains:** every domain you serve from must be added in Firebase → **Authentication → Settings → Authorized domains**, otherwise Google sign-in will fail with `auth/unauthorized-domain`.

> The only non-root path in the deployment is `GET /trigger` on the **Worker** subdomain (`*.workers.dev`) — see [Manual trigger](#manual-trigger). It is not on the Pages site.

The app works on desktop and mobile browsers — the UI adapts to phone widths.

### First-time setup (per browser)

1. Open the URL and click **Sign in with Google** → choose your Google account in the popup.
2. The app prompts for a Gemini API key. Grab one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (free tier is enough to start), paste it, click **Continue →**. It is validated against `gemini-2.5-flash` and then stored in `localStorage` — only this browser has it.
3. You land on the Signals tab with an empty state. Bottom navigation:
   - **📊 Signals** — current results + outcome-loop status
   - **⚙️ Settings** — watchlist, budget, risk, leverage, key management
   - **📋 Portfolio** — sentiment gauge, risk summary, signal history
   - **▶ ANALYZE** — runs the analysis (also reachable from the empty state)

### Managing your watchlist (Settings tab)

The watchlist starts with two seeded categories — **AI** (`NVDA`, `MSFT`, `GOOGL`, `META`, `AMD`, `PLTR`, `SMCI`, `SOUN`) and **Energy & Commodities** (`XOM`, `CVX`, `COP`, `OXY`, `SLB`, `BP`, `FANG`, `Gold`, `CrudeOil`). Everything is editable:

- **Toggle a ticker for analysis:** click the ticker pill. Cyan = selected, grey = available but not selected.
- **Remove a ticker from a category:** click the small `✕` on the right side of the pill. If the ticker is in another category too, it stays available there; otherwise it disappears from your universe.
- **Add a ticker:** type in the dashed `+ TICKER` input at the end of the row → press Enter or click **Add**. Input is auto-uppercased and deduped within the row.
- **Rename a category:** click the category name (the `✎` icon hints at it) → type the new name.
- **Delete a category:** click the `✕` button on the right side of the category header → confirm. Tickers that exist only in that category are removed from your universe.
- **Add a new category:** click **+ Add category** at the bottom of the watchlist → enter a name.

All changes save instantly to `localStorage`. Reloading the page restores categories, selection, budget, and risk exactly as you left them.

### Setting portfolio parameters

Below the watchlist:

- **Portfolio Budget** — total capital in USD used for position sizing. Persists.
- **Risk Per Trade** — `1%` Conservative · `2%` Moderate · `3%` Aggressive · `5%` High Risk. Persists.
- **Max Leverage** — slider 1× to 5×. Not persisted (resets to 2× on reload — intentional safety default).

The Analysis Summary panel underneath shows the count of selected assets, your current parameters, and the max loss per trade.

### Running an analysis

1. Make sure at least one ticker is selected (cyan pill).
2. Tap **▶ ANALYZE NOW** in the Settings tab — or the **▶ ANALYZE** button in the bottom nav from any tab.
3. A progress bar appears at the top of the screen. The outcome loop runs up to 3 iterations:
   - **Gemini 2.5 Pro** generates signals using Google Search grounding for live prices, dark-pool prints, options flow, institutional bias, and recent news.
   - **Gemini 2.5 Flash** grader scores the result against the 6-criterion rubric (opportunity found, confidence ≥65%, tight stop-loss, R:R ≥1.5, specific entry, valid current price).
   - If the grader passes (or just the "goal met" criteria), iteration stops early.
4. Results land on the **Signals** tab: one card per ticker with action (BUY/SELL/HOLD), confidence, suggested leverage, SL/TP percentages and price levels, RSI, SMA20/50, candlestick chart, position sizing, and reasoning.
5. The **Portfolio** tab fills in with overall market sentiment, total margin in use, and a portfolio-at-risk bar.

A typical run costs ~$0.02–0.10 in Gemini API usage and takes 20–60 seconds depending on iterations.

### Updating your Gemini key

Settings tab → **🔑 Update Gemini API Key** → paste a new key → **Save**. The old key is overwritten in `localStorage`.

### Signing out

Header → **Sign out** (top right). This clears the local Google session and your `localStorage` (user + Gemini key). Your watchlist, budget, and risk settings remain on this browser unless you also clear site data — they re-attach on next login.

### Privacy & security notes

- Your Gemini API key lives only in this browser's `localStorage`. It is sent directly to `generativelanguage.googleapis.com` — no APEX Eagle server sees it.
- Anyone with access to this browser (devtools → Application → Local Storage) can read the key. Don't share a public Pages URL if you don't want strangers using their own keys on it.
- Firebase Auth means Google sees your sign-in. The app stores your email, name, and avatar URL locally to display them — nothing more.

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
