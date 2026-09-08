import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as claude from "../shared/claude.mjs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/scheduler.js", import.meta.url), "utf8");
const textResponse = (text = '{"signals":[{"asset":"AMD","action":"HOLD"}]}') => ({
  id: "msg_test", model: claude.SIGNAL_MODEL, stop_reason: "end_turn",
  content: [{ type: "text", text }], usage: { output_tokens: 100 },
});

// Execute the real request wrappers, without React or a deployed Worker.
function requestHarness(surface, response) {
  const requests = [];
  const context = vm.createContext({
    ...claude, console: { error() {} },
    sleep: async () => {}, setTimeout: callback => callback(),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });
  const source = surface === "browser"
    ? app.slice(app.indexOf("function attachDiag("), app.indexOf("// ── EAGLE SVG"))
    : worker.slice(worker.indexOf("async function callClaude("), worker.indexOf("async function fetchGroundedQuotes("));
  vm.runInContext(source, context);
  return {
    requests,
    call: body => surface === "browser"
      ? context.callApi("test-key", body)
      : context.callClaude({ ANTHROPIC_API_KEY: "test-key" }, body),
  };
}

for (const surface of ["browser", "worker"]) {
  test(`${surface}: Sonnet 5 sends thinking disabled and preserves search limits`, async () => {
    const response = textResponse();
    const harness = requestHarness(surface, response);
    const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }];
    const result = await harness.call({ max_tokens: 3000, tools, messages: [{ role: "user", content: "Analyze AMD" }] });
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].model, "claude-sonnet-5");
    assert.deepEqual(harness.requests[0].thinking, { type: "disabled" });
    assert.deepEqual(harness.requests[0].tools, tools);
    assert.equal(harness.requests[0].max_tokens, 3000);
    assert.deepEqual(surface === "browser" ? result : JSON.parse(result), surface === "browser" ? response : JSON.parse(response.content[0].text));
  });

  test(`${surface}: Haiku requests omit the Sonnet-only thinking option`, async () => {
    const harness = requestHarness(surface, textResponse());
    await harness.call({ model: "claude-haiku-4-5-20251001", messages: [] });
    assert.equal("thinking" in harness.requests[0], false);
  });

  for (const reason of ["max_tokens", "pause_turn", "refusal"]) {
    test(`${surface}: ${reason} produces diagnostics without repeating the request`, async () => {
      const harness = requestHarness(surface, {
        ...textResponse(), stop_reason: reason,
        content: [{ type: "thinking", thinking: "", signature: "private-signature" }],
        usage: { output_tokens: 3000 },
      });
      await assert.rejects(harness.call({ messages: [] }), error => {
        assert.equal(error.diag.stopReason, reason);
        assert.equal(error.diag.outputTokens, 3000);
        assert.equal(error.retryable, false);
        assert.ok(!JSON.stringify(error.diag).includes("private-signature"));
        assert.ok(!JSON.stringify(error.diag).includes("test-key"));
        return true;
      });
      assert.equal(harness.requests.length, 1);
    });
  }

  test(`${surface}: complete response without text fails explicitly`, async () => {
    const harness = requestHarness(surface, { ...textResponse(), content: [] });
    await assert.rejects(harness.call({ messages: [] }), /no analysis text/);
    assert.equal(harness.requests.length, 1);
  });
}

test("truncated responses are rejected even when their text is parseable JSON", () => {
  assert.throws(() => claude.assertCompleteResponse({ ...textResponse(), stop_reason: "max_tokens" }), /token limit/);
});

test("browser exhausts invalid attempts with a visible error and complete iteration history", async () => {
  let outcome, error, loading, requests = 0;
  const context = vm.createContext({
    ...claude, selectedAssets: ["AMD"], apiKey: "test-key", budget: 10000, riskPct: 3, leverage: 2,
    fetchGroundedQuotes: async () => ({}), formatQuoteAnchors: () => "No anchors",
    safeParseJson: JSON.parse,
    callApi: async () => { requests++; return textResponse('{"signals":[]}'); },
    setLoading: value => { loading = value; }, setError: value => { error = value; },
    setOutcomeStatus: value => { outcome = value; }, setTab() {}, setLoaderStep() {}, setSignals() {},
  });
  vm.runInContext(app.slice(app.indexOf("function attachDiag("), app.indexOf("async function callApi(")), context);
  const start = app.indexOf("  const runAnalysis = async () => {");
  const end = app.indexOf('\n  return (\n    <div style={{ background: C.bg', start);
  vm.runInContext(app.slice(start, end) + "\nglobalThis.runAnalysis = runAnalysis;", context);
  await context.runAnalysis();
  assert.equal(requests, 3);
  assert.equal(loading, false);
  assert.equal(outcome.log.length, 3);
  assert.match(error.message, /without usable signals/);
  assert.equal(error.diag.stopReason, "end_turn");
});
