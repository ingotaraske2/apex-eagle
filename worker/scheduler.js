/**
 * APEX Eagle Scheduler — Cloudflare Worker
 * ─────────────────────────────────────────
 * Fires on cron: Monday + Wednesday 06:00 UTC (07:00 CET)
 * Assets:  AMD, NVDA, GOOGL
 * Mode:    Aggressive (3% risk per trade)
 * Logic:   Runs the APEX outcome loop (Gemini 3.5 Flash agent → Gemini 2.5 Flash grader, up to 3 iterations)
 *          If any BUY signal with confidence ≥ 65 found → send HTML email via Resend
 *
 * Required Worker Secrets (set in Cloudflare dashboard):
 *   GEMINI_API_KEY      — your Google Gemini API key (AIza…)
 *   RESEND_API_KEY      — your Resend API key
 *
 * Optional env vars (set in Cloudflare dashboard → Variables):
 *   RECIPIENT_EMAIL     — defaults to ingo.taraske@gmail.com
 *   FROM_EMAIL          — defaults to apex@resend.dev
 *   BUDGET              — portfolio budget USD, defaults to 10000
 *   LEVERAGE            — max leverage 1-5, defaults to 2
 */

// ── CONFIG ────────────────────────────────────────────────────────────────────
const ASSETS = ["AMD", "NVDA", "GOOGL"];
const RISK_PCT = 3; // Aggressive
const DEFAULT_BUDGET = 10000;
const DEFAULT_LEVERAGE = 2;
const MAX_ITERATIONS = 3;
const MIN_CONFIDENCE = 65;

const SL_CAPS = {
  NVDA: 2.5, AMD: 2.5, GOOGL: 2.0, DEFAULT: 2.5,
};

const OUTCOME_RUBRIC = `## APEX Eagle — Investment Opportunity Rubric
GOAL: Find at least one actionable BUY signal with confidence ≥ 65%.
[C1] Opportunity found — at least one signal has action BUY (not all HOLD/SELL)
[C2] Confidence threshold — at least one BUY has confidence ≥ 65
[C3] Stop loss discipline — every BUY has stopLossNote with a specific price level
[C4] Risk/reward viability — every BUY has takeProfitPct ≥ 1.5 × stopLossPct
[C5] Entry specificity — entryNote references a specific price level or pattern trigger
[C6] Current price — every signal has a numeric currentPrice > 0
Grade each criterion PASS or FAIL. If any fail, explain exactly what the agent must fix.`;

// ── UTILS ─────────────────────────────────────────────────────────────────────
function fmt(n) {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function safeParseJson(text, fallback = null) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch {}
  const om = text.match(/\{[\s\S]*\}/);
  if (om) {
    try { return JSON.parse(om[0]); } catch {}
    try { return JSON.parse(repairJson(om[0])); } catch {}
  }
  return fallback;
}

function repairJson(str) {
  let s = str.trim().replace(/```json|```/gi, "").trim();
  const opens = { "[": 0, "{": 0 }, closes = { "]": "[", "}": "{" };
  for (const ch of s) {
    if (ch === "[" || ch === "{") opens[ch]++;
    if (ch === "]" || ch === "}") { const o = closes[ch]; if (opens[o] > 0) opens[o]--; }
  }
  s = s.replace(/,\s*$/, "");
  if (opens["["] > 0) s += "]".repeat(opens["["]);
  if (opens["{"] > 0) s += "}".repeat(opens["{"]);
  return s;
}

function calcPositionSize(budget, riskPct, slPct, leverage) {
  const riskAmount = budget * (riskPct / 100);
  const slDecimal = Math.abs(slPct) / 100;
  const positionSize = slDecimal > 0 ? riskAmount / slDecimal : budget * 0.1;
  const capped = Math.min(positionSize, budget * 0.4);
  return { riskAmount, positionSize: capped, margin: capped / leverage };
}

function normalizeSignals(signals, leverage) {
  return signals.map(s => {
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
      suggestedLeverage: Math.min(Number(s.suggestedLeverage) || leverage, leverage),
      currentPrice: Number(s.currentPrice) || 0,
    };
  });
}

// ── GEMINI API ────────────────────────────────────────────────────────────────
async function callGemini(env, body, retries = 3) {
  const { model = "gemini-3.5-flash", max_tokens, tools, messages = [] } = body;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : (m.content?.[0]?.text || "") }],
  }));
  const geminiBody = {
    contents,
    generationConfig: {
      ...(max_tokens ? { maxOutputTokens: max_tokens } : {}),
      temperature: 0.7,
    },
  };
  if (Array.isArray(tools) && tools.some(t => t?.type?.startsWith("web_search") || t?.name === "web_search")) {
    geminiBody.tools = [{ google_search: {} }];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });

      if ([500, 502, 503, 504].includes(res.status)) {
        if (attempt < retries) { await sleep(2000 * Math.pow(2, attempt)); continue; }
        throw new Error(`Gemini server error ${res.status}`);
      }
      if (res.status === 429) {
        if (attempt < retries) { await sleep(4000 * Math.pow(2, attempt)); continue; }
        throw new Error("Gemini rate limit exceeded");
      }

      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "Gemini API error");
      return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    } catch (err) {
      if (attempt < retries) { await sleep(1000 * Math.pow(2, attempt)); continue; }
      throw err;
    }
  }
}

// ── SIGNAL GENERATION (outcome loop) ─────────────────────────────────────────
async function generateSignals(env, budget, leverage) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

  let lastResult = null;
  let graderFeedback = null;
  let goalMet = false;
  const iterLog = [];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`[APEX] Outcome loop iteration ${iteration}/${MAX_ITERATIONS}`);

    // ── AGENT (Gemini 3.5 Flash + Google Search grounding) ──
    const agentPrompt = `You are APEX Eagle, elite intraday day trading analyst. Today is ${dateStr} at ${timeStr}.
Assets: ${ASSETS.join(", ")}
Portfolio: ${fmt(budget)} | Risk: ${RISK_PCT}% per trade (AGGRESSIVE) | Max leverage: ${leverage}×

GOAL: Find at least one strong BUY opportunity with confidence ≥ ${MIN_CONFIDENCE}%.
${graderFeedback ? `\n⚠ GRADER FEEDBACK — fix these issues:\n${graderFeedback}\n` : ""}
Search for current prices and recent price action. Check dark pool, options flow, institutional signals.
SIGNAL ALIGNMENT: If institutional flow contradicts the technical signal, lower confidence 15+ pts or set HOLD.
STOP LOSS RULES:
- TIGHT SLs based on nearest technical level — NOT a percentage guess
- Hard caps: GOOGL≤2.0%, NVDA≤2.5%, AMD≤2.5%
- TP must be ≥1.5× SL | stopLossNote MUST include a specific price | If no tight SL → HOLD

Return ONLY valid JSON, no markdown:
{"overallSentiment":<0-100>,"overallLabel":"<EXTREME FEAR|FEAR|NEUTRAL|GREED|EXTREME GREED>","signals":[{"asset":"<ticker>","assetFull":"<name>","currentPrice":<n>,"action":"<BUY|SELL|HOLD>","confidence":<0-100>,"suggestedLeverage":<1-${leverage}>,"entryNote":"<specific entry e.g. breakout above $X>","stopLossPct":<n>,"stopLossNote":"<exact price + reason>","takeProfitPct":<n>,"takeProfitNote":"<target>","bullish":<0-100>,"keyLevel":"<price>","rsi":<0-100>,"trend":"<UPTREND|DOWNTREND|SIDEWAYS>","patterns":"<pattern>","volume":"<ABOVE_AVG|BELOW_AVG|AVERAGE>","reasoning":"<2-3 sentences>"}]}`;

    const agentText = await callGemini(env, {
      max_tokens: 3000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: agentPrompt }],
    });

    const result = safeParseJson(agentText);
    if (!result?.signals) {
      graderFeedback = "Agent returned invalid JSON. Retry with properly formatted output.";
      iterLog.push({ iteration, passed: false, goalMet: false, feedback: graderFeedback });
      continue;
    }
    lastResult = result;
    const normalized = normalizeSignals(result.signals, leverage);

    // ── GRADER (Gemini 2.5 Flash — separate context) ──
    console.log(`[APEX] Gemini Flash grader evaluating iteration ${iteration}...`);
    const graderPrompt = `You are the APEX Eagle Outcome Grader running on Gemini 2.5 Flash. You did NOT produce this output — evaluate it independently.

## RUBRIC
${OUTCOME_RUBRIC}

## AGENT OUTPUT
${JSON.stringify(normalized.map(s => ({
  asset: s.asset, action: s.action, confidence: s.confidence,
  stopLossPct: s.stopLossPct, stopLossNote: s.stopLossNote,
  takeProfitPct: s.takeProfitPct, entryNote: s.entryNote, currentPrice: s.currentPrice,
})))}

Return ONLY valid JSON:
{"passed":<true if ALL criteria pass>,"goalMet":<true if C1+C2 both pass>,"criteria":{"C1":{"pass":<bool>,"note":"<brief>"},"C2":{"pass":<bool>,"note":"<brief>"},"C3":{"pass":<bool>,"note":"<brief>"},"C4":{"pass":<bool>,"note":"<brief>"},"C5":{"pass":<bool>,"note":"<brief>"},"C6":{"pass":<bool>,"note":"<brief>"}},"feedback":"<if failed: what agent must fix. If passed: All criteria met.>"}`;

    const graderText = await callGemini(env, {
      model: "gemini-2.5-flash",
      max_tokens: 600,
      messages: [{ role: "user", content: graderPrompt }],
    });

    const graderResult = safeParseJson(graderText);
    const entry = {
      iteration,
      passed: graderResult?.passed ?? false,
      goalMet: graderResult?.goalMet ?? false,
      criteria: graderResult?.criteria ?? {},
      feedback: graderResult?.feedback ?? "Parse error",
    };
    iterLog.push(entry);

    if (graderResult?.passed || graderResult?.goalMet) {
      goalMet = true;
      console.log(`[APEX] Goal met on iteration ${iteration}`);
      return { signals: normalized, sentiment: { score: result.overallSentiment ?? 50, label: result.overallLabel ?? "NEUTRAL" }, iterLog, goalMet: true };
    } else {
      graderFeedback = graderResult?.feedback || "Criteria not met.";
      console.log(`[APEX] Iteration ${iteration} failed: ${graderFeedback}`);
    }
  }

  // Return best attempt even if goal not fully met
  if (lastResult) {
    return {
      signals: normalizeSignals(lastResult.signals, leverage),
      sentiment: { score: lastResult.overallSentiment ?? 50, label: lastResult.overallLabel ?? "NEUTRAL" },
      iterLog,
      goalMet: false,
    };
  }
  return null;
}

// ── EMAIL TEMPLATE ────────────────────────────────────────────────────────────
function buildEmail(signals, sentiment, iterLog, budget, leverage, runDate) {
  const buySignals = signals.filter(s => s.action === "BUY" && s.confidence >= MIN_CONFIDENCE);
  const tickers = buySignals.map(s => s.asset).join(", ");
  const subject = `APEX Eagle 🦅 — BUY Signal: ${tickers} (${runDate})`;

  const sentColor = sentiment.score >= 70 ? "#00e676" : sentiment.score <= 30 ? "#ff3d71" : "#ffd600";
  const rrColor = (rr) => rr >= 2 ? "#00e676" : rr >= 1.5 ? "#ffd600" : "#ff3d71";

  const signalCards = buySignals.map(sig => {
    const rr = (sig.takeProfitPct / sig.stopLossPct).toFixed(1);
    const pos = calcPositionSize(budget, RISK_PCT, sig.stopLossPct, sig.suggestedLeverage || leverage);
    const maxProfit = pos.positionSize * sig.takeProfitPct / 100;
    return `
    <div style="background:#111820;border:1px solid #1e2d3d;border-top:3px solid #00e676;border-radius:8px;padding:20px;margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
        <div>
          <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:#fff;">${sig.asset}</div>
          <div style="font-size:11px;color:#4a6070;margin-top:2px;">${sig.assetFull}</div>
          <div style="font-size:12px;color:#00e5ff;margin-top:4px;">$${sig.currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        </div>
        <div style="text-align:right;">
          <div style="background:#00e67622;border:1px solid #00e676;color:#00e676;font-weight:800;font-size:14px;letter-spacing:0.15em;padding:6px 16px;border-radius:4px;display:inline-block;">BUY</div>
          <div style="margin-top:6px;font-size:11px;color:#4a6070;">R:R <span style="color:${rrColor(rr)};font-weight:700;font-size:14px;">1:${rr}</span></div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:16px;">
        <div style="background:#0d1117;border-radius:4px;padding:10px;">
          <div style="font-size:9px;color:#4a6070;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Confidence</div>
          <div style="font-size:16px;font-weight:700;color:#00e676;">${sig.confidence}%</div>
        </div>
        <div style="background:#0d1117;border-radius:4px;padding:10px;">
          <div style="font-size:9px;color:#4a6070;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Leverage</div>
          <div style="font-size:16px;font-weight:700;color:#ffd600;">${sig.suggestedLeverage || leverage}×</div>
        </div>
        <div style="background:#0d1117;border-radius:4px;padding:10px;">
          <div style="font-size:9px;color:#4a6070;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Stop Loss</div>
          <div style="font-size:16px;font-weight:700;color:#ff3d71;">−${sig.stopLossPct}%${sig.slWasCapped ? ' ⚠' : ''}</div>
        </div>
        <div style="background:#0d1117;border-radius:4px;padding:10px;">
          <div style="font-size:9px;color:#4a6070;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Take Profit</div>
          <div style="font-size:16px;font-weight:700;color:#00e676;">+${sig.takeProfitPct}%</div>
        </div>
      </div>

      <div style="background:#0a0e14;border:1px solid #1e2d3d;border-radius:6px;padding:14px;margin-bottom:14px;">
        <div style="font-size:9px;color:#4a6070;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:10px;">Position Sizing (${fmt(budget)} portfolio · ${RISK_PCT}% risk)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;">
          <div>
            <div style="font-size:9px;color:#4a6070;margin-bottom:3px;">Position Size</div>
            <div style="font-size:13px;font-weight:700;color:#00e5ff;">${fmt(pos.positionSize)}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#4a6070;margin-bottom:3px;">Margin Required</div>
            <div style="font-size:13px;font-weight:700;color:#fff;">${fmt(pos.margin)}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#4a6070;margin-bottom:3px;">Max Risk</div>
            <div style="font-size:13px;font-weight:700;color:#ff3d71;">−${fmt(pos.riskAmount)}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#4a6070;margin-bottom:3px;">Max Profit</div>
            <div style="font-size:13px;font-weight:700;color:#00e676;">+${fmt(maxProfit)}</div>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
        <div style="background:#0d1117;border-radius:4px;padding:10px;">
          <div style="font-size:9px;color:#4a6070;text-transform:uppercase;margin-bottom:4px;">Stop Loss Level</div>
          <div style="font-size:12px;font-weight:700;color:#ff3d71;">${sig.stopLossNote || "—"}</div>
        </div>
        <div style="background:#0d1117;border-radius:4px;padding:10px;">
          <div style="font-size:9px;color:#4a6070;text-transform:uppercase;margin-bottom:4px;">Take Profit Level</div>
          <div style="font-size:12px;font-weight:700;color:#00e676;">${sig.takeProfitNote || "—"}</div>
        </div>
      </div>

      <div style="background:#0d1117;border-radius:4px;padding:12px;margin-bottom:10px;">
        <div style="font-size:9px;color:#4a6070;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">AI Chart Analysis</div>
        <div style="font-size:11px;color:#00e5ff;margin-bottom:6px;">📍 ${sig.entryNote}</div>
        <div style="font-size:11px;color:#4a6070;margin-bottom:4px;">⚡ Key level: <span style="color:#c8d8e8;">${sig.keyLevel || "—"}</span></div>
        <div style="font-size:11px;color:#4a6070;line-height:1.7;">${sig.reasoning}</div>
      </div>

      <div style="font-size:10px;color:#4a6070;display:flex;gap:16px;flex-wrap:wrap;">
        <span>Trend: <span style="color:${sig.trend === 'UPTREND' ? '#00e676' : sig.trend === 'DOWNTREND' ? '#ff3d71' : '#ffd600'}">${sig.trend || "—"}</span></span>
        <span>RSI: <span style="color:${(sig.rsi||50)>70?'#ff3d71':(sig.rsi||50)<30?'#00e676':'#c8d8e8'}">${(sig.rsi||50).toFixed(0)}${(sig.rsi||50)>70?' ⚠ OB':(sig.rsi||50)<30?' ⚡ OS':''}</span></span>
        <span>Pattern: <span style="color:#00e5ff;">${sig.patterns || "—"}</span></span>
        <span>Volume: <span style="color:${sig.volume==='ABOVE_AVG'?'#00e676':sig.volume==='BELOW_AVG'?'#ff3d71':'#4a6070'}">${sig.volume || "—"}</span></span>
      </div>

      <div style="margin-top:14px;background:#0d111799;border:1px solid rgba(0,229,255,0.15);border-radius:4px;padding:12px;">
        <div style="font-size:9px;color:#00e5ff;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px;">Execution Checklist</div>
        <div style="font-size:11px;color:#4a6070;line-height:2;">
          ① Open your broker &nbsp;&nbsp;
          ② Search: <strong style="color:#c8d8e8;">${sig.asset}</strong> &nbsp;&nbsp;
          ③ <span style="color:#00e676;">Tap TRADE</span> &nbsp;&nbsp;
          ④ Set <strong style="color:#c8d8e8;">${fmt(pos.margin)}</strong> margin · <strong style="color:#ffd600;">${sig.suggestedLeverage || leverage}×</strong> leverage<br/>
          ⑤ SL: <span style="color:#ff3d71;">${sig.stopLossNote || `−${sig.stopLossPct}%`}</span> &nbsp;&nbsp;
          ⑥ TP: <span style="color:#00e676;">${sig.takeProfitNote || `+${sig.takeProfitPct}%`}</span> &nbsp;&nbsp;
          ⑦ <span style="color:#00e5ff;">Tap OPEN TRADE</span>
        </div>
      </div>
    </div>`;
  }).join("");

  const outcomeRows = iterLog.map(it =>
    `<span style="font-size:10px;padding:2px 8px;border-radius:2px;border:1px solid ${it.goalMet ? '#00e676' : it.passed ? '#00e676' : '#ff3d71'};color:${it.goalMet ? '#00e676' : it.passed ? '#00e676' : '#ff3d71'};margin-right:6px;">
      Iter ${it.iteration}: ${it.goalMet ? 'GOAL MET' : it.passed ? 'PASS' : 'FAIL'}
    </span>`
  ).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${subject}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@700;800&display=swap" rel="stylesheet"/>
</head>
<body style="margin:0;padding:0;background:#070a0f;color:#c8d8e8;font-family:'Space Mono',monospace;">
<div style="max-width:680px;margin:0 auto;padding:24px 16px;">

  <!-- HEADER -->
  <div style="text-align:center;margin-bottom:24px;padding:24px;background:linear-gradient(135deg,#0f1018,#151722);border-radius:8px;border:1px solid #1e2d3d;">
    <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:#c8d0e0;letter-spacing:0.2em;">APEX EAGLE</div>
    <div style="font-size:10px;color:#6a5fa8;letter-spacing:0.2em;margin-top:4px;">AI TRADING CO-PILOT · SCHEDULED ANALYSIS</div>
    <div style="margin-top:16px;display:inline-flex;align-items:center;gap:12px;">
      <div style="font-size:11px;color:#4a6070;">${runDate}</div>
      <div style="font-size:11px;color:#4a6070;">·</div>
      <div style="font-size:11px;color:#4a6070;">AMD · NVDA · GOOGL</div>
      <div style="font-size:11px;color:#4a6070;">·</div>
      <div style="font-size:11px;color:#ff9500;">3% Aggressive</div>
    </div>
  </div>

  <!-- SENTIMENT + OUTCOME -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
    <div style="background:#111820;border:1px solid #1e2d3d;border-radius:6px;padding:16px;text-align:center;">
      <div style="font-size:9px;color:#4a6070;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:8px;">Market Sentiment</div>
      <div style="font-family:'Syne',sans-serif;font-size:40px;font-weight:800;color:${sentColor};line-height:1;">${sentiment.score}</div>
      <div style="font-size:10px;color:#4a6070;margin-top:4px;letter-spacing:0.1em;">${sentiment.label}</div>
    </div>
    <div style="background:#111820;border:1px solid #1e2d3d;border-radius:6px;padding:16px;">
      <div style="font-size:9px;color:#6a82d4;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:8px;">🎯 Outcome Loop</div>
      <div style="margin-bottom:8px;">${outcomeRows}</div>
      <div style="font-size:10px;color:#4a6070;">Goal: ≥1 BUY opportunity ≥${MIN_CONFIDENCE}% conf</div>
    </div>
  </div>

  <!-- BUY SIGNALS -->
  <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#00e676;letter-spacing:0.15em;margin-bottom:12px;text-transform:uppercase;">
    ▲ BUY Signals Found (${buySignals.length})
  </div>
  ${signalCards}

  <!-- ALL SIGNALS SUMMARY -->
  ${signals.filter(s => s.action !== "BUY" || s.confidence < MIN_CONFIDENCE).length > 0 ? `
  <div style="background:#111820;border:1px solid #1e2d3d;border-radius:6px;padding:16px;margin-bottom:20px;">
    <div style="font-size:9px;color:#4a6070;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:10px;">Other Signals</div>
    ${signals.filter(s => !(s.action === "BUY" && s.confidence >= MIN_CONFIDENCE)).map(s => {
      const c = s.action === "BUY" ? "#00e676" : s.action === "SELL" ? "#ff3d71" : "#ffd600";
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #1e2d3d;">
        <div>
          <span style="font-weight:700;color:#fff;">${s.asset}</span>
          <span style="font-size:10px;color:#4a6070;margin-left:8px;">${s.confidence}% conf · ${s.suggestedLeverage}× lev</span>
          ${s.currentPrice ? `<span style="font-size:10px;color:#00e5ff;margin-left:8px;">$${s.currentPrice.toLocaleString(undefined,{maximumFractionDigits:2})}</span>` : ""}
        </div>
        <span style="font-size:11px;padding:2px 10px;border-radius:2px;font-weight:700;background:${c}22;color:${c};border:1px solid ${c};">${s.action}</span>
      </div>`;
    }).join("")}
  </div>` : ""}

  <!-- FOOTER -->
  <div style="border-top:1px solid #1e2d3d;padding-top:16px;margin-top:8px;">
    <div style="font-size:10px;color:#4a6070;line-height:1.7;text-align:center;">
      ⚠ <strong style="color:#ffd600;">RISK DISCLOSURE</strong> — AI signals are for informational purposes only. Day trading involves substantial risk of loss. Past performance does not guarantee future results. Never invest more than you can afford to lose.<br/><br/>
      This email was generated automatically by APEX Eagle Scheduler on ${runDate}.<br/>
      Execute trades manually on your broker of choice.
    </div>
  </div>

</div>
</body>
</html>`;

  return { subject, html };
}

// ── SEND EMAIL VIA RESEND ─────────────────────────────────────────────────────
async function sendEmail(env, subject, html) {
  const recipient = env.RECIPIENT_EMAIL || "ingo.taraske@gmail.com";
  const from = env.FROM_EMAIL || "APEX Eagle <apex@resend.dev>";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [recipient], subject, html }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  console.log(`[APEX] Email sent. Resend ID: ${data.id}`);
  return data;
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default {
  // Cron trigger handler
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  // HTTP handler for manual test trigger
  // GET /trigger?secret=<GEMINI_API_KEY> to manually fire
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      const secret = url.searchParams.get("secret");
      if (secret !== env.GEMINI_API_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      ctx.waitUntil(run(env));
      return new Response(JSON.stringify({ status: "triggered", message: "Analysis started — check email in ~2 minutes" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ status: "ok", name: "APEX Eagle Scheduler", crons: ["Mon 06:00 UTC", "Wed 06:00 UTC"] }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};

async function run(env) {
  const budget = Number(env.BUDGET) || DEFAULT_BUDGET;
  const leverage = Number(env.LEVERAGE) || DEFAULT_LEVERAGE;
  const runDate = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Europe/Madrid",
  });

  console.log(`[APEX] Starting scheduled analysis — ${runDate}`);
  console.log(`[APEX] Assets: ${ASSETS.join(", ")} | Risk: ${RISK_PCT}% | Budget: ${fmt(budget)} | Leverage: ${leverage}×`);

  try {
    const result = await generateSignals(env, budget, leverage);
    if (!result) {
      console.log("[APEX] No signals generated — aborting");
      return;
    }

    const { signals, sentiment, iterLog, goalMet } = result;
    const buySignals = signals.filter(s => s.action === "BUY" && s.confidence >= MIN_CONFIDENCE);

    console.log(`[APEX] Signals: ${signals.map(s => `${s.asset}:${s.action}(${s.confidence}%)`).join(", ")}`);
    console.log(`[APEX] BUY signals found: ${buySignals.length} | Goal met: ${goalMet}`);

    if (buySignals.length === 0) {
      console.log("[APEX] No qualifying BUY signals — no email sent");
      return;
    }

    console.log(`[APEX] Sending email for: ${buySignals.map(s => s.asset).join(", ")}`);
    const { subject, html } = buildEmail(signals, sentiment, iterLog, budget, leverage, runDate);
    await sendEmail(env, subject, html);
    console.log("[APEX] Done ✓");
  } catch (err) {
    console.error("[APEX] Fatal error:", err.message);
    // Optionally send an error notification email
    try {
      await sendEmail(
        env,
        `APEX Eagle ⚠ Scheduler Error — ${new Date().toISOString()}`,
        `<div style="background:#070a0f;color:#c8d8e8;padding:24px;font-family:monospace;">
          <h2 style="color:#ff3d71;">Scheduler Error</h2>
          <p>${err.message}</p>
          <pre style="background:#111;padding:12px;border-radius:4px;overflow:auto;">${err.stack || "No stack trace"}</pre>
        </div>`
      );
    } catch (emailErr) {
      console.error("[APEX] Could not send error email:", emailErr.message);
    }
  }
}
