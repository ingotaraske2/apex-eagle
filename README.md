# APEX Eagle 🦅

> AI-powered day trading co-pilot — with scheduled email alerts

APEX Eagle is a React app that generates AI trade signals using live web search, institutional flow analysis, candlestick chart analysis, and an outcome-loop quality gate (Gemini 3.5 Flash agent + Gemini 2.5 Flash grader). The watchlist is fully user-managed — add or remove tickers, organize them into your own categories, and persist portfolio value and risk factor across sessions. It runs as a web app you use manually, **and** as a scheduled Cloudflare Worker that emails you BUY signals every Monday and Wednesday at 07:00 CET.

---

## What it does

**Web app (manual use)**
- Manage your own watchlist — add, remove, and group tickers into user-defined categories
- Set portfolio budget, risk % (1–5%), and max leverage (up to 5×) — persisted in your browser
- Hit Analyze → gets live prices, dark pool, options flow, institutional signals
- Outcome loop: Gemini 3.5 Flash generates signals, Gemini 2.5 Flash grader verifies quality (up to 3 iterations)
- Shows candlestick chart, RSI, SMA20/50, position sizing, SL/TP levels, sentiment summary

**Scheduler (automatic)**
- Runs every Monday and Wednesday at 06:00 UTC (07:00 CET)
- Analyzes AMD, NVDA, GOOGL in aggressive mode (3% risk)
- If any BUY signal with confidence ≥ 65% is found → sends a detailed HTML email

---

## Repository structure

```
apex-eagle/
├── src/
│   ├── App.jsx           ← React app (APEX Eagle v4)
│   └── main.jsx          ← Vite entry point
├── worker/
│   └── scheduler.js      ← Cloudflare Worker cron script
├── wrangler.toml         ← Worker config + cron schedule
├── package.json
├── vite.config.js
├── index.html
├── README.md             ← this file
└── docs/
    └── CONFIGURATION.md  ← full setup guide
```

---

## Quick start

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the condensed deployment guide and **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** for the full walkthrough (note: the older CONFIGURATION.md still references Anthropic — DEPLOYMENT.md is the source of truth for current env vars).

**In brief:**
1. Fork or clone this repo
2. Connect to Cloudflare Pages (GitHub native integration) — set `VITE_FIREBASE_*` env vars
3. Connect Worker to same repo with `worker/scheduler.js` as entry point
4. Set 2 Worker secrets in Cloudflare dashboard: `GEMINI_API_KEY` and `RESEND_API_KEY`
5. Open the deployed app → sign in with Google → paste your Gemini API key when prompted → start trading

---

## Cost

| Component | Free tier |
|---|---|
| Cloudflare Pages | Free, unlimited bandwidth |
| Cloudflare Worker + Cron | 100K req/day free, cron free |
| Resend | 3,000 emails/month free |
| Gemini API | Generous free tier + pay-as-you-go (~$0.01–0.05/run on Flash models) |

---

## Tech stack

- **Frontend:** React 18 + Vite
- **Charts:** HTML Canvas (no charting library)
- **AI:** Google Gemini 3.5 Flash (signals + enrichment) · Gemini 2.5 Flash (grader)
- **Auth:** Firebase Google OAuth
- **Scheduler:** Cloudflare Worker + Cron Triggers
- **Email:** Resend
- **Hosting:** Cloudflare Pages

---

## Risk disclosure

AI signals are for informational purposes only. Day trading involves substantial risk of loss. Past performance does not guarantee future results. Never invest more than you can afford to lose. All trades are executed manually on your broker of choice.
