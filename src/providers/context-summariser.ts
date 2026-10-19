/**
 * Context summariser: turns dropped conversation turns into a compact summary.
 *
 * This is the `summarize` callback contract of
 * `ContextWindowManager.fitWithSummary`. Shared by the interactive controller
 * and the team tool loop so both compact the same way (#137, #138): one prompt,
 * one fallback text, one place to change.
 */
import type { LLMMessage, LLMProvider } from "./types";

/** Each turn is capped so a single huge tool result cannot dominate. */
const TURN_SLICE_CHARS = 300;

/**
 * Total budget for the turn list, derived from the model's window so the
 * summariser request fits the same window it is compacting for: 20% of the
 * window in characters (≈ 25% of the window's input budget at 4 chars/token),
 * clamped so a huge window does not paste a huge prefix and a tiny window
 * still gets a usable prompt.
 */
const MAX_PROMPT_CHARS = 8000;
const MIN_PROMPT_CHARS = 256;
const SUMMARISER_WINDOW_SHARE = 0.2;

/** Character budget for `summariserPrompt` given the provider's window. */
export function summariserPromptBudget(provider: LLMProvider): number {
  try {
    const window = provider.modelInfo().contextWindow;
    if (Number.isFinite(window) && window > 0) {
      const chars = Math.floor(window * SUMMARISER_WINDOW_SHARE) * 4;
      return Math.max(MIN_PROMPT_CHARS, Math.min(MAX_PROMPT_CHARS, chars));
    }
  } catch {
    // modelInfo throwing (stub provider) — fall through to the fixed cap.
  }
  return MAX_PROMPT_CHARS;
}

/**
 * Text every summariser request starts with. Also used by tests (and the CLI
 * trace) to tell a summariser call apart from a regular agent call.
 */
export const SUMMARISER_MARKER = "Summarize this conversation";

/** Fallback when the provider returns nothing usable. */
export const EMPTY_SUMMARY = "Earlier conversation context not available.";

/** Flatten a message's content into a single string for the prompt. */
function contentText(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_result") return block.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Overhead the prompt spends on the instruction line plus the optional
 * "earlier messages omitted" line, so the turn list never pushes the request
 * past `maxPromptChars`.
 */
const PROMPT_OVERHEAD = 64;

/** The prompt asking the provider to summarise `dropped`. */
export function summariserPrompt(
  dropped: LLMMessage[],
  maxPromptChars: number = MAX_PROMPT_CHARS,
): string {
  const header = `${SUMMARISER_MARKER} in 2 sentences, preserving key facts and decisions:\n\n`;
  const lines: string[] = [];
  let used = header.length + PROMPT_OVERHEAD;
  let omitted = 0;
  // Walk backwards so the newest turns survive the budget, then restore order.
  for (let index = dropped.length - 1; index >= 0; index -= 1) {
    const line = `${dropped[index].role}: ${contentText(dropped[index]).slice(0, TURN_SLICE_CHARS)}`;
    if (used + line.length > maxPromptChars) {
      omitted = index + 1;
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  const body = [
    omitted > 0 ? `… [${omitted} earlier message(s) omitted]` : "",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
  return `${header}${body}`;
}

/**
 * Build the summariser used by `fitWithSummary`.
 *
 * Calls the provider directly (never the agent loop), so it cannot re-enter
 * fitting: the request is always the single small prompt above.
 */
export function createContextSummariser(
  provider: LLMProvider,
  abortSignal?: AbortSignal,
): (dropped: LLMMessage[]) => Promise<string> {
  const maxPromptChars = summariserPromptBudget(provider);
  return async (dropped) => {
    const stream = provider.chat(
      [{ role: "user", content: summariserPrompt(dropped, maxPromptChars) }],
      { abortSignal },
    );
    const parts: string[] = [];
    for await (const delta of stream) {
      if (delta.type === "text" && delta.text) parts.push(delta.text);
      // A failed summarise is not a usable summary: throw so `fitWithSummary`
      // takes its plain-drop fallback instead of substituting a placeholder
      // that claims the dropped turns were summarised.
      if (delta.type === "error") {
        throw new Error(
          `context summariser failed: ${delta.error ?? "provider error"}`,
        );
      }
      if (delta.type === "done") break;
    }
    return parts.join("").trim() || EMPTY_SUMMARY;
  };
}
