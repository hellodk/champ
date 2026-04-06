/**
 * ContextWindowManager: fits a message history into the provider's context
 * window by preserving system and recent turns while dropping older ones.
 *
 * The fitting strategy is: always keep the system message and the last
 * message, then progressively drop oldest middle messages until the total
 * fits under (contextWindow - reservedForOutput) tokens.
 */
import type { LLMMessage, LLMProvider, ContentBlock } from "./types";

const DEFAULT_RESERVED_FOR_OUTPUT = 4096;

export class ContextWindowManager {
  constructor(
    private readonly provider: LLMProvider,
    private readonly reservedForOutput?: number,
  ) {}

  /**
   * Returns the token budget available for input messages. The reserved
   * output size defaults to 4096 tokens or 25% of the context window,
   * whichever is smaller (so small context windows still have usable budget).
   */
  availableTokens(_messages: LLMMessage[]): number {
    const info = this.provider.modelInfo();
    const reserved =
      this.reservedForOutput ??
      Math.min(DEFAULT_RESERVED_FOR_OUTPUT, Math.floor(info.contextWindow / 2));
    return Math.max(0, info.contextWindow - reserved);
  }

  /**
   * Estimates the total tokens in a message list.
   */
  estimateTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.provider.countTokens(this.flattenContent(msg.content));
      // Add a small overhead per message for role markers and formatting.
      total += 4;
    }
    return total;
  }

  /**
   * Fit messages into the provider's context window. If already under budget,
   * returns the original list. Otherwise drops oldest non-system messages
   * until it fits, always preserving the system message (if present) and the
   * last message.
   */
  fitMessages(messages: LLMMessage[]): LLMMessage[] {
    const budget = this.availableTokens(messages);
    if (this.estimateTokens(messages) <= budget) {
      return messages;
    }

    // Separate system messages from the rest.
    const systemMessages = messages.filter((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    if (rest.length === 0) return messages;

    const lastMessage = rest[rest.length - 1];
    const middle = rest.slice(0, -1);

    // Drop oldest middle messages until the total fits.
    while (middle.length > 0) {
      const candidate = [...systemMessages, ...middle, lastMessage];
      if (this.estimateTokens(candidate) <= budget) {
        return candidate;
      }
      middle.shift();
    }

    // If even system + last doesn't fit, return that minimal set anyway.
    return [...systemMessages, lastMessage];
  }

  private flattenContent(content: string | ContentBlock[]): string {
    if (typeof content === "string") return content;
    return content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "tool_result") return block.content;
        return "";
      })
      .join("");
  }
}
