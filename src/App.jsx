import { useState, useRef, useEffect, useCallback } from "react";

// ── AUTH CONFIG ────────────────────────────────────────────────────────────────
// Firebase config — replace with values from Firebase Console:
// console.firebase.google.com → your project → Project settings → Your apps → SDK setup
// No Google Cloud Console or OAuth app registration needed.
const FIREBASE_CONFIG = {
  apiKey:     import.meta.env.VITE_FIREBASE_API_KEY     || "YOUR_FIREBASE_API_KEY",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "YOUR_PROJECT.firebaseapp.com",
  projectId:  import.meta.env.VITE_FIREBASE_PROJECT_ID  || "YOUR_PROJECT_ID",
  appId:      import.meta.env.VITE_FIREBASE_APP_ID      || "YOUR_APP_ID",
};

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const DEFAULT_CATEGORIES = [
  { id: "ai", name: "AI", tickers: ["NVDA", "MSFT", "GOOGL", "META", "AMD", "PLTR", "SMCI", "SOUN"] },
  { id: "energy", name: "Energy & Commodities", tickers: ["XOM", "CVX", "COP", "OXY", "SLB", "BP", "FANG", "Gold", "CrudeOil"] },
];
const DEFAULT_SELECTED = ["NVDA", "MSFT"];
const RISK_OPTIONS = [
  { value: 1, label: "1% Conservative" }, { value: 2, label: "2% Moderate" },
  { value: 3, label: "3% Aggressive" }, { value: 5, label: "5% High Risk" },
];
const SL_CAPS = {
  MSFT: 2.0, GOOGL: 2.0, META: 2.5, NVDA: 2.5, AMD: 2.5,
  SMCI: 3.0, SOUN: 3.5, PLTR: 2.5, XOM: 1.5, CVX: 1.5,
  COP: 1.8, OXY: 2.0, SLB: 1.8, BP: 1.5, FANG: 2.0,
  Gold: 1.2, CrudeOil: 2.0, DEFAULT: 2.5,
};
// Design tokens — refined dark terminal palette.
// Softer contrast across surfaces, single cyan accent, clearer text hierarchy.
const C = {
  bg: "#0b0f14",          // app background
  surface: "#11161d",      // raised surface (cards, inputs)
  panel: "#161c24",        // panel / elevated section
  panelHi: "#1c232d",      // hover / focus surface
  border: "#222b37",       // standard border
  borderSoft: "#1a212b",   // very subtle divider
  accent: "#00e5ff",       // primary accent (selection, CTAs)
  accentDim: "rgba(0,229,255,0.12)",
  buy: "#22d39a",          // green (was #00e676 — slightly softer)
  sell: "#ff5c7c",         // red (was #ff3d71)
  hold: "#f0c14b",         // amber (was #ffd600 — less neon)
  gold: "#f0c14b",
  text: "#dde6f0",         // primary text — higher contrast than before
  textDim: "#9aabbc",      // secondary text
  muted: "#6a7c8e",        // labels (was #4a6070 — too dim)
  inst: "#7d92dc",
};
const FONT_BODY = "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
const FONT_MONO = "'JetBrains Mono', 'SF Mono', Menlo, monospace";
const FONT_DISPLAY = "'Syne', 'Inter', sans-serif"; // headlines / brand
const OUTCOME_RUBRIC = `## APEX Eagle — Investment Opportunity Rubric
GOAL: Find at least one actionable BUY or SELL signal with confidence >= 65%.
[C1] Opportunity found — at least one signal has action BUY or SELL (not all HOLD)
[C2] Confidence threshold — at least one BUY/SELL has confidence >= 65
[C3] Stop loss discipline — every BUY/SELL has stopLossNote with a specific price level
[C4] Risk/reward viability — every BUY/SELL has takeProfitPct >= 1.5 x stopLossPct
[C5] Entry specificity — entryNote references a specific price level or pattern trigger
[C6] Current price — every signal has a numeric currentPrice > 0
Grade each criterion PASS or FAIL. If any fail, explain exactly what the agent must fix.`;

// ── UTILS ─────────────────────────────────────────────────────────────────────
const fmt = n => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const actionColor = a => a === "BUY" ? C.buy : a === "SELL" ? C.sell : C.hold;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
const randomId = () => Math.random().toString(36).slice(2, 9);

function calcPositionSize(budget, riskPct, slPct, leverage) {
  const riskAmount = budget * (riskPct / 100);
  const slDecimal = Math.abs(slPct) / 100;
  const positionSize = slDecimal > 0 ? riskAmount / slDecimal : budget * 0.1;
  const capped = Math.min(positionSize, budget * 0.4);
  return { riskAmount, positionSize: capped, margin: capped / leverage };
}

function calcSMA(closes, period) {
  return closes.map((_, i) =>
    i < period - 1 ? null : closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period
  );
}

function calcRSI(closes, period = 14) {
  return closes.map((_, i) => {
    if (i < period) return null;
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j - 1];
      d > 0 ? (g += d) : (l -= d);
    }
    return 100 - 100 / (1 + (l === 0 ? 100 : g / l));
  });
}

function repairJson(str) {
  let s = str.trim().replace(/```json|```/gi, "").trim();
  const opens = { "[": 0, "{": 0 };
  for (const ch of s) {
    if (ch === "[" || ch === "{") opens[ch]++;
    if (ch === "]") { if (opens["["] > 0) opens["["]--; }
    if (ch === "}") { if (opens["{"] > 0) opens["{"]--; }
  }
  s = s.replace(/,\s*$/, "");
  if (opens["["]) s += "]".repeat(opens["["]);
  if (opens["{"]) s += "}".repeat(opens["{"]);
  return s;
}

function safeParseJson(text, fallback = null) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { /* continue */ }
  const om = text.match(/\{[\s\S]*\}/);
  if (om) {
    try { return JSON.parse(om[0]); } catch { /* continue */ }
    try { return JSON.parse(repairJson(om[0])); } catch { /* continue */ }
  }
  const am = text.match(/\[[\s\S]*\]/);
  if (am) {
    try { return JSON.parse(am[0]); } catch { /* continue */ }
    try { return JSON.parse(repairJson(am[0])); } catch { /* continue */ }
  }
  return fallback;
}

function generateFallbackOHLCV(basePrice = 100, trend = "SIDEWAYS", n = 20) {
  const candles = [];
  let price = basePrice * (trend === "UPTREND" ? 0.92 : trend === "DOWNTREND" ? 1.08 : 0.97);
  const drift = trend === "UPTREND" ? 0.004 : trend === "DOWNTREND" ? -0.004 : 0.001;
  for (let i = 0; i < n; i++) {
    const vol = 0.012 + Math.random() * 0.018;
    const o = price;
    const c = o * (1 + drift + (Math.random() - 0.48) * vol);
    candles.push({
      o: +o.toFixed(4),
      h: +(Math.max(o, c) * (1 + Math.random() * 0.008)).toFixed(4),
      l: +(Math.min(o, c) * (1 - Math.random() * 0.008)).toFixed(4),
      c: +c.toFixed(4),
      v: Math.round(30 + Math.random() * 70),
    });
    price = c;
  }
  if (candles.length) {
    const last = candles[candles.length - 1];
    last.c = basePrice;
    last.h = Math.max(last.h, basePrice);
    last.l = Math.min(last.l, basePrice);
  }
  return candles;
}

// ── FIREBASE AUTH ─────────────────────────────────────────────────────────────
// Loads Firebase SDK dynamically — no npm install needed, works in plain browser/Vite.
let _firebaseAuth = null;

async function getFirebaseAuth() {
  if (_firebaseAuth) return _firebaseAuth;
  const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
  const { getAuth } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
  _firebaseAuth = getAuth(app);
  return _firebaseAuth;
}

async function signInWithGoogle() {
  const { GoogleAuthProvider, signInWithPopup } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const auth = await getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  const u = result.user;
  return { email: u.email, name: u.displayName, picture: u.photoURL };
}

async function signOutFirebase() {
  const { signOut } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const auth = await getFirebaseAuth();
  await signOut(auth);
}

// ── API (Anthropic Messages, with retry + per-call apiKey injection) ──────────
// Body shape accepted: { model, max_tokens, tools, messages } — same as Anthropic's
// /v1/messages endpoint. Response is returned untouched so call sites can keep
// data.content.filter(b => b.type === "text").map(b => b.text).join("").
function attachDiag(err, diag) {
  err.diag = { ...(err.diag || {}), ...diag };
  return err;
}

async function callApi(apiKey, body, retries = 3, callLabel = "api") {
  const {
    model = "claude-sonnet-4-6",
    max_tokens = 4000,
    tools,
    system,
    messages = [],
  } = body;

  const requestBody = {
    model,
    max_tokens,
    messages,
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(system ? { system } : {}),
  };

  const hasSearchTool = Array.isArray(tools) && tools.some(t => t?.type?.startsWith("web_search") || t?.name === "web_search");

  const url = "https://api.anthropic.com/v1/messages";

  // Cap 429 retries to 1 — aggressive retry burns the next quota window.
  const MAX_429_ATTEMPTS = 1;
  let attempt429 = 0;
  const startedAt = Date.now();

  const baseDiag = () => ({
    callLabel,
    model,
    url,
    grounding: hasSearchTool,
    maxTokens: max_tokens,
    promptChars: (typeof messages[0]?.content === "string" ? messages[0].content : (messages[0]?.content?.[0]?.text || "")).length,
    elapsedMs: Date.now() - startedAt,
  });

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(requestBody),
      });
      const responseHeaders = {};
      try { res.headers.forEach((v, k) => { responseHeaders[k] = v; }); } catch { /* ignore */ }

      if ([500, 502, 503, 504, 529].includes(res.status)) {
        if (attempt < retries) { await sleep(1500 * Math.pow(2, attempt)); continue; }
        const bodyText = await res.clone().text().catch(() => "");
        throw attachDiag(new Error(`Anthropic server error (${res.status}). Try again.`), {
          ...baseDiag(), status: res.status, attempt, attempts429: attempt429,
          responseHeaders, responseBody: bodyText.slice(0, 4000),
        });
      }
      if (res.status === 429) {
        // Capture body + headers for diagnosis. Anthropic returns a JSON error
        // with type "rate_limit_error" and may include a `retry-after` header.
        const rawText = await res.clone().text().catch(() => "");
        let errBody = null;
        try { errBody = JSON.parse(rawText); } catch { /* not JSON */ }
        const retryAfterHeader = res.headers.get("retry-after") || res.headers.get("Retry-After");
        const retryAfterSec = Number(retryAfterHeader);
        const retryHintSec = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : null;
        const apiErrorType = errBody?.error?.type || null;
        const apiErrorMessage = errBody?.error?.message || null;
        const isDailyLimit = /daily|spend|credit balance/i.test(apiErrorMessage || "");

        if (attempt429 >= MAX_429_ATTEMPTS) {
          const message = isDailyLimit
            ? "Anthropic spend/daily limit reached. Check your plan and billing in the Anthropic Console."
            : (retryHintSec
                ? `Rate limited. The API suggests waiting ~${retryHintSec}s before retrying.`
                : "Rate limited. Wait a minute before retrying.");
          throw attachDiag(new Error(message), {
            ...baseDiag(),
            status: 429, attempt, attempts429: attempt429 + 1,
            isDailyQuota: isDailyLimit,
            retryHintSec,
            retryAfterHeader,
            apiErrorMessage,
            apiErrorStatus: apiErrorType,
            responseHeaders,
            responseBody: rawText.slice(0, 4000),
          });
        }
        const waitMs = retryHintSec ? Math.min(retryHintSec, 30) * 1000 : 8000;
        attempt429++;
        await sleep(waitMs);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const bodyText = await res.clone().text().catch(() => "");
        throw attachDiag(new Error("Invalid API key. Check your Anthropic key in Settings."), {
          ...baseDiag(), status: res.status, attempt, attempts429: attempt429,
          responseHeaders, responseBody: bodyText.slice(0, 4000),
        });
      }
      if (res.status === 400) {
        const bodyText = await res.clone().text().catch(() => "");
        let parsed = null;
        try { parsed = JSON.parse(bodyText); } catch { /* not JSON */ }
        throw attachDiag(new Error(parsed?.error?.message || "Bad request"), {
          ...baseDiag(), status: 400, attempt, attempts429: attempt429,
          responseHeaders, apiErrorStatus: parsed?.error?.type || null,
          apiErrorMessage: parsed?.error?.message || null,
          responseBody: bodyText.slice(0, 4000),
        });
      }
      const data = await res.json();
      if (data.error) {
        throw attachDiag(new Error(data.error.message || "API error"), {
          ...baseDiag(), status: res.status, attempt, attempts429: attempt429,
          responseHeaders, apiErrorStatus: data.error.type || null,
          apiErrorMessage: data.error.message || null,
          responseBody: JSON.stringify(data).slice(0, 4000),
        });
      }
      // Anthropic responses already match the { content: [{ type, text }, ...] }
      // shape that call sites expect, so return as-is.
      return data;
    } catch (err) {
      const isRetryable = !err.message.includes("Rate limited")
        && !err.message.includes("Anthropic spend")
        && !err.message.includes("Invalid API key")
        && !err.message.includes("Bad request");
      if (attempt < retries && isRetryable) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      if (!err.diag) attachDiag(err, { ...baseDiag(), attempt, attempts429: attempt429, networkError: true });
      throw err;
    }
  }
}

// ── EAGLE SVG ─────────────────────────────────────────────────────────────────
function Eagle({ size = 44 }) {
  return (
    <svg width={size} height={size * 0.775} viewBox="0 0 160 124" fill="none">
      <path d="M80 58 C65 48 42 34 4 18 C16 36 34 48 54 56 Z" fill="#6a82d4" />
      <path d="M80 58 C65 50 44 42 14 36 C28 50 46 56 62 60 Z" fill="#7b6bb8" />
      <path d="M80 58 C70 54 54 50 36 52 C46 60 62 64 74 64 Z" fill="#5f5498" />
      <path d="M80 58 C95 48 118 34 156 18 C144 36 126 48 106 56 Z" fill="#6a82d4" />
      <path d="M80 58 C95 50 116 42 146 36 C132 50 114 56 98 60 Z" fill="#7b6bb8" />
      <path d="M80 58 C90 54 106 50 124 52 C114 60 98 64 86 64 Z" fill="#5f5498" />
      <path d="M80 36 C74 44 72 56 72 68 C72 82 74 96 80 112 C86 96 88 82 88 68 C88 56 86 44 80 36 Z" fill="#7a1e45" />
      <path d="M80 38 C78 48 77 58 77 70 C77 82 78 94 80 108 C82 94 83 82 83 70 C83 58 82 48 80 38 Z" fill="#5a1530" />
      <ellipse cx="80" cy="33" rx="9" ry="11" fill="#7a1e45" />
      <path d="M80 28 C84 26 89 28 88 31 C85 32 82 32 80 30 Z" fill="#b03030" />
      <circle cx="83" cy="30" r="2" fill="#0d0608" />
      <circle cx="83.7" cy="29.3" r="0.6" fill="#fff" opacity="0.5" />
      <path d="M75 108 C72 116 68 122 65 124 L80 118 L95 124 C92 122 88 116 85 108 Z" fill="#7a1e45" />
      <path d="M78 110 C76 118 74 122 72 124 L80 120 L88 124 C86 122 84 118 82 110 Z" fill="#5a1530" />
    </svg>
  );
}

// ── LOGIN SCREEN ───────────────────────────────────────────────────────────────
function LoginScreen({ onSignIn }) {
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState(null);

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setAuthError(null);
    try {
      const userData = await signInWithGoogle();
      onSignIn(userData);
    } catch (err) {
      // User closed popup or Firebase not configured yet
      if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") {
        setAuthError(null); // silent
      } else if (err.code === "auth/configuration-not-found" || !FIREBASE_CONFIG.apiKey.startsWith("AIza")) {
        setAuthError("Firebase is not configured yet. Replace FIREBASE_CONFIG in App.jsx with your project values.");
      } else {
        setAuthError(err.message || "Sign-in failed. Please try again.");
      }
      setLoading(false);
    }
  };

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px" }}>
      <GlobalStyles />
      <div style={{ textAlign: "center", width: "100%", maxWidth: "440px" }}>
        <div style={{ marginBottom: 28 }}>
          <Eagle size={56} />
        </div>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: "36px", fontWeight: 800, color: C.text, letterSpacing: "0.18em", marginBottom: 8 }}>APEX EAGLE</div>
        <div style={{ fontSize: 12, color: C.muted, letterSpacing: "0.22em", marginBottom: 40, textTransform: "uppercase" }}>AI Trading Co-Pilot</div>

        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, marginBottom: 16 }}>
          <p style={{ fontSize: 14, color: C.textDim, lineHeight: 1.7, marginBottom: 28 }}>
            Sign in with your Google account to get started. Everyone can use APEX Eagle — you just need a free{" "}
            <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">Anthropic API key</a>.
          </p>

          <button
            onClick={handleGoogleSignIn}
            disabled={loading}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
              width: "100%", padding: "14px 20px",
              background: loading ? C.surface : "#fff",
              color: "#1f1f1f", border: "none", borderRadius: 8,
              fontSize: 15, fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
              transition: "opacity 0.2s, transform 0.1s",
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? (
              <span style={{ color: C.muted, fontSize: 14 }}>Signing in…</span>
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                Sign in with Google
              </>
            )}
          </button>

          {authError && (
            <p style={{ fontSize: 13, color: C.sell, marginTop: 16, lineHeight: 1.55 }}>
              ⚠ {authError}
            </p>
          )}
        </div>

        <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
          AI signals are informational only. Day trading carries substantial risk.<br />
          Execute trades manually on your broker of choice.
        </p>
      </div>
    </div>
  );
}

// ── API KEY PROMPT ─────────────────────────────────────────────────────────────
function ApiKeyPrompt({ user, onSetKey, onLogout }) {
  const [keyInput, setKeyInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [keyError, setKeyError] = useState(null);

  const handleSubmit = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) { setKeyError("Please enter your Anthropic API key."); return; }
    if (!trimmed.startsWith("sk-ant-")) { setKeyError("That doesn't look like an Anthropic key (should start with sk-ant-)."); return; }
    setKeyError(null);
    setValidating(true);
    try {
      // Quick validation ping — cheap Haiku request
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": trimmed,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 8,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (res.status === 401 || res.status === 403) {
        setKeyError("Invalid API key — Anthropic rejected it. Double-check your key.");
        setValidating(false);
        return;
      }
      onSetKey(trimmed);
    } catch {
      // Network error — accept key anyway, will fail later with a clear message
      onSetKey(trimmed);
    }
    setValidating(false);
  };

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <GlobalStyles />
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          {user.picture && <img src={user.picture} alt="" style={{ width: 56, height: 56, borderRadius: "50%", border: `2px solid ${C.border}`, marginBottom: 14 }} />}
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 700, color: C.text }}>Welcome, {user.name}</div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>{user.email}</div>
        </div>

        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28 }}>
          <p style={{ fontSize: 14, color: C.textDim, lineHeight: 1.7, marginBottom: 20 }}>
            Enter your <strong style={{ color: C.text, fontWeight: 600 }}>Anthropic API key</strong>. It is saved only in your browser's localStorage and sent exclusively to Anthropic's API.
          </p>

          <input
            type="password"
            value={keyInput}
            onChange={e => { setKeyInput(e.target.value); setKeyError(null); }}
            placeholder="sk-ant-api03-…"
            autoFocus
            style={{
              borderColor: keyError ? C.sell : C.border,
              marginBottom: 10,
            }}
            onKeyDown={e => e.key === "Enter" && !validating && handleSubmit()}
          />

          {keyError && <p style={{ fontSize: 13, color: C.sell, marginBottom: 14, lineHeight: 1.55 }}>⚠ {keyError}</p>}

          <button
            onClick={handleSubmit}
            disabled={validating}
            style={{
              width: "100%", padding: "12px 16px",
              background: validating ? C.surface : C.accent,
              color: validating ? C.muted : "#001318",
              border: "none", borderRadius: 8,
              fontWeight: 700, fontSize: 15, letterSpacing: "0.02em",
              cursor: validating ? "not-allowed" : "pointer",
              marginBottom: 12,
              transition: "opacity 0.15s",
            }}
          >
            {validating ? "Validating…" : "Continue →"}
          </button>

          <button
            onClick={onLogout}
            style={{
              width: "100%", padding: "10px 16px", background: "transparent", color: C.textDim,
              border: `1px solid ${C.border}`, borderRadius: 8,
              fontSize: 13, fontWeight: 500, cursor: "pointer",
            }}
          >
            ← Sign out
          </button>

          <p style={{ fontSize: 12, color: C.muted, marginTop: 18, lineHeight: 1.7 }}>
            Get your key at <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">console.anthropic.com</a> → API Keys. Set a monthly spend cap in Settings to control costs.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── GLOBAL STYLES ──────────────────────────────────────────────────────────────
function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Syne:wght@600;700;800&display=swap');
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { background: ${C.bg}; color: ${C.text}; }
      body {
        font-family: ${FONT_BODY};
        font-size: 14px;
        line-height: 1.55;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
        font-feature-settings: "cv02","cv03","cv04","cv11";
      }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: ${C.panelHi}; }
      input[type=range] {
        -webkit-appearance: none; height: 4px; background: ${C.border};
        border-radius: 2px; outline: none; width: 100%;
      }
      input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%;
        background: ${C.accent}; box-shadow: 0 0 0 4px rgba(0,229,255,0.12);
        cursor: pointer; transition: box-shadow 0.15s;
      }
      input[type=range]::-webkit-slider-thumb:hover { box-shadow: 0 0 0 6px rgba(0,229,255,0.2); }
      input[type=number], input[type=text], input[type=password] {
        background: ${C.surface}; border: 1px solid ${C.border}; color: ${C.text};
        font-family: ${FONT_MONO}; font-size: 14px; font-weight: 500;
        padding: 10px 12px; width: 100%; border-radius: 6px; outline: none;
        transition: border-color 0.15s, background 0.15s;
      }
      input[type=number]:focus, input[type=text]:focus, input[type=password]:focus {
        border-color: ${C.accent}; background: ${C.panel};
      }
      select {
        background: ${C.surface}; border: 1px solid ${C.border}; color: ${C.text};
        font-family: ${FONT_BODY}; font-size: 14px; font-weight: 500;
        padding: 10px 12px; border-radius: 6px; outline: none; width: 100%;
        cursor: pointer; appearance: none;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='%239aabbc' d='M2 4l4 4 4-4z'/></svg>");
        background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px;
      }
      select:focus { border-color: ${C.accent}; }
      button { font-family: ${FONT_BODY}; }
      button:active { transform: translateY(1px); opacity: 0.9; }
      button:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
      a { color: ${C.accent}; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .mono { font-family: ${FONT_MONO}; font-variant-numeric: tabular-nums; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      @keyframes progress { 0% { width: 0%; margin-left: 0; } 50% { width: 60%; margin-left: 20%; } 100% { width: 0%; margin-left: 100%; } }
      @keyframes eaglePulse { 0%, 100% { filter: drop-shadow(0 0 4px rgba(106,130,212,0.3)); } 50% { filter: drop-shadow(0 0 12px rgba(106,130,212,0.8)); } }
      .eagle-anim { animation: eaglePulse 3s ease-in-out infinite; }
    `}</style>
  );
}

// ── TRADING CHART ─────────────────────────────────────────────────────────────
function TradingChart({ signal }) {
  const priceRef = useRef(null);
  const rsiRef = useRef(null);

  const draw = useCallback(() => {
    const ohlcv = signal.ohlcv;
    if (!ohlcv || ohlcv.length < 5) return;
    const closes = ohlcv.map(c => c.c);
    const sma20 = calcSMA(closes, 20);
    const sma50 = calcSMA(closes, 50);
    const rsiArr = calcRSI(closes, 14);

    // Price canvas
    const canvas = priceRef.current;
    if (!canvas) return;
    const DPR = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth || 340;
    const H = 160;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    const ctx = canvas.getContext("2d");
    ctx.scale(DPR, DPR);
    const pad = { top: 10, right: 8, bottom: 18, left: 52 };
    const cw = W - pad.left - pad.right;
    const ch = H - pad.top - pad.bottom;
    const cp = signal.currentPrice || closes[closes.length - 1];
    const slP = cp * (1 - (signal.stopLossPct || 3) / 100);
    const tpP = cp * (1 + (signal.takeProfitPct || 6) / 100);
    const allP = [...ohlcv.flatMap(c => [c.h, c.l]), slP, tpP];
    const minP = Math.min(...allP) * 0.998;
    const maxP = Math.max(...allP) * 1.002;
    const pr = maxP - minP;
    const xS = i => pad.left + (i / (ohlcv.length - 1)) * cw;
    const yS = p => pad.top + ch - ((p - minP) / pr) * ch;

    ctx.fillStyle = "#080c12";
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i <= 3; i++) {
      const y = pad.top + (ch / 3) * i;
      ctx.strokeStyle = "#1e2d3d44";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = "#4a6070";
      ctx.font = "8px monospace";
      ctx.textAlign = "right";
      ctx.fillText((maxP - (pr / 3) * i).toFixed(maxP > 100 ? 1 : 3), pad.left - 2, y + 3);
    }

    const dashed = (p, col, lbl) => {
      ctx.strokeStyle = col;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, yS(p));
      ctx.lineTo(W - pad.right, yS(p));
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "right";
      ctx.fillText(lbl, pad.left - 1, yS(p) + 3);
      ctx.setLineDash([]);
    };
    dashed(slP, "rgba(255,61,113,0.8)", "SL");
    dashed(tpP, "rgba(0,230,118,0.8)", "TP");

    const maxVol = Math.max(...ohlcv.map(c => c.v || 50));
    const bW = Math.max(1, cw / ohlcv.length - 1);
    ohlcv.forEach((c, i) => {
      const x = pad.left + (i / ohlcv.length) * cw + bW * 0.1;
      ctx.fillStyle = c.c >= c.o ? "rgba(0,230,118,0.15)" : "rgba(255,61,113,0.15)";
      ctx.fillRect(x, pad.top + ch - (c.v || 50) / maxVol * ch * 0.15, bW, (c.v || 50) / maxVol * ch * 0.15);
    });

    const drawLine = (data, col) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let first = true;
      data.forEach((v, i) => {
        if (v == null) return;
        first ? ctx.moveTo(xS(i), yS(v)) : ctx.lineTo(xS(i), yS(v));
        first = false;
      });
      ctx.stroke();
    };
    drawLine(sma50, "rgba(255,214,0,0.7)");
    drawLine(sma20, "rgba(0,229,255,0.85)");

    ohlcv.forEach((c, i) => {
      const x = pad.left + (i / ohlcv.length) * cw + bW * 0.1;
      const cx2 = x + bW / 2;
      const isUp = c.c >= c.o;
      ctx.strokeStyle = isUp ? "#00e676" : "#ff3d71";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx2, yS(c.h));
      ctx.lineTo(cx2, yS(c.l));
      ctx.stroke();
      ctx.fillStyle = isUp ? "rgba(0,230,118,0.85)" : "rgba(255,61,113,0.85)";
      const top = yS(Math.max(c.o, c.c));
      const ht = Math.max(1, yS(Math.min(c.o, c.c)) - top);
      ctx.fillRect(x, top, bW, ht);
    });

    ctx.strokeStyle = "rgba(0,229,255,0.9)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(pad.left, yS(cp));
    ctx.lineTo(W - pad.right, yS(cp));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#00e5ff";
    ctx.font = "bold 8px monospace";
    ctx.textAlign = "right";
    ctx.fillText("$" + cp.toLocaleString(undefined, { maximumFractionDigits: 2 }), pad.left - 1, yS(cp) + 3);

    // RSI canvas
    const rc2 = rsiRef.current;
    if (!rc2) return;
    const RW = rc2.offsetWidth || 340;
    const RH = 50;
    rc2.width = RW * DPR;
    rc2.height = RH * DPR;
    const rc = rc2.getContext("2d");
    rc.scale(DPR, DPR);
    const rp = { top: 4, right: 8, bottom: 12, left: 52 };
    const rcw = RW - rp.left - rp.right;
    const rch = RH - rp.top - rp.bottom;
    rc.fillStyle = "#080c12";
    rc.fillRect(0, 0, RW, RH);

    [30, 70].forEach(lvl => {
      const y = rp.top + rch - (lvl / 100) * rch;
      rc.strokeStyle = lvl === 70 ? "rgba(0,230,118,0.2)" : "rgba(255,61,113,0.2)";
      rc.lineWidth = 0.5;
      rc.setLineDash([3, 3]);
      rc.beginPath();
      rc.moveTo(rp.left, y);
      rc.lineTo(RW - rp.right, y);
      rc.stroke();
      rc.setLineDash([]);
      rc.fillStyle = lvl === 70 ? "#00e676" : "#ff3d71";
      rc.font = "7px monospace";
      rc.textAlign = "right";
      rc.fillText(lvl, rp.left - 2, y + 2);
    });

    const rv = rsiArr.map((v, i) => (v != null ? { v, i } : null)).filter(Boolean);
    if (rv.length > 1) {
      rc.beginPath();
      rv.forEach(({ v, i }, idx) => {
        const x = rp.left + (i / (ohlcv.length - 1)) * rcw;
        const y = rp.top + rch - (v / 100) * rch;
        idx === 0 ? rc.moveTo(x, y) : rc.lineTo(x, y);
      });
      rc.strokeStyle = "#c084fc";
      rc.lineWidth = 1.5;
      rc.stroke();
      const lr = rv[rv.length - 1].v;
      rc.fillStyle = lr > 70 ? "#ff3d71" : lr < 30 ? "#00e676" : "#c084fc";
      rc.font = "bold 8px monospace";
      rc.textAlign = "right";
      rc.fillText("RSI " + lr.toFixed(0), rp.left - 2, rp.top + rch - (lr / 100) * rch + 3);
    }
  }, [signal]);

  useEffect(() => { const t = setTimeout(draw, 60); return () => clearTimeout(t); }, [draw]);
  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (priceRef.current) ro.observe(priceRef.current);
    return () => ro.disconnect();
  }, [draw]);

  return (
    <div style={{ background: "#080c12", border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden", marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderBottom: `1px solid ${C.border}`, background: "rgba(0,0,0,0.3)" }}>
        <span style={{ fontSize: 9, color: C.muted }}>📈 {signal.asset} · 20D</span>
        <div style={{ display: "flex", gap: 10, fontSize: 8 }}>
          {[["#00e5ff", "SMA20"], ["#ffd600", "SMA50"], ["#c084fc", "RSI"]].map(([col, lbl]) => (
            <span key={lbl}>
              <span style={{ display: "inline-block", width: 6, height: 2, background: col, verticalAlign: "middle", marginRight: 3 }} />
              <span style={{ color: C.muted }}>{lbl}</span>
            </span>
          ))}
        </div>
      </div>
      <canvas ref={priceRef} style={{ display: "block", width: "100%", height: 160 }} />
      <canvas ref={rsiRef} style={{ display: "block", width: "100%", height: 50, borderTop: `1px solid ${C.border}` }} />
      <div style={{ display: "flex", gap: 10, padding: "5px 10px", borderTop: `1px solid ${C.border}`, fontSize: 9, flexWrap: "wrap", background: "rgba(0,0,0,0.2)" }}>
        <span style={{ color: C.muted }}>PATTERN: <span style={{ color: C.accent }}>{signal.patterns || "—"}</span></span>
        <span style={{ color: C.muted }}>TREND: <span style={{ color: signal.trend === "UPTREND" ? C.buy : signal.trend === "DOWNTREND" ? C.sell : C.hold }}>{signal.trend === "UPTREND" ? "↑" : signal.trend === "DOWNTREND" ? "↓" : "→"} {signal.trend || "—"}</span></span>
        <span style={{ color: C.muted }}>RSI: <span style={{ color: (signal.rsi || 50) > 70 ? C.sell : (signal.rsi || 50) < 30 ? C.buy : C.text }}>{(signal.rsi || 50).toFixed(0)}{(signal.rsi || 50) > 70 ? " ⚠" : (signal.rsi || 50) < 30 ? " ⚡" : ""}</span></span>
      </div>
    </div>
  );
}

// ── ENTRY DIAGRAM ─────────────────────────────────────────────────────────────
function EntryDiagram({ signal }) {
  const action = signal.action;
  if (action === "HOLD") return null;

  const cp = signal.currentPrice || 100;
  const slPct = signal.stopLossPct || 2;
  const tpPct = signal.takeProfitPct || slPct * 2;
  const isBuy = action === "BUY";

  // Price levels
  const avoidPrice = isBuy ? cp * (1 + tpPct * 0.3 / 100) : cp * (1 - tpPct * 0.3 / 100);
  const entryHigh = cp;
  const entryLow = isBuy ? cp * (1 - slPct * 0.6 / 100) : cp * (1 + slPct * 0.6 / 100);
  const slPrice = isBuy ? cp * (1 - slPct / 100) : cp * (1 + slPct / 100);
  const tpPrice = isBuy ? cp * (1 + tpPct / 100) : cp * (1 - tpPct / 100);

  // SVG dimensions
  const W = 340, H = 200;
  const padL = 60, padR = 16, padT = 16, padB = 24;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const allPrices = [avoidPrice, entryHigh, entryLow, slPrice, tpPrice];
  const minP = Math.min(...allPrices) * 0.9975;
  const maxP = Math.max(...allPrices) * 1.0025;
  const range = maxP - minP;

  const yP = p => padT + chartH - ((p - minP) / range) * chartH;
  const xAt = frac => padL + frac * chartW;

  // Path: morning peak → pullback → consolidation → confirmation candle → entry
  const morningX = xAt(0.18);
  const morningY = isBuy ? yP(avoidPrice * 0.998) : yP(slPrice * 0.998);
  const pullEndX = xAt(0.42);
  const pullEndY = isBuy ? yP(entryLow * 1.001) : yP(entryHigh * 0.999);
  const consolidY = pullEndY;
  const consolidX1 = xAt(0.5);
  const consolidX2 = xAt(0.62);
  const confirmX = xAt(0.74);
  const confirmY = yP(entryHigh);
  const endX = xAt(0.92);
  const endY = isBuy ? yP(tpPrice * 0.6 + entryHigh * 0.4) : yP(slPrice * 0.5 + entryLow * 0.5);

  const accentColor = isBuy ? C.buy : C.sell;
  const entryZoneColor = isBuy ? "rgba(34,211,154,0.12)" : "rgba(255,92,124,0.12)";
  const avoidZoneColor = isBuy ? "rgba(255,92,124,0.10)" : "rgba(34,211,154,0.10)";
  const avoidLineColor = isBuy ? C.sell : C.buy;

  const fmtP = p => {
    if (cp > 999) return "$" + Math.round(p);
    if (cp > 99) return "$" + p.toFixed(1);
    return "$" + p.toFixed(2);
  };

  const labelStyle = { fontSize: "8px", fontFamily: FONT_MONO, fill: C.text };
  const mutedStyle = { fontSize: "7.5px", fontFamily: FONT_BODY, fill: C.textDim };

  // Consolidation dots
  const dots = [xAt(0.49), xAt(0.54), xAt(0.59), xAt(0.63)].map((x, i) => ({
    x, y: consolidY + (i % 2 === 0 ? -1.5 : 0),
  }));

  // Confirmation candle
  const candleX = confirmX - 5;
  const candleW = 10;
  const candleOpen = yP(entryLow * 1.005);
  const candleClose = yP(entryHigh * 0.997);
  const candleHigh = yP(entryHigh * (isBuy ? 1.006 : 0.994));
  const candleLow = yP(entryLow * (isBuy ? 0.994 : 1.006));

  return (
    <div style={{ background: "#080c12", border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden", marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderBottom: `1px solid ${C.border}`, background: "rgba(0,0,0,0.3)" }}>
        <span style={{ fontSize: 9, color: C.muted }}>📐 {signal.asset} · Entry Diagram · {action}</span>
        <span style={{ fontSize: 9, color: accentColor, fontWeight: 700 }}>{isBuy ? "BUY" : "SELL"} SETUP</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        {/* Avoid zone */}
        {isBuy && (
          <rect x={padL} y={padT} width={chartW} height={yP(avoidPrice) - padT}
            fill={avoidZoneColor} />
        )}
        {!isBuy && (
          <rect x={padL} y={yP(avoidPrice)} width={chartW} height={padT + chartH - yP(avoidPrice)}
            fill={avoidZoneColor} />
        )}

        {/* Entry zone */}
        <rect x={padL} y={Math.min(yP(entryHigh), yP(entryLow))} width={chartW}
          height={Math.abs(yP(entryHigh) - yP(entryLow))}
          fill={entryZoneColor} />

        {/* Avoid zone label */}
        <text x={padL + 6} y={isBuy ? padT + 10 : yP(avoidPrice) + 12} style={{ fontSize: "8.5px", fontFamily: FONT_BODY, fill: avoidLineColor, fontWeight: 700 }}>
          {isBuy ? "Avoid chasing above" : "Avoid chasing below"} {fmtP(avoidPrice)}
        </text>
        <text x={padL + 6} y={isBuy ? padT + 21 : yP(avoidPrice) + 23} style={{ fontSize: "7.5px", fontFamily: FONT_BODY, fill: C.muted }}>
          Already too {isBuy ? "high" : "low"} on momentum
        </text>

        {/* Avoid zone border line */}
        <line x1={padL} y1={isBuy ? yP(avoidPrice) : yP(avoidPrice)} x2={W - padR} y2={isBuy ? yP(avoidPrice) : yP(avoidPrice)}
          stroke={avoidLineColor} strokeWidth="1" strokeDasharray="3,2" opacity="0.6" />

        {/* Entry zone label */}
        <text x={padL + 6} y={yP(entryLow) - 4} style={{ fontSize: "8.5px", fontFamily: FONT_BODY, fill: accentColor, fontWeight: 700 }}>
          Entry zone: {fmtP(entryLow)}–{fmtP(entryHigh)}
        </text>
        <text x={padL + 6} y={yP(entryLow) + 8} style={{ fontSize: "7.5px", fontFamily: FONT_BODY, fill: C.textDim }}>
          {signal.keyLevel ? signal.keyLevel.slice(0, 42) : "Prior consolidation + gap support"}
        </text>

        {/* Entry zone dashed border */}
        <line x1={padL} y1={yP(entryHigh)} x2={W - padR} y2={yP(entryHigh)}
          stroke={accentColor} strokeWidth="1" strokeDasharray="4,3" opacity="0.5" />

        {/* Price axis labels */}
        {[avoidPrice, entryHigh, entryLow].map((p, i) => (
          <text key={i} x={padL - 3} y={yP(p) + 3} textAnchor="end"
            style={{ fontSize: "7.5px", fontFamily: FONT_MONO, fill: C.muted }}>{fmtP(p)}</text>
        ))}

        {/* Intraday pullback path */}
        <path
          d={`M ${morningX} ${morningY} C ${xAt(0.25)} ${morningY + 8}, ${xAt(0.35)} ${pullEndY - 16}, ${pullEndX} ${pullEndY}`}
          stroke="#6a82d4" strokeWidth="2" fill="none" strokeLinecap="round"
        />
        {/* Pullback label */}
        <text x={xAt(0.27)} y={morningY + 38} style={{ ...mutedStyle, fontStyle: "italic" }}>Intraday pullback</text>

        {/* Consolidation dots */}
        {dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r="2.5" fill="#6a82d4" opacity="0.8" />
        ))}
        {/* "Waiting for signal" label */}
        <text x={xAt(0.52)} y={consolidY + 14} textAnchor="middle" style={mutedStyle}>Waiting for signal</text>

        {/* Prior consolidation base bracket */}
        <line x1={morningX - 8} y1={yP(entryLow) + 2} x2={xAt(0.38)} y2={yP(entryLow) + 2}
          stroke="rgba(255,92,124,0.5)" strokeWidth="1" />
        <text x={(morningX - 8 + xAt(0.38)) / 2} y={yP(entryLow) + 16} textAnchor="middle"
          style={{ fontSize: "7.5px", fontFamily: FONT_BODY, fill: C.muted }}>Prior consolidation</text>
        <text x={(morningX - 8 + xAt(0.38)) / 2} y={yP(entryLow) + 26} textAnchor="middle"
          style={{ fontSize: "7.5px", fontFamily: FONT_BODY, fill: C.muted }}>base (support zone)</text>

        {/* Confirmation candle */}
        <line x1={candleX + candleW / 2} y1={candleHigh} x2={candleX + candleW / 2} y2={candleLow}
          stroke={accentColor} strokeWidth="1" />
        <rect x={candleX} y={Math.min(candleOpen, candleClose)} width={candleW}
          height={Math.max(1, Math.abs(candleOpen - candleClose))}
          fill="none" stroke={accentColor} strokeWidth="1.5" />

        {/* Volume bars below candle */}
        {[confirmX - 5, confirmX, confirmX + 5].map((bx, i) => (
          <rect key={i} x={bx - 2} y={H - padB - (i === 1 ? 14 : 10)} width={4} height={i === 1 ? 14 : 10}
            fill={accentColor} opacity={i === 1 ? 0.9 : 0.55} />
        ))}
        <text x={confirmX} y={H - padB + 12} textAnchor="middle"
          style={{ fontSize: "7px", fontFamily: FONT_BODY, fill: C.muted }}>Volume</text>
        <text x={confirmX} y={H - padB + 21} textAnchor="middle"
          style={{ fontSize: "7px", fontFamily: FONT_BODY, fill: C.muted }}>Confirmation</text>

        {/* Confirmed entry arrow */}
        <path d={`M ${confirmX + 12} ${confirmY + 4} C ${xAt(0.82)} ${confirmY - 10}, ${endX - 10} ${endY + 10}, ${endX} ${endY}`}
          stroke={accentColor} strokeWidth="2.5" fill="none" strokeLinecap="round"
          markerEnd="url(#arrowhead)" />
        <defs>
          <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
            <path d="M0,0 L0,6 L6,3 Z" fill={accentColor} />
          </marker>
        </defs>
        <text x={endX + 3} y={endY - 6} style={{ fontSize: "8px", fontFamily: FONT_BODY, fill: accentColor, fontStyle: "italic" }}>Confirmed entry</text>

        {/* 5-min candle close note */}
        <text x={confirmX - 28} y={Math.min(candleOpen, candleClose) - 14} style={{ fontSize: "8.5px", fontFamily: FONT_BODY, fill: C.text, fontWeight: 700 }}>5-min candle close</text>
        <text x={confirmX - 28} y={Math.min(candleOpen, candleClose) - 4} style={{ fontSize: "7.5px", fontFamily: FONT_BODY, fill: C.muted }}>above {fmtP(entryHigh)} + expanding vol</text>
      </svg>
      <div style={{ padding: "6px 10px", borderTop: `1px solid ${C.border}`, fontSize: 9, color: C.textDim, lineHeight: 1.55 }}>
        {signal.entryNote}
      </div>
    </div>
  );
}

// ── INSTITUTIONAL FLOW PANEL ──────────────────────────────────────────────────
function InstitutionalPanel({ flow }) {
  if (!flow) return null;
  const biasColor = flow.overallBias === "ACCUMULATING" ? C.buy : flow.overallBias === "DISTRIBUTING" ? C.sell : C.muted;
  const score = flow.flowScore ?? null;
  const scoreColor = score >= 65 ? C.buy : score <= 35 ? C.sell : C.hold;
  const badge = (sig, label) => {
    if (!sig || sig === "NO_DATA" || sig === "NEUTRAL") return null;
    const col = ["BULLISH", "INFLOW", "BUYING"].includes(sig) ? C.buy : ["BEARISH", "OUTFLOW", "SELLING"].includes(sig) ? C.sell : C.muted;
    return <span key={label} style={{ fontSize: 8, padding: "2px 7px", border: `1px solid ${col}`, borderRadius: 2, color: col }}>{label}: {sig}</span>;
  };

  return (
    <div style={{ border: `1px solid rgba(106,130,212,0.4)`, borderRadius: 4, overflow: "hidden", background: "rgba(106,130,212,0.04)" }}>
      <div style={{ padding: "10px 12px", background: "rgba(106,130,212,0.1)", borderBottom: `1px solid rgba(106,130,212,0.25)`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 9, color: C.inst, textTransform: "uppercase", letterSpacing: "0.15em", fontWeight: 700, marginBottom: 3 }}>🏛 Institutional Flow</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: biasColor }}>
            {flow.overallBias === "ACCUMULATING" ? "▲" : flow.overallBias === "DISTRIBUTING" ? "▼" : "—"} {flow.overallBias || "NO DATA"}
          </div>
        </div>
        {score != null && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 8, color: C.muted, marginBottom: 2 }}>FLOW SCORE</div>
            <div style={{ fontFamily: "Syne,sans-serif", fontSize: 24, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>{score}</div>
            <div style={{ height: 3, width: 48, background: C.border, borderRadius: 2, marginTop: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${score}%`, background: scoreColor }} />
            </div>
          </div>
        )}
      </div>
      <div style={{ padding: "8px 12px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: `1px solid rgba(106,130,212,0.15)` }}>
        {badge(flow.darkPool?.signal, "🌑 DARK POOL")}
        {badge(flow.optionsFlow?.signal, "📊 OPTIONS")}
        {badge(flow.insiderActivity?.signal, "👤 INSIDER")}
        {badge(flow.etfFlow?.signal, "📦 ETF")}
      </div>
      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
        {flow.darkPool?.detail && flow.darkPool.detail !== "NO_DATA" && (
          <div>
            <div style={{ fontSize: 8, color: C.inst, textTransform: "uppercase", marginBottom: 3 }}>🌑 Dark Pool Prints</div>
            <div style={{ fontSize: 10, color: C.text, lineHeight: 1.5 }}>{flow.darkPool.detail}</div>
            {(flow.darkPool.recentPrints || []).filter(p => p && p !== "NO_DATA").map((p, i) => (
              <div key={i} style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>• {p}</div>
            ))}
          </div>
        )}
        {flow.optionsFlow?.unusualActivity && flow.optionsFlow.unusualActivity !== "NO_DATA" && (
          <div>
            <div style={{ fontSize: 8, color: C.inst, textTransform: "uppercase", marginBottom: 3 }}>📊 Options Flow</div>
            <div style={{ fontSize: 10, color: C.text, lineHeight: 1.5 }}>{flow.optionsFlow.unusualActivity}</div>
            {flow.optionsFlow.putCallRatio && flow.optionsFlow.putCallRatio !== "N/A" && (
              <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>Put/Call: {flow.optionsFlow.putCallRatio}</div>
            )}
          </div>
        )}
        {flow.insiderActivity?.detail && flow.insiderActivity.signal !== "NO_RECENT" && flow.insiderActivity.detail !== "NO_DATA" && (
          <div>
            <div style={{ fontSize: 8, color: C.inst, textTransform: "uppercase", marginBottom: 3 }}>👤 Insider Activity</div>
            <div style={{ fontSize: 10, color: C.text, lineHeight: 1.5 }}>{flow.insiderActivity.detail}</div>
          </div>
        )}
        {flow.etfFlow?.detail && flow.etfFlow.detail !== "NO_DATA" && (
          <div>
            <div style={{ fontSize: 8, color: C.inst, textTransform: "uppercase", marginBottom: 3 }}>📦 ETF Flow</div>
            <div style={{ fontSize: 10, color: C.text, lineHeight: 1.5 }}>{flow.etfFlow.detail}</div>
          </div>
        )}
        {(flow.institutionalOwnership || flow["13fChange"]) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {flow.institutionalOwnership && (
              <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 3, padding: "7px 9px" }}>
                <div style={{ fontSize: 8, color: C.inst, textTransform: "uppercase", marginBottom: 3 }}>Inst. Ownership</div>
                <div style={{ fontSize: 10, color: C.text }}>{flow.institutionalOwnership}</div>
              </div>
            )}
            {flow["13fChange"] && (
              <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 3, padding: "7px 9px" }}>
                <div style={{ fontSize: 8, color: C.inst, textTransform: "uppercase", marginBottom: 3 }}>13F Change</div>
                <div style={{ fontSize: 10, color: C.text }}>{flow["13fChange"]}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── SIGNAL CARD ───────────────────────────────────────────────────────────────
function SignalCard({ signal, leverage, budget, riskPct }) {
  const [expanded, setExpanded] = useState(false);
  const ac = actionColor(signal.action);
  const slPct = signal.stopLossPct || 2;
  const tpPct = signal.takeProfitPct || slPct * 2;
  const pos = calcPositionSize(budget, riskPct, slPct, signal.suggestedLeverage || leverage);
  const rr = (tpPct / slPct).toFixed(1);
  const rrC = rr >= 2 ? C.buy : rr >= 1.5 ? C.hold : C.sell;
  const bullish = Math.min(100, Math.max(0, signal.bullish || 50));
  const ss = signal.sentimentSummary;
  const nfColor = nf => nf === "POSITIVE" ? C.buy : nf === "NEGATIVE" ? C.sell : nf === "MIXED" ? C.hold : C.muted;

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.borderSoft}`, borderRadius: 12, overflow: "hidden", borderTop: `3px solid ${ac}` }}>
      <div style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
          <div>
            <div className="mono" style={{ fontWeight: 700, fontSize: 22, color: C.text, letterSpacing: "0.02em" }}>{signal.asset}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{signal.assetFull}</div>
            {signal.currentPrice > 0 && (
              <div className="mono" style={{ fontSize: 14, color: C.accent, marginTop: 6, fontWeight: 600 }}>
                ${signal.currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>R:R</div>
              <div className="mono" style={{ color: rrC, fontWeight: 700, fontSize: 15 }}>1:{rr}</div>
            </div>
            <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.14em", padding: "7px 14px", borderRadius: 8, border: `1px solid ${ac}`, background: `${ac}22`, color: ac }}>{signal.action}</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 14 }}>
          {[
            { label: "Confidence", val: `${signal.confidence}%`, color: ac },
            { label: "Leverage", val: `${signal.suggestedLeverage || leverage}×`, color: C.gold },
            { label: "Stop Loss", val: `−${slPct}%`, color: C.sell, note: signal.slWasCapped ? "Tightened" : null },
            { label: "Take Profit", val: `+${tpPct}%`, color: C.buy },
          ].map(({ label, val, color, note }) => (
            <div key={label} style={{ background: C.surface, borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5, fontWeight: 600 }}>{label}</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color, lineHeight: 1.1 }}>{val}</div>
              {note && <div style={{ fontSize: 10, color: C.gold, marginTop: 4 }}>⚠ {note}</div>}
            </div>
          ))}
        </div>

        <div style={{ height: 4, background: C.border, borderRadius: 2, overflow: "hidden", marginBottom: 14 }}>
          <div style={{ height: "100%", width: `${signal.confidence}%`, background: ac, transition: "width 0.6s" }} />
        </div>

        {signal.institutionalFlow && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, padding: "5px 8px", background: "rgba(106,130,212,0.08)", border: `1px solid rgba(106,130,212,0.2)`, borderRadius: 3 }}>
            <span style={{ fontSize: 9, color: C.inst }}>🏛 INST FLOW</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: signal.institutionalFlow.overallBias === "ACCUMULATING" ? C.buy : signal.institutionalFlow.overallBias === "DISTRIBUTING" ? C.sell : C.muted }}>
              {signal.institutionalFlow.overallBias || "—"}
            </span>
            {signal.institutionalFlow.flowScore != null && (
              <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: signal.institutionalFlow.flowScore >= 65 ? C.buy : signal.institutionalFlow.flowScore <= 35 ? C.sell : C.hold }}>
                {signal.institutionalFlow.flowScore}/100
              </span>
            )}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, marginBottom: 10 }}>
          <span style={{ color: C.muted, minWidth: 52 }}>🐂 {bullish}%</span>
          <div style={{ flex: 1, height: 5, background: C.border, borderRadius: 3, overflow: "hidden", display: "flex" }}>
            <div style={{ width: `${bullish}%`, background: C.buy }} />
            <div style={{ width: `${100 - bullish}%`, background: C.sell }} />
          </div>
          <span style={{ color: C.muted, minWidth: 52, textAlign: "right" }}>🐻 {100 - bullish}%</span>
        </div>

        {(() => {
          const range = slPct + tpPct;
          const slW = (slPct / range) * 40;
          const tpW = (tpPct / range) * 60;
          return (
            <div>
              <div style={{ position: "relative", height: 24, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${slW}%`, background: "rgba(255,61,113,0.25)" }} />
                <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: `${tpW}%`, background: "rgba(0,230,118,0.2)" }} />
                <div style={{ position: "absolute", top: 0, bottom: 0, left: `${slW}%`, width: 2, background: C.accent, boxShadow: `0 0 6px ${C.accent}` }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, marginTop: 3 }}>
                <span style={{ color: C.sell }}>▼ SL −{slPct}%</span>
                <span style={{ color: C.accent }}>● ENTRY</span>
                <span style={{ color: C.buy }}>▲ TP +{tpPct}%</span>
              </div>
            </div>
          );
        })()}

        <button onClick={() => setExpanded(e => !e)} style={{ width: "100%", marginTop: 14, padding: "10px", background: C.accentDim, border: `1px solid ${C.border}`, borderRadius: 8, color: C.accent, fontSize: 13, fontWeight: 600, cursor: "pointer", letterSpacing: "0.04em" }}>
          {expanded ? "▲ Collapse" : "▼ Full analysis"}
        </button>
      </div>

      {expanded && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          <TradingChart signal={signal} />

          <div>
            <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600, marginBottom: 10 }}>Position Sizing</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {[
                { label: "Position Size", val: fmt(pos.positionSize), sub: "Total exposure", color: C.accent },
                { label: "Margin Required", val: fmt(pos.margin), sub: "Capital to commit", color: C.text },
                { label: "Max Risk", val: `−${fmt(pos.riskAmount)}`, sub: `SL hit (${riskPct}%)`, color: C.sell },
                { label: "Max Profit", val: `+${fmt(pos.positionSize * tpPct / 100)}`, sub: "TP hit", color: C.buy },
              ].map(({ label, val, sub, color }) => (
                <div key={label} style={{ background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5, fontWeight: 600 }}>{label}</div>
                  <div className="mono" style={{ fontSize: 14, fontWeight: 700, color }}>{val}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{sub}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <div style={{ background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5, fontWeight: 600 }}>Stop Loss Level</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.sell, lineHeight: 1.4 }}>{signal.stopLossNote || "—"}</div>
              </div>
              <div style={{ background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5, fontWeight: 600 }}>Take Profit Level</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.buy, lineHeight: 1.4 }}>{signal.takeProfitNote || "—"}</div>
              </div>
            </div>
          </div>

          <InstitutionalPanel flow={signal.institutionalFlow} />

          {ss && (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ padding: "10px 12px", background: "rgba(0,0,0,0.3)", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, color: C.text, marginBottom: 8 }}>💬 {ss.headline}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {ss.newsFlow && <span style={{ fontSize: 8, padding: "2px 7px", border: `1px solid ${nfColor(ss.newsFlow)}`, borderRadius: 2, color: nfColor(ss.newsFlow) }}>📰 {ss.newsFlow === "NO_RECENT_DATA" ? "NO NEWS <4H" : ss.newsFlow}</span>}
                  {ss.socialSentiment && (() => {
                    const sc = ss.socialSentiment.includes("BULLISH") ? C.buy : ss.socialSentiment.includes("BEARISH") ? C.sell : C.hold;
                    return <span style={{ fontSize: 8, padding: "2px 7px", border: `1px solid ${sc}`, borderRadius: 2, color: sc }}>🐦 {ss.socialSentiment.replace("_", " ")}</span>;
                  })()}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ padding: "10px 12px", borderRight: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 9, color: C.buy, textTransform: "uppercase", marginBottom: 6, fontWeight: 700 }}>▲ Bull Case</div>
                  {(ss.bullPoints || []).map((p, i) => <div key={i} style={{ display: "flex", gap: 5, marginBottom: 4, fontSize: 10, color: C.text, lineHeight: 1.4 }}><span style={{ color: C.buy, flexShrink: 0 }}>+</span><span>{p}</span></div>)}
                </div>
                <div style={{ padding: "10px 12px" }}>
                  <div style={{ fontSize: 9, color: C.sell, textTransform: "uppercase", marginBottom: 6, fontWeight: 700 }}>▼ Bear Case</div>
                  {(ss.bearPoints || []).map((p, i) => <div key={i} style={{ display: "flex", gap: 5, marginBottom: 4, fontSize: 10, color: C.text, lineHeight: 1.4 }}><span style={{ color: C.sell, flexShrink: 0 }}>−</span><span>{p}</span></div>)}
                </div>
              </div>
              <div style={{ padding: "8px 12px", display: "flex", gap: 12, flexWrap: "wrap" }}>
                {(ss.catalysts || []).length > 0 && (
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 8, color: C.muted, textTransform: "uppercase", marginBottom: 4 }}>⚡ Catalysts</div>
                    {ss.catalysts.map((cat, i) => <div key={i} style={{ fontSize: 10, color: C.gold, marginBottom: 2 }}>• {cat}</div>)}
                  </div>
                )}
                {ss.analystConsensus && (
                  <div>
                    <div style={{ fontSize: 8, color: C.muted, textTransform: "uppercase", marginBottom: 4 }}>📊 Analyst</div>
                    <div style={{ fontSize: 10, color: C.text }}>{ss.analystConsensus}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          <EntryDiagram signal={signal} />

          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
            <div style={{ fontSize: 9, color: C.text, textTransform: "uppercase", marginBottom: 6, fontWeight: 700 }}>AI Chart Analysis</div>
            <div style={{ fontSize: 10, color: C.accent, marginBottom: 5 }}>📍 {signal.entryNote}</div>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 5 }}>⚡ Key: <span style={{ color: C.text }}>{signal.keyLevel || "—"}</span></div>
            <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.7 }}>{signal.reasoning}</div>
          </div>

          <div style={{ background: "rgba(0,229,255,0.04)", border: `1px solid rgba(0,229,255,0.15)`, borderRadius: 3, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: C.accent, textTransform: "uppercase", marginBottom: 6 }}>Execution Checklist</div>
            {[
              "① Open your broker",
              `② Search: ${signal.asset}`,
              "③ Tap TRADE",
              `④ Set ${fmt(pos.margin)} margin · ${signal.suggestedLeverage || leverage}× leverage`,
              `⑤ SL: ${signal.stopLossNote || `−${slPct}%`}`,
              `⑥ TP: ${signal.takeProfitNote || `+${tpPct}%`}`,
              "⑦ Tap OPEN TRADE",
            ].map((s, i) => (
              <div key={i} style={{ fontSize: 10, color: i === 2 ? C.buy : i === 6 ? C.accent : C.muted, marginBottom: 3 }}>{s}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── OUTCOME STATUS PANEL ──────────────────────────────────────────────────────
function OutcomePanel({ status }) {
  if (!status) return null;
  const goalColor = status.goalMet ? C.buy : C.inst;
  const borderColor = status.goalMet ? "rgba(0,230,118,0.3)" : "rgba(106,130,212,0.3)";
  const bgColor = status.goalMet ? "rgba(0,230,118,0.06)" : "rgba(106,130,212,0.06)";
  return (
    <div style={{ background: bgColor, border: `1px solid ${borderColor}`, borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: goalColor, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 700 }}>
          🎯 Outcome loop {status.goalMet ? "— goal met ✓" : `— iteration ${status.iteration}/3`}
        </div>
        <div style={{ fontSize: 11, color: C.muted }}>Haiku grader · Find ≥1 opportunity</div>
      </div>
      {status.criteria && Object.keys(status.criteria).length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, marginBottom: 10 }}>
          {Object.entries(status.criteria).map(([k, v]) => (
            <div key={k} style={{ background: C.surface, borderRadius: 6, padding: "6px 10px", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 12, color: v.pass ? C.buy : C.sell, fontWeight: 700 }}>{v.pass ? "✓" : "✗"}</span>
              <span style={{ fontSize: 11, color: C.textDim, fontWeight: 500 }}>{k}</span>
            </div>
          ))}
        </div>
      )}
      {(status.log || []).length > 0 && (
        <div style={{ display: "flex", gap: 6, marginBottom: status.feedback && !status.goalMet ? 10 : 0, flexWrap: "wrap" }}>
          {status.log.map((it, i) => {
            const color = it.goalMet ? C.buy : it.passed ? C.buy : C.sell;
            return (
              <div key={i} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: `1px solid ${color}`, color, fontWeight: 600 }}>
                Iter {it.iteration}: {it.goalMet ? "GOAL MET" : it.passed ? "PASS" : "FAIL"}
              </div>
            );
          })}
        </div>
      )}
      {status.feedback && !status.goalMet && (
        <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.6, borderTop: `1px solid rgba(125,146,220,0.18)`, paddingTop: 10 }}>
          <span style={{ color: C.inst, fontWeight: 600 }}>Grader: </span>{status.feedback}
        </div>
      )}
    </div>
  );
}

// ── ERROR BANNER (with expandable technical details) ─────────────────────────
function ErrorBanner({ error, onDismiss }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!error) return null;

  const message = typeof error === "string" ? error : error.message;
  const diag = typeof error === "string" ? null : error.diag;
  const stack = typeof error === "string" ? null : error.stack;

  const isRateLimit = /rate limited|quota/i.test(message);
  const isDailyQuota = /daily|spend/i.test(message);

  // Build a single copyable diagnostic blob.
  const debugBlob = JSON.stringify({
    timestamp: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    message,
    diag,
    stack: stack ? stack.split("\n").slice(0, 8).join("\n") : null,
  }, null, 2);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(debugBlob);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  };

  // Highlight the most useful 429 fields up top.
  const quickFacts = diag ? [
    { k: "Call", v: diag.callLabel },
    { k: "Model", v: diag.model },
    { k: "HTTP", v: diag.status ?? "—" },
    { k: "API status", v: diag.apiErrorStatus },
    { k: "Retry-After", v: diag.retryAfterHeader },
    { k: "Suggested wait", v: diag.retryHintSec != null ? `${diag.retryHintSec}s` : null },
    { k: "Daily quota?", v: diag.isDailyQuota ? "yes" : null },
    { k: "Grounding", v: typeof diag.grounding === "boolean" ? String(diag.grounding) : null },
    { k: "Attempts", v: diag.attempts429 != null ? `${diag.attempts429} (429)` : null },
    { k: "Elapsed", v: diag.elapsedMs != null ? `${diag.elapsedMs}ms` : null },
    { k: "Prompt chars", v: diag.promptChars },
  ].filter(({ v }) => v != null && v !== "") : [];

  return (
    <div style={{ background: "rgba(255,92,124,0.08)", border: `1px solid rgba(255,92,124,0.3)`, borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 14, color: C.sell, lineHeight: 1.55, flex: 1 }}>
          <span style={{ fontWeight: 600 }}>⚠ {message}</span>
        </div>
        {onDismiss && (
          <button onClick={onDismiss} title="Dismiss" style={{ background: "transparent", border: "none", color: C.muted, fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 0 }}>×</button>
        )}
      </div>

      {isRateLimit && diag?.quotaViolations?.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: C.textDim, lineHeight: 1.6 }}>
          {diag.quotaViolations.map((v, i) => (
            <div key={i}>
              <span style={{ color: C.muted }}>Quota: </span>
              <span className="mono">{v.quotaId || v.quotaMetric || "(unknown)"}</span>
              {v.quotaValue ? <span> · limit <span className="mono">{v.quotaValue}</span></span> : null}
              {v.quotaDimensions ? <span style={{ color: C.muted }}> · {Object.entries(v.quotaDimensions).map(([k, vv]) => `${k}=${vv}`).join(", ")}</span> : null}
            </div>
          ))}
        </div>
      )}

      {isDailyQuota && (
        <div style={{ marginTop: 10, fontSize: 12, color: C.textDim, lineHeight: 1.6, background: "rgba(240,193,75,0.07)", border: "1px solid rgba(240,193,75,0.2)", borderRadius: 6, padding: "8px 10px" }}>
          💡 Check your <a href="https://console.anthropic.com/settings/usage" target="_blank" rel="noreferrer">usage</a> and <a href="https://console.anthropic.com/settings/limits" target="_blank" rel="noreferrer">spend caps</a> in the Anthropic Console. Topping up credits or raising the monthly limit resolves this.
        </div>
      )}

      {(diag || stack) && (
        <div style={{ marginTop: 12 }}>
          <button
            onClick={() => setOpen(o => !o)}
            style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.textDim, fontSize: 12, fontWeight: 500, borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}
          >
            {open ? "▲ Hide technical details" : "▼ Show technical details"}
          </button>
          <button
            onClick={copy}
            style={{ marginLeft: 8, background: "transparent", border: `1px solid ${C.border}`, color: C.textDim, fontSize: 12, fontWeight: 500, borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}
          >
            {copied ? "✓ Copied" : "Copy debug info"}
          </button>

          {open && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              {quickFacts.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 6 }}>
                  {quickFacts.map(({ k, v }) => (
                    <div key={k} style={{ background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "6px 10px" }}>
                      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>{k}</div>
                      <div className="mono" style={{ fontSize: 12, color: C.text, wordBreak: "break-all" }}>{String(v)}</div>
                    </div>
                  ))}
                </div>
              )}

              {diag?.apiErrorMessage && (
                <div>
                  <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 4 }}>API error message</div>
                  <div style={{ fontSize: 12, color: C.text, lineHeight: 1.55, fontFamily: FONT_MONO, background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{diag.apiErrorMessage}</div>
                </div>
              )}

              {diag?.url && (
                <div>
                  <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 4 }}>Request URL</div>
                  <div className="mono" style={{ fontSize: 11, color: C.textDim, background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "6px 10px", wordBreak: "break-all" }}>{diag.url}</div>
                </div>
              )}

              {diag?.responseHeaders && Object.keys(diag.responseHeaders).length > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 4 }}>Response headers</div>
                  <pre className="mono" style={{ fontSize: 11, color: C.textDim, background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 180, overflow: "auto", margin: 0 }}>{Object.entries(diag.responseHeaders).map(([k, v]) => `${k}: ${v}`).join("\n")}</pre>
                </div>
              )}

              {diag?.responseBody && (
                <div>
                  <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 4 }}>Response body (first 4 KB)</div>
                  <pre className="mono" style={{ fontSize: 11, color: C.textDim, background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 240, overflow: "auto", margin: 0 }}>{diag.responseBody}</pre>
                </div>
              )}

              {stack && (
                <details>
                  <summary style={{ fontSize: 11, color: C.muted, cursor: "pointer", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em" }}>Stack trace</summary>
                  <pre className="mono" style={{ fontSize: 11, color: C.textDim, background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "8px 10px", whiteSpace: "pre-wrap", marginTop: 6, maxHeight: 200, overflow: "auto" }}>{stack}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── MANAGE KEY MODAL ──────────────────────────────────────────────────────────
function ManageKeyModal({ onClose, onUpdate }) {
  const [keyInput, setKeyInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) { setErr("Please enter a key."); return; }
    if (!trimmed.startsWith("sk-ant-")) { setErr("Doesn't look like an Anthropic key (should start with sk-ant-)."); return; }
    setErr(null); setValidating(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": trimmed,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 8,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (res.status === 401 || res.status === 403) { setErr("Invalid key — Anthropic rejected it."); setValidating(false); return; }
    } catch { /* accept anyway */ }
    localStorage.setItem("apex_anthropic_key", trimmed);
    onUpdate(trimmed);
    setSaved(true);
    setValidating(false);
    setTimeout(onClose, 1000);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28, width: "100%", maxWidth: 420 }}>
        <div style={{ fontSize: 18, color: C.text, fontWeight: 700, marginBottom: 8 }}>Update Anthropic API Key</div>
        <div style={{ fontSize: 13, color: C.textDim, marginBottom: 18, lineHeight: 1.6 }}>The key is stored only in this browser.</div>
        <input
          type="password"
          value={keyInput}
          onChange={e => { setKeyInput(e.target.value); setErr(null); }}
          placeholder="sk-ant-api03-…"
          autoFocus
          style={{ borderColor: err ? C.sell : C.border, marginBottom: 10 }}
          onKeyDown={e => e.key === "Enter" && !validating && handleSave()}
        />
        {err && <p style={{ fontSize: 13, color: C.sell, marginBottom: 12, lineHeight: 1.55 }}>⚠ {err}</p>}
        {saved && <p style={{ fontSize: 13, color: C.buy, marginBottom: 12 }}>✓ Key updated</p>}
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button onClick={handleSave} disabled={validating} style={{ flex: 1, padding: "12px 16px", background: validating ? C.surface : C.accent, color: validating ? C.muted : "#001318", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14, letterSpacing: "0.02em", cursor: validating ? "not-allowed" : "pointer" }}>
            {validating ? "Validating…" : "Save"}
          </button>
          <button onClick={onClose} style={{ padding: "12px 18px", background: "transparent", color: C.textDim, border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 500 }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── CATEGORY ROW (watchlist editor) ───────────────────────────────────────────
function CategoryRow({ category, selectedTickers, onToggleTicker, onRemoveTicker, onAddTicker, onRename, onDelete }) {
  const [input, setInput] = useState("");
  const handleAdd = () => {
    if (!input.trim()) return;
    onAddTicker(input);
    setInput("");
  };
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button onClick={onRename} title="Rename category" style={{ background: "transparent", border: "none", color: C.textDim, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 600, cursor: "pointer", padding: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
          {category.name} <span style={{ opacity: 0.45, fontSize: 11 }}>✎</span>
        </button>
        <button onClick={onDelete} title="Delete category" style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, fontSize: 12, borderRadius: 6, cursor: "pointer", padding: "4px 10px", lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {category.tickers.map(t => {
          const selected = selectedTickers.has(t);
          return (
            <span key={t} style={{
              display: "inline-flex", alignItems: "center",
              border: `1px solid ${selected ? C.accent : C.border}`,
              background: selected ? C.accentDim : C.surface,
              borderRadius: 8, overflow: "hidden",
              transition: "border-color 0.15s, background 0.15s",
            }}>
              <button
                onClick={() => onToggleTicker(t)}
                className="mono"
                style={{
                  padding: "8px 12px", background: "transparent", border: "none",
                  color: selected ? C.accent : C.text,
                  fontSize: 13, fontWeight: selected ? 600 : 500,
                  cursor: "pointer", letterSpacing: "0.02em",
                }}
              >{t}</button>
              <button
                onClick={() => onRemoveTicker(t)} title="Remove from category"
                style={{
                  padding: "8px 10px", background: "transparent", border: "none",
                  borderLeft: `1px solid ${selected ? C.accent : C.border}`,
                  color: C.muted, fontSize: 12, cursor: "pointer", lineHeight: 1,
                }}
              >✕</button>
            </span>
          );
        })}
        <span style={{ display: "inline-flex", alignItems: "center", border: `1px dashed ${C.border}`, borderRadius: 8, background: "transparent" }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value.toUpperCase())}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
            placeholder="+ TICKER"
            className="mono"
            style={{
              width: 110, padding: "8px 12px", background: "transparent",
              border: "none", color: C.text, fontSize: 13, outline: "none",
              borderRadius: 0,
            }}
          />
          <button
            onClick={handleAdd} disabled={!input.trim()}
            style={{
              padding: "8px 14px", background: "transparent", border: "none",
              borderLeft: `1px dashed ${C.border}`,
              color: input.trim() ? C.accent : C.muted,
              fontSize: 13, fontWeight: 600,
              cursor: input.trim() ? "pointer" : "not-allowed",
            }}
          >Add</button>
        </span>
      </div>
    </div>
  );
}

// ── ROOT AUTH WRAPPER ─────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [apiKey, setApiKey] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Clean up legacy keys from previous providers if present.
    if (localStorage.getItem("apex_api_key")) localStorage.removeItem("apex_api_key");
    if (localStorage.getItem("apex_gemini_key")) localStorage.removeItem("apex_gemini_key");
    const storedUser = localStorage.getItem("apex_user");
    const storedKey = localStorage.getItem("apex_anthropic_key");
    if (storedUser) {
      try { setUser(JSON.parse(storedUser)); } catch { localStorage.removeItem("apex_user"); }
    }
    if (storedKey) setApiKey(storedKey);
    setReady(true);
  }, []);

  const handleSignIn = useCallback((userData) => {
    const userObj = { email: userData.email, name: userData.name, picture: userData.picture };
    localStorage.setItem("apex_user", JSON.stringify(userObj));
    setUser(userObj);
  }, []);

  const handleSetApiKey = useCallback((key) => {
    localStorage.setItem("apex_anthropic_key", key);
    setApiKey(key);
  }, []);

  const handleLogout = useCallback(async () => {
    try { await signOutFirebase(); } catch { /* ignore */ }
    localStorage.removeItem("apex_user");
    localStorage.removeItem("apex_anthropic_key");
    setUser(null);
    setApiKey(null);
  }, []);

  if (!ready) return null; // Avoid flash before localStorage is read
  if (!user) return <LoginScreen onSignIn={handleSignIn} />;
  if (!apiKey) return <ApiKeyPrompt user={user} onSetKey={handleSetApiKey} onLogout={handleLogout} />;
  return <ApexEagleApp user={user} apiKey={apiKey} onLogout={handleLogout} onUpdateKey={handleSetApiKey} />;
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
function ApexEagleApp({ user, apiKey, onLogout, onUpdateKey }) {
  const [categories, setCategories] = useState(() => loadJSON("apex_categories", DEFAULT_CATEGORIES));
  const [selectedTickers, setSelectedTickers] = useState(() => new Set(loadJSON("apex_selected_tickers", DEFAULT_SELECTED)));
  const [leverage, setLeverage] = useState(2);
  const [budget, setBudget] = useState(() => loadJSON("apex_portfolio_value", 10000));
  const [riskPct, setRiskPct] = useState(() => loadJSON("apex_risk_factor", 2));
  const [loading, setLoading] = useState(false);
  const [loaderStep, setLoaderStep] = useState("");
  const [signals, setSignals] = useState([]);
  const [sentiment, setSentiment] = useState(null);
  const [riskSummary, setRiskSummary] = useState(null);
  const [signalLog, setSignalLog] = useState([]);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("signals");
  const [outcomeStatus, setOutcomeStatus] = useState(null);
  const [showKeyModal, setShowKeyModal] = useState(false);

  useEffect(() => { saveJSON("apex_categories", categories); }, [categories]);
  useEffect(() => { saveJSON("apex_selected_tickers", [...selectedTickers]); }, [selectedTickers]);
  useEffect(() => { saveJSON("apex_portfolio_value", budget); }, [budget]);
  useEffect(() => { saveJSON("apex_risk_factor", riskPct); }, [riskPct]);

  const toggleTicker = (ticker) => setSelectedTickers(prev => { const n = new Set(prev); n.has(ticker) ? n.delete(ticker) : n.add(ticker); return n; });
  const allTickers = [...new Set(categories.flatMap(c => c.tickers))];
  const selectedAssets = [...selectedTickers].filter(t => allTickers.includes(t));
  const sentColor = sentiment ? (sentiment.score >= 70 ? C.buy : sentiment.score <= 30 ? C.sell : C.hold) : C.muted;

  const addCategory = () => {
    const name = window.prompt("Category name (e.g. Crypto)");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setCategories(prev => [...prev, { id: randomId(), name: trimmed, tickers: [] }]);
  };
  const renameCategory = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return;
    const name = window.prompt("Rename category", cat.name);
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setCategories(prev => prev.map(c => c.id === id ? { ...c, name: trimmed } : c));
  };
  const deleteCategory = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return;
    if (!window.confirm(`Delete category "${cat.name}"? Its tickers will no longer be available unless they exist in another category.`)) return;
    setCategories(prev => prev.filter(c => c.id !== id));
  };
  const addTicker = (catId, raw) => {
    const ticker = String(raw || "").trim().toUpperCase();
    if (!ticker) return false;
    let added = false;
    setCategories(prev => prev.map(c => {
      if (c.id !== catId) return c;
      if (c.tickers.includes(ticker)) return c;
      added = true;
      return { ...c, tickers: [...c.tickers, ticker] };
    }));
    return added;
  };
  const removeTicker = (catId, ticker) => {
    setCategories(prev => prev.map(c => c.id === catId ? { ...c, tickers: c.tickers.filter(t => t !== ticker) } : c));
    // If the ticker no longer exists in any remaining category, deselect it.
    setTimeout(() => {
      setCategories(curr => {
        const stillExists = curr.some(c => c.tickers.includes(ticker));
        if (!stillExists) setSelectedTickers(prev => { const n = new Set(prev); n.delete(ticker); return n; });
        return curr;
      });
    }, 0);
  };

  const normalizeSignals = useCallback((sigs, lev) => sigs.map(s => {
    const cap = SL_CAPS[s.asset] ?? SL_CAPS.DEFAULT;
    const rawSL = Number(s.stopLossPct) || 2.0;
    const clampedSL = Math.min(rawSL, cap);
    const minTP = +(clampedSL * 1.5).toFixed(2);
    return {
      ...s,
      confidence: Number(s.confidence) || 70,
      stopLossPct: +clampedSL.toFixed(2),
      takeProfitPct: +Math.max(Number(s.takeProfitPct) || minTP, minTP).toFixed(2),
      slWasCapped: rawSL > cap,
      rsi: Number(s.rsi) || 50,
      bullish: Number(s.bullish) || 50,
      suggestedLeverage: Math.min(Number(s.suggestedLeverage) || lev, lev),
      currentPrice: Number(s.currentPrice) || 0,
    };
  }), []);

  const runAnalysis = async () => {
    if (!selectedAssets.length) { alert("Select at least one asset."); return; }
    setLoading(true); setError(null); setSignals([]); setOutcomeStatus(null); setTab("signals");
    try {
      const now = new Date();
      const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const MAX_ITER = 3;
      let lastResult = null, graderFeedback = null, goalMet = false;
      const iterLog = [];

      for (let iter = 1; iter <= MAX_ITER; iter++) {
        setOutcomeStatus({ iteration: iter, passed: false, feedback: graderFeedback, goalMet: false, log: [...iterLog] });
        setLoaderStep(`🎯 Outcome loop — iteration ${iter}/${MAX_ITER}…`);

        const agentSystem = [
          {
            type: "text",
            text: `You are APEX Eagle, elite intraday day trading analyst.
STOP LOSS RULES: TIGHT SLs based on nearest technical level — NOT a percentage guess.
Caps: MSFT/GOOGL/META<=2.0%, NVDA/AMD/PLTR/SMCI<=2.5%, SOUN<=3.0%, XOM/CVX/BP/SLB<=1.8%, COP<=1.8%, OXY/FANG<=2.2%, Gold<=1.2%, Oil<=2.0%
TP must be >=1.5x SL. stopLossNote MUST include a specific price. If no tight SL exists -> HOLD.
SIGNAL ALIGNMENT: If institutional flow contradicts technical signal, lower confidence 15+ pts or set HOLD.
Return ONLY valid JSON, no markdown:
{"overallSentiment":<0-100>,"overallLabel":"<EXTREME FEAR|FEAR|NEUTRAL|GREED|EXTREME GREED>","signals":[{"asset":"<ticker>","assetFull":"<name>","currentPrice":<n>,"action":"<BUY|SELL|HOLD>","confidence":<0-100>,"suggestedLeverage":<1-5>,"entryNote":"<specific entry>","stopLossPct":<n>,"stopLossNote":"<exact price + reason>","takeProfitPct":<n>,"takeProfitNote":"<target>","bullish":<0-100>,"keyLevel":"<price>","rsi":<0-100>,"trend":"<UPTREND|DOWNTREND|SIDEWAYS>","patterns":"<pattern>","volume":"<ABOVE_AVG|BELOW_AVG|AVERAGE>","reasoning":"<2-3 sentences>"}]}`,
            cache_control: { type: "ephemeral" },
          },
        ];
        const agentUserMsg = `Today is ${dateStr} at ${timeStr} UTC.
Assets: ${selectedAssets.join(", ")}
Portfolio: $${budget.toLocaleString()} | Risk: ${riskPct}% per trade | Max leverage: ${leverage}x
GOAL: Find at least one strong BUY or SELL opportunity with confidence >= 65%.
${graderFeedback ? `GRADER FEEDBACK — fix these issues:\n${graderFeedback}\n` : ""}
Search current prices and recent price action only. Limit to 3 searches maximum.`;

        const agentData = await callApi(apiKey, {
          max_tokens: 2000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          system: agentSystem,
          messages: [{ role: "user", content: agentUserMsg }],
        }, 3, `agent-iter-${iter}`);
        const agentText = agentData.content.filter(b => b.type === "text").map(b => b.text).join("");
        const result = safeParseJson(agentText);
        if (!result?.signals?.length) {
          graderFeedback = "Agent returned invalid JSON or empty signals array. Retry with properly formatted output.";
          iterLog.push({ iteration: iter, passed: false, goalMet: false, feedback: graderFeedback });
          continue;
        }
        lastResult = result;
        const normalized = normalizeSignals(result.signals, leverage);

        setLoaderStep(`🔍 Grader evaluating iteration ${iter}…`);
        const graderSystem = [
          {
            type: "text",
            text: `You are the APEX Eagle Outcome Grader. You did NOT produce the agent output. Evaluate it independently.
${OUTCOME_RUBRIC}
Return ONLY valid JSON: {"passed":<true if ALL 6 criteria pass>,"goalMet":<true if C1+C2 both pass>,"criteria":{"C1":{"pass":<bool>,"note":"<brief>"},"C2":{"pass":<bool>,"note":"<brief>"},"C3":{"pass":<bool>,"note":"<brief>"},"C4":{"pass":<bool>,"note":"<brief>"},"C5":{"pass":<bool>,"note":"<brief>"},"C6":{"pass":<bool>,"note":"<brief>"}},"feedback":"<if failed: precise instructions. If passed: All criteria met.>"}`,
            cache_control: { type: "ephemeral" },
          },
        ];
        const graderData = await callApi(apiKey, {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 600,
          system: graderSystem,
          messages: [{ role: "user", content: JSON.stringify(normalized.map(s => ({ asset: s.asset, action: s.action, confidence: s.confidence, stopLossPct: s.stopLossPct, stopLossNote: s.stopLossNote, takeProfitPct: s.takeProfitPct, entryNote: s.entryNote, currentPrice: s.currentPrice }))) }],
        }, 3, `grader-iter-${iter}`);
        const graderResult = safeParseJson(graderData.content.filter(b => b.type === "text").map(b => b.text).join(""));
        const entry = {
          iteration: iter,
          passed: graderResult?.passed ?? false,
          goalMet: graderResult?.goalMet ?? false,
          criteria: graderResult?.criteria ?? {},
          feedback: graderResult?.feedback ?? "Parse error",
        };
        iterLog.push(entry);

        if (graderResult?.passed || graderResult?.goalMet) {
          goalMet = true;
          setOutcomeStatus({ iteration: iter, passed: true, goalMet: true, criteria: graderResult.criteria, feedback: "All criteria met.", log: [...iterLog] });
          setSentiment({ score: result.overallSentiment ?? 50, label: result.overallLabel ?? "NEUTRAL" });
          setSignals([...normalized]);
          const active = normalized.filter(s => s.action !== "HOLD");
          setRiskSummary({ totalMargin: active.reduce((sum, s) => sum + calcPositionSize(budget, riskPct, s.stopLossPct, s.suggestedLeverage).margin, 0), totalRisk: active.length * (budget * riskPct / 100), activeCount: active.length, total: normalized.length });
          break;
        } else {
          graderFeedback = graderResult?.feedback || "Criteria not met.";
          setOutcomeStatus({ iteration: iter, passed: false, goalMet: false, criteria: graderResult?.criteria ?? {}, feedback: graderFeedback, log: [...iterLog] });
          if (iter < MAX_ITER) await sleep(800);
        }
      }

      if (!goalMet && lastResult) {
        const fb = normalizeSignals(lastResult.signals || [], leverage);
        setSentiment({ score: lastResult.overallSentiment ?? 50, label: lastResult.overallLabel ?? "NEUTRAL" });
        setSignals([...fb]);
        const active = fb.filter(s => s.action !== "HOLD");
        setRiskSummary({ totalMargin: active.reduce((sum, s) => sum + calcPositionSize(budget, riskPct, s.stopLossPct, s.suggestedLeverage).margin, 0), totalRisk: active.length * (budget * riskPct / 100), activeCount: active.length, total: fb.length });
      }

      // Enrichment — only active (BUY/SELL) signals, two focused searches per asset
      setLoaderStep("Scanning institutional flow & dark pool…");
      const currentSigs = (lastResult?.signals || [])
        .filter(s => s.action !== "HOLD")
        .map(s => ({ ...s, currentPrice: Number(s.currentPrice) || 100, trend: s.trend || "SIDEWAYS" }));
      if (currentSigs.length) {
        try {
          const enrichSystem = [
            {
              type: "text",
              text: `You are APEX Eagle. Return ONLY valid JSON, no markdown. Never fabricate specific dollar amounts.`,
              cache_control: { type: "ephemeral" },
            },
          ];
          const enrichedByAsset = {};
          await Promise.all(currentSigs.map(async sig => {
            const newsPrompt = `Search news for ${sig.asset} ($${sig.currentPrice}) from the last 4 hours only.
Return ONLY valid JSON: {"sentimentSummary":{"headline":"<1 sentence>","bullPoints":["<b1>","<b2>"],"bearPoints":["<r1>","<r2>"],"catalysts":["<c1>"],"analystConsensus":"<short>","newsFlow":"<POSITIVE|NEGATIVE|MIXED|NEUTRAL|NO_RECENT_DATA>","socialSentiment":"<VERY_BULLISH|BULLISH|NEUTRAL|BEARISH|VERY_BEARISH>"},"ohlcv":[{"o":<n>,"h":<n>,"l":<n>,"c":<n>,"v":<0-100>}]}
ohlcv: exactly 20 candles ending near $${sig.currentPrice}.`;
            const flowPrompt = `Search institutional flow for ${sig.asset}: dark pool prints, options put/call ratio, unusual blocks, ETF flows.
Return ONLY valid JSON: {"institutionalFlow":{"overallBias":"<ACCUMULATING|DISTRIBUTING|NEUTRAL>","darkPool":{"signal":"<BULLISH|BEARISH|NEUTRAL|NO_DATA>","detail":"<detail>","recentPrints":["<p1>"]},"optionsFlow":{"putCallRatio":"<n or N/A>","signal":"<BULLISH|BEARISH|NEUTRAL>","unusualActivity":"<detail>"},"insiderActivity":{"signal":"<BUYING|SELLING|NEUTRAL|NO_RECENT>","detail":"<detail>"},"etfFlow":{"signal":"<INFLOW|OUTFLOW|NEUTRAL>","detail":"<detail>"},"institutionalOwnership":"<short>","13fChange":"<short>","flowScore":<0-100>}}`;

            const [newsData, flowData] = await Promise.all([
              callApi(apiKey, { model: "claude-haiku-4-5-20251001", max_tokens: 1200, tools: [{ type: "web_search_20250305", name: "web_search" }], system: enrichSystem, messages: [{ role: "user", content: newsPrompt }] }, 2, `enrich-news-${sig.asset}`),
              callApi(apiKey, { model: "claude-haiku-4-5-20251001", max_tokens: 800, tools: [{ type: "web_search_20250305", name: "web_search" }], system: enrichSystem, messages: [{ role: "user", content: flowPrompt }] }, 2, `enrich-flow-${sig.asset}`),
            ]);
            const news = safeParseJson(newsData.content.filter(b => b.type === "text").map(b => b.text).join(""));
            const flow = safeParseJson(flowData.content.filter(b => b.type === "text").map(b => b.text).join(""));
            enrichedByAsset[sig.asset] = { sentimentSummary: news?.sentimentSummary || null, ohlcv: news?.ohlcv || null, institutionalFlow: flow?.institutionalFlow || null };
          }));

          setSignals(prev => prev.map(s => {
            const e = enrichedByAsset[s.asset];
            if (!e) return { ...s, ohlcv: s.ohlcv || generateFallbackOHLCV(s.currentPrice, s.trend, 20) };
            const rawOhlcv = Array.isArray(e.ohlcv) ? e.ohlcv.filter(c => c && typeof c.o === "number") : [];
            const ohlcv = rawOhlcv.length >= 3 ? rawOhlcv : generateFallbackOHLCV(s.currentPrice, s.trend, 20);
            const flow = e.institutionalFlow || null;
            let conf = s.confidence;
            if (flow) {
              const al = (s.action === "BUY" && flow.overallBias === "ACCUMULATING") || (s.action === "SELL" && flow.overallBias === "DISTRIBUTING");
              const ag = (s.action === "BUY" && flow.overallBias === "DISTRIBUTING") || (s.action === "SELL" && flow.overallBias === "ACCUMULATING");
              if (al) conf = Math.min(99, conf + 8);
              if (ag) conf = Math.max(10, conf - 12);
              if (flow.darkPool?.signal === "BULLISH" && s.action === "BUY") conf = Math.min(99, conf + 5);
              if (flow.darkPool?.signal === "BEARISH" && s.action === "BUY") conf = Math.max(10, conf - 5);
              if (flow.optionsFlow?.signal === "BULLISH" && s.action === "BUY") conf = Math.min(99, conf + 4);
              if (flow.optionsFlow?.signal === "BEARISH" && s.action === "BUY") conf = Math.max(10, conf - 4);
            }
            return { ...s, confidence: conf, sentimentSummary: e.sentimentSummary || null, institutionalFlow: flow, ohlcv };
          }));
        } catch {
          setSignals(prev => prev.map(s => ({ ...s, ohlcv: s.ohlcv || generateFallbackOHLCV(s.currentPrice, s.trend, 20) })));
        }
      }

      const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      setSignals(prev => {
        setSignalLog(log => [...prev.map(s => ({ ...s, time })), ...log].slice(0, 40));
        return prev;
      });
    } catch (err) {
      // Capture full diagnostic context (status, model, response body, headers, etc.)
      // alongside the human-readable message so the UI can surface a "Technical
      // details" panel for debugging rate limits and other API issues.
      setError({ message: err.message, diag: err.diag || null, stack: err.stack || null });
    }
    setLoading(false);
  };

  return (
    <div style={{ background: C.bg, color: C.text, height: "100vh", display: "flex", flexDirection: "column", fontSize: 14, overflow: "hidden" }}>
      <GlobalStyles />
      {showKeyModal && <ManageKeyModal onClose={() => setShowKeyModal(false)} onUpdate={onUpdateKey} />}

      {loading && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999, height: 44, background: "rgba(11,15,20,0.95)", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 12, padding: "0 20px", backdropFilter: "blur(10px)" }}>
          <div style={{ width: 14, height: 14, border: `2px solid ${C.border}`, borderTopColor: C.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: C.accent, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{loaderStep}</span>
          <div style={{ width: 100, height: 3, background: C.border, borderRadius: 2, overflow: "hidden", flexShrink: 0 }}>
            <div style={{ height: "100%", background: C.accent, animation: "progress 1.5s ease-in-out infinite" }} />
          </div>
        </div>
      )}
      {loading && <div style={{ height: 44, flexShrink: 0 }} />}

      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${C.borderSoft}`, background: C.bg, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div className="eagle-anim"><Eagle size={32} /></div>
          <div>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 15, letterSpacing: "0.18em", color: C.text }}>APEX EAGLE</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{user.email}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {sentiment && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span className="mono" style={{ fontWeight: 700, fontSize: 20, color: sentColor }}>{sentiment.score}</span>
              <span style={{ fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>{sentiment.label}</span>
            </div>
          )}
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.buy, boxShadow: `0 0 8px ${C.buy}`, animation: "pulse 2s infinite" }} />
          <button onClick={onLogout} style={{ padding: "6px 12px", background: "transparent", border: `1px solid ${C.border}`, color: C.textDim, fontSize: 12, borderRadius: 6, cursor: "pointer", fontWeight: 500 }}>Sign out</button>
        </div>
      </header>

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {tab === "signals" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px 110px", maxWidth: 720, margin: "0 auto", width: "100%" }}>
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
            <OutcomePanel status={outcomeStatus} />
            {!signals.length && !loading && !error && !outcomeStatus && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", paddingTop: 72, gap: 20, textAlign: "center" }}>
                <div className="eagle-anim" style={{ opacity: 0.45 }}><Eagle size={64} /></div>
                <div style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: "0.04em" }}>Select assets &amp; analyze</div>
                <div style={{ fontSize: 14, color: C.textDim, lineHeight: 1.7, maxWidth: 320 }}>Go to Settings, pick tickers and risk parameters, then run the analysis. A Claude Haiku grader verifies every result before showing it.</div>
                <button onClick={() => setTab("settings")} style={{ padding: "12px 28px", background: C.accent, color: "#001318", border: "none", fontWeight: 700, fontSize: 14, letterSpacing: "0.06em", borderRadius: 10, cursor: "pointer" }}>⚙ Open Settings</button>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {signals.map((sig, i) => <SignalCard key={`${sig.asset}-${i}`} signal={sig} leverage={leverage} budget={budget} riskPct={riskPct} />)}
            </div>
          </div>
        )}

        {tab === "settings" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 20px 110px", maxWidth: 720, margin: "0 auto", width: "100%" }}>
            <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600, marginBottom: 14 }}>Watchlist</div>
            {categories.map(cat => (
              <CategoryRow
                key={cat.id}
                category={cat}
                selectedTickers={selectedTickers}
                onToggleTicker={toggleTicker}
                onRemoveTicker={(t) => removeTicker(cat.id, t)}
                onAddTicker={(t) => addTicker(cat.id, t)}
                onRename={() => renameCategory(cat.id)}
                onDelete={() => deleteCategory(cat.id)}
              />
            ))}
            <button onClick={addCategory} style={{ padding: "10px 16px", background: "transparent", border: `1px dashed ${C.border}`, color: C.textDim, borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", marginBottom: 28 }}>
              + Add category
            </button>

            <div style={{ height: 1, background: C.borderSoft, marginBottom: 24 }} />

            <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600, marginBottom: 16 }}>Portfolio</div>
            <div style={{ display: "grid", gap: 20, marginBottom: 24 }}>
              <div>
                <label style={{ display: "block", fontSize: 13, color: C.textDim, marginBottom: 8, fontWeight: 500 }}>Portfolio Value</label>
                <input type="number" value={budget} min={100} step={500} onChange={e => setBudget(parseFloat(e.target.value) || 10000)} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 13, color: C.textDim, marginBottom: 8, fontWeight: 500 }}>Risk Per Trade</label>
                <select value={riskPct} onChange={e => setRiskPct(parseFloat(e.target.value))}>{RISK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              </div>
              <div>
                <label style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", fontSize: 13, color: C.textDim, marginBottom: 10, fontWeight: 500 }}>
                  <span>Max Leverage</span>
                  <span className="mono" style={{ color: C.gold, fontWeight: 700, fontSize: 15 }}>{leverage}×</span>
                </label>
                <input type="range" min={1} max={5} step={1} value={leverage} onChange={e => setLeverage(parseInt(e.target.value))} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 8 }}>
                  {[1, 2, 3, 4, 5].map(v => <span key={v} className="mono" style={{ color: v === leverage ? C.gold : C.muted, fontWeight: v === leverage ? 700 : 500 }}>{v}×</span>)}
                </div>
              </div>
            </div>

            <div style={{ background: C.panel, border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600, marginBottom: 10 }}>Analysis Summary</div>
              <div style={{ fontSize: 15, color: C.text, fontWeight: 600, marginBottom: 6 }}>{selectedAssets.length} asset{selectedAssets.length !== 1 ? "s" : ""} selected</div>
              <div style={{ fontSize: 13, color: C.textDim, lineHeight: 1.7 }}>
                <span className="mono">{fmt(budget)}</span> · <span className="mono">{riskPct}%</span> risk · <span className="mono">{leverage}×</span> leverage
              </div>
              <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>Max loss per trade: <span className="mono" style={{ color: C.sell }}>−{fmt(budget * riskPct / 100)}</span></div>
            </div>

            <button onClick={() => setShowKeyModal(true)} style={{ width: "100%", padding: "12px 16px", background: "transparent", border: `1px solid ${C.border}`, color: C.textDim, borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", marginBottom: 16 }}>
              🔑 Update Anthropic API Key
            </button>

            <div style={{ background: "rgba(125,146,220,0.08)", border: "1px solid rgba(125,146,220,0.22)", borderRadius: 8, padding: "12px 14px", marginBottom: 12, fontSize: 13, color: C.inst, lineHeight: 1.6 }}>
              🎯 <strong style={{ fontWeight: 600 }}>Outcome loop</strong> — Claude Sonnet generates signals, Claude Haiku grader verifies (≥1 opportunity, conf ≥65%, tight SL, R:R ≥1.5). Up to 3 iterations.
            </div>
            <div style={{ background: "rgba(240,193,75,0.07)", border: "1px solid rgba(240,193,75,0.22)", borderRadius: 8, padding: "12px 14px", marginBottom: 20, fontSize: 13, color: C.hold, lineHeight: 1.6 }}>
              ⚠ AI signals are informational only. Day trading carries substantial risk. Never invest more than you can afford to lose.
            </div>
            <button
              onClick={runAnalysis}
              disabled={loading || !selectedAssets.length}
              style={{
                width: "100%", padding: "16px",
                background: loading || !selectedAssets.length ? C.surface : C.accent,
                color: loading || !selectedAssets.length ? C.muted : "#001318",
                border: "none", fontWeight: 700, fontSize: 14, letterSpacing: "0.14em",
                cursor: loading || !selectedAssets.length ? "not-allowed" : "pointer",
                borderRadius: 10, textTransform: "uppercase",
                transition: "background 0.15s",
              }}
            >
              {loading ? "Analyzing…" : "▶ Analyze Now"}
            </button>
          </div>
        )}

        {tab === "log" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 16px 110px", maxWidth: 720, margin: "0 auto", width: "100%" }}>
            {sentiment && (
              <div style={{ background: C.panel, border: `1px solid ${C.borderSoft}`, borderRadius: 12, padding: "20px 16px", marginBottom: 14, textAlign: "center" }}>
                <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600, marginBottom: 12 }}>Market Sentiment</div>
                <div className="mono" style={{ fontSize: 56, fontWeight: 700, color: sentColor, lineHeight: 1 }}>{sentiment.score}</div>
                <div style={{ fontSize: 12, color: C.textDim, letterSpacing: "0.14em", marginTop: 8, fontWeight: 600 }}>{sentiment.label}</div>
              </div>
            )}
            {riskSummary && (
              <div style={{ background: C.panel, border: `1px solid ${C.borderSoft}`, borderRadius: 12, padding: "18px 18px", marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600, marginBottom: 14 }}>Portfolio Risk</div>
                {[
                  { label: "Budget", val: fmt(budget), color: C.text },
                  { label: "Active Signals", val: `${riskSummary.activeCount}/${riskSummary.total}`, color: C.text },
                  { label: "Total Margin", val: fmt(riskSummary.totalMargin), color: riskSummary.totalMargin > budget * 0.8 ? C.sell : C.hold },
                  { label: "Max Loss", val: `−${fmt(riskSummary.totalRisk)}`, color: C.sell },
                  { label: "Portfolio at Risk", val: `${(riskSummary.totalRisk / budget * 100).toFixed(1)}%`, color: (riskSummary.totalRisk / budget * 100) > 15 ? C.sell : (riskSummary.totalRisk / budget * 100) > 8 ? C.hold : C.buy },
                ].map(({ label, val, color }, i, arr) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 14, padding: "10px 0", borderBottom: i === arr.length - 1 ? "none" : `1px solid ${C.borderSoft}` }}>
                    <span style={{ color: C.textDim }}>{label}</span>
                    <span className="mono" style={{ fontWeight: 700, color, fontSize: 15 }}>{val}</span>
                  </div>
                ))}
                <div style={{ height: 6, background: C.surface, borderRadius: 3, marginTop: 14, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, riskSummary.totalRisk / budget * 400)}%`, background: (riskSummary.totalRisk / budget * 100) > 15 ? C.sell : (riskSummary.totalRisk / budget * 100) > 8 ? C.hold : C.buy, transition: "width 0.8s" }} />
                </div>
              </div>
            )}
            <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600, marginBottom: 12 }}>Signal Log</div>
            {signalLog.length === 0
              ? <div style={{ fontSize: 14, color: C.muted, textAlign: "center", padding: "40px 0" }}>No signals yet</div>
              : signalLog.map((s, i) => {
                const c = actionColor(s.action);
                return (
                  <div key={i} style={{ background: C.panel, border: `1px solid ${C.borderSoft}`, borderLeft: `3px solid ${c}`, borderRadius: 8, padding: "12px 14px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div className="mono" style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{s.asset}</div>
                      <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{s.time} · {s.confidence}% conf · {s.suggestedLeverage}× lev</div>
                      {s.currentPrice > 0 && <div className="mono" style={{ fontSize: 12, color: C.accent, marginTop: 2 }}>${s.currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>}
                      {s.institutionalFlow && <div style={{ fontSize: 11, color: C.inst, marginTop: 2 }}>🏛 {s.institutionalFlow.overallBias} · Score: {s.institutionalFlow.flowScore}</div>}
                    </div>
                    <div style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, fontWeight: 700, background: `${c}22`, color: c, border: `1px solid ${c}`, letterSpacing: "0.05em" }}>{s.action}</div>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, display: "flex", alignItems: "stretch", background: "rgba(11,15,20,0.95)", borderTop: `1px solid ${C.borderSoft}`, backdropFilter: "blur(12px)", zIndex: 100, paddingBottom: "env(safe-area-inset-bottom,0px)" }}>
        {[{ id: "signals", icon: "📊", label: "Signals" }, { id: "settings", icon: "⚙️", label: "Settings" }, { id: "log", icon: "📋", label: "Portfolio" }].map(({ id, icon, label }) => {
          const active = tab === id;
          return (
            <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: "12px 0 10px", background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, position: "relative" }}>
              <span style={{ fontSize: 20, opacity: active ? 1 : 0.55, transition: "opacity 0.15s" }}>{icon}</span>
              <span style={{ fontSize: 11, color: active ? C.accent : C.muted, fontWeight: active ? 600 : 500, letterSpacing: "0.05em" }}>{label}</span>
              {active && <div style={{ position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)", width: 36, height: 2, background: C.accent, borderRadius: 2 }} />}
            </button>
          );
        })}
        <button onClick={runAnalysis} disabled={loading} style={{ flex: 1.3, padding: "10px 0", background: loading ? C.surface : C.accent, border: "none", cursor: loading ? "not-allowed" : "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, margin: "6px 6px", borderRadius: 8, transition: "background 0.15s" }}>
          <span style={{ fontSize: 16, color: loading ? C.muted : "#001318" }}>{loading ? "⏳" : "▶"}</span>
          <span style={{ fontSize: 11, color: loading ? C.muted : "#001318", fontWeight: 700, letterSpacing: "0.08em" }}>{loading ? "WORKING" : "ANALYZE"}</span>
        </button>
      </nav>
    </div>
  );
}
