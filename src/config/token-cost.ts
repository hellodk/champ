/**
 * token-cost.ts — compatibility wrapper over the versioned pricing table.
 *
 * Local providers are known and free. Unknown providers are NOT free: they
 * return NaN so an unpriced model can never be displayed or budgeted as $0.
 * Use `quoteCost()` from ./budget when a nullable quote is preferred.
 */
import { quoteCost } from "./budget";

/**
 * Estimate the USD cost for a single LLM turn from actual token usage.
 * Returns NaN for providers/models with no pricing entry.
 */
export function estimateCost(
  providerName: string,
  modelName: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const quote = quoteCost(providerName, modelName, inputTokens, outputTokens);
  return quote.usd ?? Number.NaN;
}
