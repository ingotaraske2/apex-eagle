export const SIGNAL_MODEL = "claude-sonnet-5";

// Sonnet 5 enables adaptive thinking by default. Apex's small JSON budgets
// were sized for thinking-off Sonnet 4.6, so preserve that behavior explicitly.
export function thinkingOptions(model) {
  return model === SIGNAL_MODEL ? { thinking: { type: "disabled" } } : {};
}

export function responseDiagnostics(data) {
  return {
    model: data.model,
    requestId: data.id,
    stopReason: data.stop_reason,
    outputTokens: data.usage?.output_tokens,
    contentTypes: (data.content || []).map(block => block.type),
  };
}

export function assertCompleteResponse(data) {
  const reason = data.stop_reason;
  let message;
  if (reason === "max_tokens") {
    message = "Analysis reached its response token limit before completing. Try fewer assets.";
  } else if (reason === "pause_turn") {
    message = "Analysis paused during web search before completing. Please retry.";
  } else if (reason === "refusal") {
    message = "The model declined this analysis request.";
  } else if (!(data.content || []).some(block => block.type === "text" && block.text?.trim())) {
    message = "The model returned no analysis text. Please retry.";
  }
  if (message) {
    const error = new Error(message);
    error.diag = responseDiagnostics(data);
    // Retrying the same incomplete request silently spends the same budget.
    error.retryable = false;
    throw error;
  }
}
