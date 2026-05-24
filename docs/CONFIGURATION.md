# APEX Eagle — Configuration Guide

Complete step-by-step setup from zero to a live web app with scheduled email alerts.

---

## Prerequisites

- A GitHub account
- A Cloudflare account (free — no credit card required for Pages)
- An Anthropic API account with a key (`sk-ant-api03-…`)
- A Resend account with a key (`re_…`)
- ~30 minutes

---

## Part 1 — Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign in or create an account
3. Navigate to **API Keys** → **Create Key**
4. Name it `apex-eagle` and copy the key — you will not see it again
5. **Important:** Go to **Settings → Limits** and set a monthly spend cap (e.g. $20) to prevent runaway costs
6. Keep this key — you will need it in Part 3 (Worker secrets) and Part 5 (BYOK in the web app)

---

## Part 2 — Resend API key

1. Go to [resend.com](https://resend.com) and sign up (free, no credit card)
2. Verify your email address
3. Dashboard → **API Keys** → **Create API Key**
4. Name it `apex-eagle-scheduler` and copy the key (`re_…`)
5. **Sender email:** On the free plan, emails are sent from `apex@resend.dev` by default. This works immediately with no DNS setup. If you want to send from your own domain, go to **Domains** → **Add Domain** and follow the DNS instructions — but this is optional.

---

## Part 3 — Cloudflare Pages (web app)

### 3.1 Create a Cloudflare account

1. Go to [cloudflare.com](https://cloudflare.com) → **Sign Up** (free, no credit card needed)
2. Verify your email

### 3.2 Set Cloudflare Pages environment variables

Before deploying, set these in Cloudflare Pages → your project → **Settings → Environment Variables**:

| Variable | Value | Required |
|---|---|---|
| `VITE_GOOGLE_CLIENT_ID` | Your Google OAuth Client ID | Yes |
| `VITE_SPECIAL_USER_KEY` | Anthropic key for ingo.taraske@gmail.com (skips BYOK prompt) | Optional |

Both are injected at **build time** by Vite. They are embedded in the compiled JS bundle — do not put secrets you want completely hidden here. The special user key is only a convenience; if you prefer, leave `VITE_SPECIAL_USER_KEY` blank and ingo.taraske@gmail.com will be prompted for a key like everyone else.

### 3.3 Connect your GitHub repo to Cloudflare Pages

1. In Cloudflare dashboard → **Workers & Pages** → **Create**
2. Choose **Pages** tab → **Connect to Git**
3. Authorize Cloudflare to access your GitHub account
4. Select the `apex-eagle` repository
5. Set build settings:
   - **Framework preset:** None (or Vite)
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** `/` (leave empty)
6. Click **Save and Deploy**

Cloudflare will build and deploy the app. Every push to `main` triggers an automatic rebuild. You get a URL like `apex-eagle.pages.dev`.

### 3.3 (Optional) Custom domain

1. In your Pages project → **Custom domains** → **Set up a custom domain**
2. Enter your domain and follow DNS instructions
3. Cloudflare provisions HTTPS automatically

---

## Part 4 — Cloudflare Worker (scheduler)

### 4.1 Create the Worker and connect to GitHub

1. In Cloudflare dashboard → **Workers & Pages** → **Create**
2. Choose **Worker** tab → **Connect to Git** (same GitHub integration)
3. Select the same `apex-eagle` repository
4. Set entry point:
   - **Entry point / main module:** `worker/scheduler.js`
5. Click **Deploy**

Every push to `main` will also redeploy the Worker automatically.

### 4.2 Add cron triggers

1. Go to your Worker → **Settings** → **Triggers** → **Cron Triggers**
2. Add the following two cron expressions:
   - `0 6 * * 1` → Monday 06:00 UTC (07:00 CET / 08:00 CEST)
   - `0 6 * * 3` → Wednesday 06:00 UTC (07:00 CET / 08:00 CEST)
3. Click **Add**

> **Timezone note:** Cron triggers run in UTC. `0 6 * * 1` fires at 07:00 CET (UTC+1) in winter and 08:00 CEST (UTC+2) in summer. If you want strict 07:00 year-round, change the summer cron to `0 5 * * 1` and `0 5 * * 3` during daylight saving time (last Sunday of March to last Sunday of October).

### 4.3 Set Worker secrets

Secrets are encrypted and never visible after saving — not in logs, not in the dashboard.

1. Go to your Worker → **Settings** → **Variables and Secrets**
2. Under **Secrets**, click **Add secret** for each:

| Secret name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic key (`sk-ant-api03-…`) |
| `RESEND_API_KEY` | Your Resend key (`re_…`) |

3. Click **Deploy** to apply

### 4.4 (Optional) Environment variables

These are optional overrides with sensible defaults:

| Variable | Default | Description |
|---|---|---|
| `RECIPIENT_EMAIL` | `ingo.taraske@gmail.com` | Where to send alerts |
| `FROM_EMAIL` | `APEX Eagle <apex@resend.dev>` | Sender address |
| `BUDGET` | `10000` | Portfolio budget in USD |
| `LEVERAGE` | `2` | Default leverage (1–5) |

Set these under **Settings → Variables and Secrets → Environment Variables** (plain text, not secrets).

---

## Part 5 — Web app first use (BYOK)

The web app uses a "bring your own key" pattern — your Anthropic key is stored only in your browser's `localStorage` and never sent to any server other than Anthropic directly.

1. Open your Pages URL (e.g. `apex-eagle.pages.dev`)
2. On first load, the app will prompt for your Anthropic API key
3. Paste your key (`sk-ant-api03-…`) and confirm
4. The key is saved in localStorage — you only need to do this once per browser
5. Select assets, set budget/risk/leverage, hit **▶ ANALYZE NOW**

> **Security note:** The app calls Anthropic directly from the browser using the `anthropic-dangerous-direct-browser-access: true` header (required for CORS). This is safe for personal single-user use. Do not share your Pages URL publicly if you want to keep your key private — anyone who visits can open devtools and read localStorage.

---

## Part 6 — Testing the scheduler manually

You can trigger the Worker manually without waiting for Monday:

```
https://<your-worker-subdomain>.workers.dev/trigger?secret=<YOUR_ANTHROPIC_API_KEY>
```

Replace `<your-worker-subdomain>` with your Worker's subdomain (visible in the Worker dashboard) and `<YOUR_ANTHROPIC_API_KEY>` with your actual key (this acts as auth for the manual trigger).

The Worker will run the full analysis and send an email if BUY signals are found. Check the Worker's **Logs** tab in the dashboard for real-time output.

---

## Part 7 — Verifying email delivery

1. Trigger the Worker manually (Part 6)
2. Check `ingo.taraske@gmail.com` — the email arrives in ~1–2 minutes
3. If no email arrives:
   - Check the Worker logs (Dashboard → your Worker → **Logs**)
   - Common issues: wrong `RESEND_API_KEY`, Resend account not verified, no BUY signals found (Worker only sends email when BUY signals with ≥65% confidence are found)
4. Check your spam folder — first emails from `resend.dev` sometimes land there; mark as "not spam"

---

## Architecture overview

```
GitHub repo (apex-eagle)
    │
    ├── Push to main
    │       ↓
    │   Cloudflare Pages ──── auto-build React app ──── apex-eagle.pages.dev
    │
    └── Cloudflare Worker ─── auto-redeploy scheduler.js
            │
            ├── Cron: Mon 06:00 UTC
            ├── Cron: Wed 06:00 UTC
            │
            ▼
        Claude Sonnet (web search)
        + Haiku grader (outcome loop)
            │
            ▼ BUY signal found (conf ≥ 65%)
        Resend API ──── HTML email ──── ingo.taraske@gmail.com
```

---

## Updating the app

**To update the React app or Worker:**
1. Edit the file in your repo
2. Push to `main`
3. Cloudflare Pages and the Worker both redeploy automatically within ~60 seconds

**To rotate secrets:**
1. Generate a new key (Anthropic Console or Resend dashboard)
2. Go to your Worker → Settings → Variables and Secrets
3. Click the pencil icon next to the secret → paste new value → Save
4. Update localStorage in your browser: open the app → clear the old key → enter the new one

---

## Troubleshooting

| Issue | Solution |
|---|---|
| Build fails on Cloudflare Pages | Check build logs. Usually a missing `node_modules` — ensure `package.json` is in root |
| Worker not triggering on schedule | Check cron syntax in **Settings → Triggers**. Crons run in UTC |
| No email sent | Worker only emails when BUY signals with conf ≥ 65% exist. Check Worker logs for "No qualifying BUY signals" |
| Email in spam | Mark as "not spam". Consider adding a custom domain in Resend |
| `anthropic-dangerous-direct-browser-access` error | Ensure the web app is calling the Anthropic API with this header — it is included in App.jsx by default |
| CORS error in web app | This header is required and already set in the app. If you see this, the key may be invalid |
| Worker error emails | The Worker sends itself an error email if it crashes — check your inbox for the subject "APEX Eagle ⚠ Scheduler Error" |
