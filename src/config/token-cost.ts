/**
 * token-cost.ts — static per-provider token cost table.
 *
 * Rates are approximate public list prices as of 2026-05.
 * Local providers (ollama, llamacpp, vllm, openai-compatible) return 0.
 * This is intentionally a pure module with no VS Code dependencies so
 * it can be unit-tested without mocks.
 */

interface CostRate {
  /** USD per million input tokens */
  inputPerMillion: number;
  /** USD per million output tokens */
  outputPerMillion: number;
}

const COST_TABLE: Record<string, CostRate> = {
  claude: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  openai: { inputPerMillion: 5.0, outputPerMillion: 15.0 },
  gemini: { inputPerMillion: 1.25, outputPerMillion: 5.0 },
};

/**
 * Estimate the USD cost for a single LLM turn.
 * Returns 0 for local/unknown providers — cost is not meaningful for them.
 */
export function estimateCost(
  providerName: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = COST_TABLE[providerName.toLowerCase()];
  if (!rate) return 0;
  return (
    (inputTokens / 1_000_000) * rate.inputPerMillion +
    (outputTokens / 1_000_000) * rate.outputPerMillion
  );
}
