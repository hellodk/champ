/**
 * ContextWindowManager: fits a message history into the provider's context
 * window by preserving system and recent turns while dropping older ones.
 *
 * The fitting strategy is: always keep the system message(s), then drop the
 * oldest *atomic groups* until the whole set fits, always preserving the newest
 * group. A group is a message, or an assistant tool call plus the tool-result
 * messages answering it — a pair that providers reject when split (#114).
 */
import type { LLMMessage, LLMProvider, ContentBlock } from "./types";

const DEFAULT_RESERVED_FOR_OUTPUT = 4096;
const PER_MESSAGE_OVERHEAD = 4;

/**
 * Group messages into drop units: a plain message is its own group, while an
 * assistant message that invokes tools absorbs the tool-result messages that
 * immediately follow it.
 *
 * Dropping one without the other produces a history that Anthropic-shaped and
 * OpenAI-shaped APIs reject outright ("tool_use ids were found without
 * tool_result blocks"), so truncation must move whole exchanges.
 */
export function atomicGroups(messages: LLMMessage[]): LLMMessage[][] {
  const groups: LLMMessage[][] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    const group: LLMMessage[] = [message];
    index += 1;

    if (toolUseIds(message).length > 0) {
      while (index < messages.length && isToolResult(messages[index])) {
        group.push(messages[index]);
        index += 1;
      }
    }
    groups.push(group);
  }
  return groups;
}

/** Tool-call ids an assistant message needs answered. */
function toolUseIds(message: LLMMessage): string[] {
  const ids = (message.toolCalls ?? []).map((call) => call.id);
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "tool_use") ids.push(block.id);
    }
  }
  return ids;
}

/** True for a message carrying tool results, in either wire shape. */
function isToolResult(message: LLMMessage): boolean {
  if (message.role === "tool") return true;
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

/**
 * Provider-reported ground truth for a message prefix (#137).
 *
 * `promptTokens` is the exact token count the provider charged for the first
 * `messageCount` messages. `fingerprint` is a cheap structural signature (role
 * + content length — no tokenization) used to verify that the prefix is still
 * the same before trusting the measurement.
 */
export interface UsageAnchor {
  promptTokens: number;
  messageCount: number;
  fingerprint: string;
}

export class ContextWindowManager {
  private anchor: UsageAnchor | null = null;

  constructor(
    private readonly provider: LLMProvider,
    private readonly reservedForOutput?: number,
  ) {}

  /**
   * Record the provider-reported prompt token count for `messages`.
   *
   * This is the authoritative count for the prefix the provider actually saw.
   * Subsequent `estimateTokens` calls that extend this same prefix reuse the
   * measured value and only tokenize the appended tail. No-ops on a
   * non-positive count (e.g. providers that omit usage), leaving the manager on
   * the deterministic full-estimate fallback.
   */
  recordUsage(messages: LLMMessage[], promptTokens: number): void {
    if (!Number.isFinite(promptTokens) || promptTokens <= 0) return;
    this.anchor = {
      promptTokens,
      messageCount: messages.length,
      fingerprint: this.fingerprint(messages, messages.length),
    };
  }

  /** Drop the measured anchor and return to full estimation. */
  clearUsage(): void {
    this.anchor = null;
  }

  /**
   * Returns the token budget available for input messages.
   *
   * Reserved output defaults to `min(4096, contextWindow / 2)`:
   *  - Large windows (≥ 8 192): reserves 4 096 tokens (~25–50%)
   *  - Small windows (< 8 192): reserves up to 50% to keep a usable
   *    output buffer even on tiny models
   *
   * Pass `reservedForOutput` to the constructor to override this.
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
   *
   * When a provider measurement exists and `messages` still begins with the
   * exact prefix it covered, the measured count is used for that prefix and
   * only the appended tail is tokenized. Otherwise the whole list is estimated.
   */
  estimateTokens(messages: LLMMessage[]): number {
    const anchor = this.anchor;
    if (
      anchor &&
      messages.length >= anchor.messageCount &&
      this.fingerprint(messages, anchor.messageCount) === anchor.fingerprint
    ) {
      return (
        anchor.promptTokens + this.estimateRange(messages, anchor.messageCount)
      );
    }
    return this.estimateRange(messages, 0);
  }

  /**
   * Estimate tokens for `messages` from `from` onward, using the provider's
   * tokenizer plus a fixed per-message overhead for role markers/formatting.
   */
  private estimateRange(messages: LLMMessage[], from: number): number {
    let total = 0;
    for (let i = from; i < messages.length; i++) {
      total += this.provider.countTokens(
        this.flattenContent(messages[i].content),
      );
      total += PER_MESSAGE_OVERHEAD;
    }
    return total;
  }

  /**
   * Cheap structural signature over the first `count` messages: role plus a
   * content-length measure. Deliberately avoids `countTokens` so the anchor
   * check never re-tokenizes the prefix. Assumes earlier messages are immutable
   * within a controller turn (history is append-only until compaction).
   */
  private fingerprint(messages: LLMMessage[], count: number): string {
    const end = Math.min(count, messages.length);
    let sig = "";
    for (let i = 0; i < end; i++) {
      sig += `${messages[i].role}:${this.contentLength(messages[i].content)}|`;
    }
    return sig;
  }

  /** Length used only for anchoring — never for token estimation. */
  private contentLength(content: string | ContentBlock[]): number {
    if (typeof content === "string") return content.length;
    let length = 0;
    for (const block of content) {
      if (block.type === "text") length += block.text.length;
      else if (block.type === "tool_result") length += block.content.length;
      else if (block.type === "tool_use")
        length += block.name.length + JSON.stringify(block.input).length;
      else length += block.imageData.length;
    }
    return length;
  }

  /**
   * Fit messages into the provider's context window. If already under budget,
   * returns the original list. Otherwise drops the oldest non-system atomic
   * groups until it fits, always preserving the system messages and the newest
   * group (so a tool call is never separated from its results).
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

    const groups = atomicGroups(rest);
    const newest = groups[groups.length - 1];
    const middle = groups.slice(0, -1);

    // Drop oldest groups until the whole set fits.
    while (middle.length > 0) {
      const candidate = [...systemMessages, ...middle.flat(), ...newest];
      if (this.estimateTokens(candidate) <= budget) {
        return candidate;
      }
      middle.shift();
    }

    // If even system + the newest group does not fit, return that minimal set
    // anyway — dropping half an exchange would be a hard API error.
    return [...systemMessages, ...newest];
  }

  /**
   * Fit messages into the context window, calling an LLM summarizer for
   * dropped turns instead of silently discarding them. Falls back to plain
   * drop behaviour if the summary is too large to fit or if summarize throws.
   */
  async fitWithSummary(
    messages: LLMMessage[],
    summarize: (dropped: LLMMessage[]) => Promise<string>,
  ): Promise<LLMMessage[]> {
    const budget = this.availableTokens(messages);
    if (this.estimateTokens(messages) <= budget) {
      return messages;
    }

    // Separate system messages from the rest.
    const systemMessages = messages.filter((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    if (rest.length === 0) return messages;

    const groups = atomicGroups(rest);
    const newest = groups[groups.length - 1];
    const middle = groups.slice(0, -1);

    // Collect dropped messages from the front until the candidate fits. Only
    // whole groups move, so the summariser never sees half a tool exchange.
    const dropped: LLMMessage[] = [];
    while (middle.length > 0) {
      const candidate = [...systemMessages, ...middle.flat(), ...newest];
      if (this.estimateTokens(candidate) <= budget) {
        break;
      }
      dropped.push(...middle.shift()!);
    }

    // Nothing needed to be dropped.
    if (dropped.length === 0) {
      return [...systemMessages, ...middle.flat(), ...newest];
    }

    // Plain-drop result used as fallback.
    const plainDrop = [...systemMessages, ...middle.flat(), ...newest];

    try {
      const summaryText = await summarize(dropped);
      const summaryMessage: LLMMessage = {
        role: "system",
        content: `[Earlier conversation summary: ${summaryText}]`,
      };
      // If the summary message itself pushes us over budget, keep dropping
      // middle groups until the full set with summary fits.
      while (middle.length > 0) {
        const withSummary = [
          ...systemMessages,
          summaryMessage,
          ...middle.flat(),
          ...newest,
        ];
        if (this.estimateTokens(withSummary) <= budget) {
          return withSummary;
        }
        middle.shift();
      }
      const withSummaryFinal = [
        ...systemMessages,
        summaryMessage,
        ...middle.flat(),
        ...newest,
      ];
      if (this.estimateTokens(withSummaryFinal) <= budget) {
        return withSummaryFinal;
      }
      // Summary too large even with all middle dropped — fall back to plain drop.
      console.warn(
        `Champ: context summariser — summary too large to fit (${this.estimateTokens(withSummaryFinal)} > ${budget}), falling back to drop`,
      );
      return plainDrop;
    } catch {
      // summarize threw — fall back to plain drop.
      return plainDrop;
    }
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
