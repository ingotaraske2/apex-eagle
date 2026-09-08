// Opt-in live API check. Read the credential from stdin, never from arguments
// or project files. Only Anthropic requests are permitted; no emails are sent.
// Run with terminal echo disabled when entering a credential interactively.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import vm from "node:vm";
import assert from "node:assert/strict";
import * as claude from "../shared/claude.mjs";

console.log("Awaiting credential on standard input.");
const input = createInterface({ input: process.stdin, terminal: false });
const [line] = await once(input, "line");
input.close();
const apiKey = line.trim().replaceAll("\\_", "_");
if (!apiKey.startsWith("sk-ant-")) throw new Error("Expected an Anthropic credential.");
const log = (...values) => console.log(...values.map(v => String(v).replaceAll(apiKey, "[REDACTED]")));
const assets = ["AMD", "NVDA", "GOOGL"];
const summaries = [];

async function runSurface(surface) {
  let requests = 0;
  const state = { signals: [], signalLog: [] };
  const context = vm.createContext({
    ...claude, apiKey, selectedAssets: assets, budget: 10000, riskPct: 3, leverage: 2,
    console: { log, error: log, warn: log }, setTimeout,
    useCallback: fn => fn,
    fetch: async (url, init) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      if (++requests > 10) throw new Error("Live test request limit reached.");
      const body = JSON.parse(init.body);
      const started = Date.now();
      log(`${surface}: request ${requests}, ${body.model}, max_tokens=${body.max_tokens}, thinking=${body.thinking?.type || "default"}`);
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120000) });
      const data = await response.clone().json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      // Use the production parser: search responses may include text before JSON.
      const parsed = context.safeParseJson(text);
      const summary = {
        surface, http: response.status, ...claude.responseDiagnostics(data),
        elapsedMs: Date.now() - started, inputTokens: data.usage?.input_tokens,
        searches: data.usage?.server_tool_use?.web_search_requests,
        validJson: Boolean(parsed), signalCount: parsed?.signals?.length,
        quotes: parsed?.quotes?.map(q => ({ asset: q.asset, currentPrice: q.currentPrice, source: q.source })),
        signals: parsed?.signals?.map(s => ({ asset: s.asset, currentPrice: s.currentPrice, action: s.action })),
        errorType: data.error?.type,
      };
      summaries.push(summary);
      log(JSON.stringify(summary));
      return response;
    },
  });
  if (surface === "browser") {
    for (const name of ["Loading", "Error", "Signals", "SignalLog", "OutcomeStatus", "Sentiment", "RiskSummary", "Tab", "LoaderStep"]) {
      const field = name[0].toLowerCase() + name.slice(1);
      context[`set${name}`] = value => {
        state[field] = typeof value === "function" ? value(state[field]) : value;
        if (name === "LoaderStep") log(`${surface}: ${state[field]}`);
      };
    }
    const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    vm.runInContext(app.slice(app.indexOf("const DEFAULT_CATEGORIES"), app.indexOf("// ── FIREBASE AUTH")), context);
    vm.runInContext(app.slice(app.indexOf("function attachDiag("), app.indexOf("// ── EAGLE SVG")), context);
    const start = app.indexOf("  const fetchGroundedQuotes = useCallback");
    const end = app.indexOf('\n  return (\n    <div style={{ background: C.bg', start);
    vm.runInContext(app.slice(start, end) + "\nglobalThis.runAnalysis = runAnalysis;", context);
    await context.runAnalysis();
    if (state.error) throw new Error(`${surface}: ${state.error.message}`);
    assert.equal(state.loading, false);
    assert.equal(state.signalLog.length, assets.length);
  } else {
    const source = readFileSync(new URL("../worker/scheduler.js", import.meta.url), "utf8");
    vm.runInContext(source.slice(source.indexOf("const ASSETS"), source.indexOf("// ── EMAIL TEMPLATE")), context);
    const result = await context.generateSignals({ ANTHROPIC_API_KEY: apiKey }, 10000, 2);
    assert.ok(result, "Worker must return a result");
    state.signals = result.signals;
    state.outcomeStatus = result;
  }
  assert.deepEqual(Array.from(state.signals, s => s.asset).sort(), [...assets].sort());
  log(JSON.stringify({ surface, prices: Array.from(state.signals, s => ({ asset: s.asset, currentPrice: s.currentPrice, modelCurrentPrice: s.modelCurrentPrice, quoteSource: s.quoteSource })) }));
  assert.ok(state.signals.every(s => Number.isFinite(s.currentPrice) && s.currentPrice > 0));
  log(JSON.stringify({ surface, success: true, signalCount: state.signals.length, goalMet: state.outcomeStatus.goalMet, requests }));
}

try {
  const surface = process.argv[2];
  for (const name of surface ? [surface] : ["browser", "worker"]) {
    assert.ok(["browser", "worker"].includes(name));
    await runSurface(name);
  }
  log("Live analysis checks passed.");
} catch (error) {
  log(`Live analysis failed: ${error.message}`);
  process.exitCode = 1;
}
