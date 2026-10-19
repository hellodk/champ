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
 * Total budget for the turn list. The compacted prefix can be long, and the
 * summariser request has to fit the same small window it is compacting for, so
 * only the newest turns are quoted; older ones are counted, not text.
 */
const MAX_PROMPT_CHARS = 8000;

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

/** The prompt asking the provider to summarise `dropped`. */
export function summariserPrompt(dropped: LLMMessage[]): string {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  // Walk backwards so the newest turns survive the budget, then restore order.
  for (let index = dropped.length - 1; index >= 0; index -= 1) {
    const line = `${dropped[index].role}: ${contentText(dropped[index]).slice(0, TURN_SLICE_CHARS)}`;
    if (used + line.length > MAX_PROMPT_CHARS) {
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
  return `${SUMMARISER_MARKER} in 2 sentences, preserving key facts and decisions:\n\n${body}`;
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
  return async (dropped) => {
    const stream = provider.chat(
      [{ role: "user", content: summariserPrompt(dropped) }],
      { abortSignal },
    );
    const parts: string[] = [];
    for await (const delta of stream) {
      if (delta.type === "text" && delta.text) parts.push(delta.text);
      if (delta.type === "done" || delta.type === "error") break;
    }
    return parts.join("").trim() || EMPTY_SUMMARY;
  };
}
