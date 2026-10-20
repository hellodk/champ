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
import { truncateToolOutput } from "../utils/tool-output-budget";

const DEFAULT_RESERVED_FOR_OUTPUT = 4096;
const PER_MESSAGE_OVERHEAD = 4;

/** Chars per token assumed when converting an over-budget amount to a cut. */
const CHARS_PER_TOKEN = 4;

/** Never shrink a tool result below this; past it the result is only a marker. */
const MIN_TOOL_RESULT_CHARS = 120;

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
    } else if (index < messages.length && isToolResult(messages[index])) {
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

/**
 * The wire shape `AgentController.formatToolResultForPromptBased` writes: a
 * user message holding `<tool_result tool="read_file" status="success">`, the
 * tool output, and a closing tag. Both attributes are required so that user
 * prose merely mentioning the tag is not mistaken for a tool result (and
 * clamped away).
 */
const PROMPT_TOOL_RESULT =
  /^<tool_result tool="[^"]*" status="(?:success|error)">\n[\s\S]*<\/tool_result>$/;

/**
 * True for the prompt-based wire shape, where a tool result is a plain user
 * message wrapping `<tool_result …>…</tool_result>` (see
 * `AgentController.formatToolResultForPromptBased`).
 */
function isPromptToolResult(message: LLMMessage): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    PROMPT_TOOL_RESULT.test(message.content.trim())
  );
}

/** True for a message carrying tool results, in either wire shape. */
function isToolResult(message: LLMMessage): boolean {
  if (message.role === "tool") return true;
  if (
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  ) {
    return true;
  }
  return typeof message.content === "string" && isPromptToolResult(message);
}

/** True when a message's string content is a clampable tool result. */
function isClampableToolText(message: LLMMessage): boolean {
  return message.role === "tool" || isPromptToolResult(message);
}

/** One tool result that `capToolResultsInMessages` is allowed to shrink. */
interface ClampableChunk {
  /** Index of the message holding it. */
  message: number;
  /** Index of the block inside the message, or -1 for string content. */
  block: number;
  chars: number;
}

/**
 * Every clampable tool result in `messages`, one entry per block: a message
 * holding ten results contributes ten chunks, so the clamp can shrink each of
 * them instead of treating the message as a single indivisible body.
 */
function clampableChunks(messages: LLMMessage[]): ClampableChunk[] {
  const chunks: ClampableChunk[] = [];
  messages.forEach((message, index) => {
    if (typeof message.content === "string") {
      if (isClampableToolText(message)) {
        chunks.push({
          message: index,
          block: -1,
          chars: message.content.length,
        });
      }
      return;
    }
    message.content.forEach((block, blockIndex) => {
      if (block.type === "tool_result") {
        chunks.push({
          message: index,
          block: blockIndex,
          chars: block.content.length,
        });
      }
    });
  });
  return chunks;
}

/**
 * Copy of `messages` with every chunk clamped to `chars * scale`, never below
 * `MIN_TOOL_RESULT_CHARS`, so the shrinkage is shared out proportionally.
 *
 * Head and tail are kept by `truncateToolOutput`, so the `<tool_result …>` /
 * `</tool_result>` wrapper a prompt-based result carries survives.
 */
function clampChunks(
  messages: LLMMessage[],
  chunks: ClampableChunk[],
  scale: number,
): LLMMessage[] {
  const plan = new Map<number, Map<number, number>>();
  for (const chunk of chunks) {
    const perBlock = plan.get(chunk.message) ?? new Map<number, number>();
    perBlock.set(
      chunk.block,
      Math.max(MIN_TOOL_RESULT_CHARS, Math.floor(chunk.chars * scale)),
    );
    plan.set(chunk.message, perBlock);
  }

  return messages.map((message, index) => {
    const perBlock = plan.get(index);
    if (!perBlock) return message;
    if (typeof message.content === "string") {
      const target = perBlock.get(-1);
      return target === undefined
        ? message
        : { ...message, content: truncateToolOutput(message.content, target) };
    }
    return {
      ...message,
      content: message.content.map((content, blockIndex) => {
        const target = perBlock.get(blockIndex);
        return content.type === "tool_result" && target !== undefined
          ? { ...content, content: truncateToolOutput(content.content, target) }
          : content;
      }),
    };
  });
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

  /**
   * Summary reuse inside one turn (#114): the dropped prefix only ever grows
   * while a controller turn is append-only, so a summary already computed for
   * the front of it can be kept and only the newly dropped messages need
   * summarising — and when nothing new was dropped, no model call is made at
   * all. A manager instance lives for one turn, so the cache cannot outlive
   * the history it describes.
   */
  private summaryCache: {
    /** Signature of the first `count` dropped messages. */
    fingerprint: string;
    count: number;
    text: string;
  } | null = null;

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

    // Even system + the newest group does not fit. Clamp the tool results in
    // what is left rather than send an over-budget request (review
    // 2026-10-19, finding 1). The clamp must see the messages that were just
    // dropped as well: when the newest group is a bare question its own
    // results are gone by now, and clamping only `system + newest` would
    // hand an empty set to the loop below and lose the very results the
    // clamp exists to shrink (review 3).
    return this.capToolResultsInMessages(
      this.clampCandidate(systemMessages, rest, newest, budget),
      budget,
    );
  }

  /**
   * The message set the last-resort clamp should work on: `system + newest`,
   * plus the tail of the dropped groups that still holds clampable tool
   * results. Those results are the ones a turn cannot continue without, and
   * clamping them keeps a call paired with its result instead of discarding
   * the pair because the newest question cannot hold it.
   */
  private clampCandidate(
    systemMessages: LLMMessage[],
    rest: LLMMessage[],
    newest: LLMMessage[],
    _budget: number,
  ): LLMMessage[] {
    const groups = atomicGroups(rest);
    // Scan back through the groups before `newest` (which is the last group),
    // keeping whole ones — so a call and its results stay together — for as
    // long as they hold clampable tool results. A group's raw size is
    // irrelevant here: the clamp is what shrinks it.
    const kept: LLMMessage[][] = [];
    for (let index = groups.length - 2; index >= 0; index -= 1) {
      const group = groups[index];
      if (clampableChunks(group).length === 0) break;
      kept.unshift(group);
    }
    if (kept.length === 0) return [...systemMessages, ...newest];
    return [...systemMessages, ...kept.flat(), ...newest];
  }

  /**
   * Fit messages into the context window, calling an LLM summarizer for
   * dropped turns instead of silently discarding them. Falls back to plain
   * drop behaviour if the summary is too large to fit or if summarize throws.
   *
   * Summaries are remembered for the life of this manager (#114): a later
   * call in the same turn only summarises messages dropped since the last one,
   * so an iteration never re-summarises a prefix it already paid for.
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
      return this.capToolResultsInMessages(
        [...systemMessages, ...middle.flat(), ...newest],
        budget,
      );
    }

    // Plain-drop result used as fallback.
    const plainDrop = [...systemMessages, ...middle.flat(), ...newest];

    try {
      // Reuse what this turn already summarised (#114): only messages dropped
      // since the last call go to the model.
      const reuse = this.reusableSummary(dropped);
      const pending = reuse ? dropped.slice(reuse.count) : dropped;
      const fresh = pending.length > 0 ? await summarize(pending) : "";
      const summaryText = [reuse?.text, fresh]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      this.summaryCache = {
        fingerprint: this.fingerprint(dropped, dropped.length),
        count: dropped.length,
        text: summaryText,
      };

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
      return this.capToolResultsInMessages(plainDrop, budget);
    } catch {
      // summarize threw — fall back to plain drop.
      return this.capToolResultsInMessages(plainDrop, budget);
    }
  }

  /**
   * The part of a previously computed summary that still applies to `dropped`,
   * or null when nothing can be reused (first call, smaller dropped set, or a
   * history that changed at the front).
   */
  private reusableSummary(
    dropped: LLMMessage[],
  ): { count: number; text: string } | null {
    const cached = this.summaryCache;
    if (!cached || dropped.length < cached.count) return null;
    if (this.fingerprint(dropped, cached.count) !== cached.fingerprint) {
      return null;
    }
    return { count: cached.count, text: cached.text };
  }

  /**
   * Last-resort fit: shrink the tool results that are still in the minimal set
   * instead of sending a request far over the budget (external review,
   * 2026-10-19, finding 1). Dropping a tool result is safe — it is data the
   * model can re-request — while dropping the newest group would throw away the
   * question, so content is clamped with the same head/tail + marker helper the
   * tool loops use before the result ever enters history.
   *
   * Returns the messages unchanged when there is nothing clampable left (the
   * newest message itself is over the window); the caller learns that from the
   * warning rather than from a silently truncated user turn.
   */
  private capToolResultsInMessages(
    messages: LLMMessage[],
    budget: number,
  ): LLMMessage[] {
    let current = messages;
    let previousChars = Number.POSITIVE_INFINITY;
    for (;;) {
      const over = this.estimateTokens(current) - budget;
      if (over <= 0) return current;

      // Every clampable result shrinks by the same ratio, so the pass cannot
      // stall on a message holding several blocks (a shared per-message budget
      // larger than a block would leave that block untouched) and a history of
      // many results converges in a couple of passes.
      const chunks = clampableChunks(current);
      const chars = chunks.reduce((total, chunk) => total + chunk.chars, 0);
      if (chars === 0 || chars >= previousChars) break;

      const keep = Math.max(0, chars - over * CHARS_PER_TOKEN);
      current = clampChunks(current, chunks, keep / chars);
      previousChars = chars;
    }

    if (this.estimateTokens(current) > budget) {
      console.warn(
        `Champ: context window — still over budget after trimming tool results (${this.estimateTokens(current)} > ${budget}); the newest message is larger than the window`,
      );
    }
    return current;
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
