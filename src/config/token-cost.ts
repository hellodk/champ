/**
 * token-cost.ts — per-provider, per-model-tier token cost table.
 *
 * Rates are approximate public list prices as of 2026-05.
 * Local providers (ollama, llamacpp, vllm, openai-compatible) return 0.
 * This is intentionally a pure module with no VS Code dependencies so
 * it can be unit-tested without mocks.
 */

/**
 * Estimate the USD cost for a single LLM turn.
 * Returns 0 for local/unknown providers — cost is not meaningful for them.
 */
export function estimateCost(
  providerName: string,
  modelName: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Per-million rates [input, output] in USD
  const rates = getRates(providerName, modelName);
  return (
    (inputTokens / 1_000_000) * rates[0] + (outputTokens / 1_000_000) * rates[1]
  );
}

function getRates(provider: string, model: string): [number, number] {
  const m = model.toLowerCase();
  if (provider === "claude" || provider === "anthropic") {
    if (m.includes("haiku")) return [0.25, 1.25];
    if (m.includes("opus")) return [15, 75];
    return [3, 15]; // sonnet default
  }
  if (provider === "openai") {
    if (m.includes("gpt-4o-mini") || m.includes("4o-mini")) return [0.15, 0.6];
    if (m.includes("gpt-4o")) return [5, 15];
    if (m.includes("o1")) return [15, 60];
    return [5, 15];
  }
  if (provider === "gemini") {
    if (m.includes("flash")) return [0.075, 0.3];
    if (m.includes("pro")) return [1.25, 5];
    return [1.25, 5];
  }
  return [0, 0]; // local — free
}
