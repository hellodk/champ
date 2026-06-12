/**
 * AgentController: the single-agent loop.
 *
 * Receives a user message, streams an LLM response, parses tool calls,
 * executes them via the ToolRegistry, feeds results back to the LLM, and
 * repeats until the LLM produces a text-only response or an iteration
 * limit is hit.
 *
 * Supports two tool-calling modes transparently:
 *   - **Native**: providers with supportsToolUse() === true receive
 *     ToolDefinition[] in the chat options and emit tool_call_start
 *     deltas in their stream.
 *   - **Prompt-based**: providers without native tool calling get
 *     XML tool definitions injected into a system prompt; the agent
 *     parses <tool_call> blocks from the response text and executes
 *     them. Tool results are formatted as <tool_result> blocks in
 *     the next user message.
 *
 * The mode is selected automatically based on the provider's capability
 * report — callers don't need to know which path is in use.
 */
import type {
  LLMProvider,
  LLMMessage,
  StreamDelta,
  ToolCall,
  ToolDefinition,
  ContentBlock,
} from "../providers/types";
import {
  parseToolCallsFromText,
  extractTextContent,
  extractPreToolText,
} from "../providers/prompt-based-tools";
import { SecretScanner } from "../safety/secret-scanner";
import { PiiScanner } from "../safety/pii-scanner";
import { PromptGuard, PromptInjectionError } from "../safety/prompt-guard";
import type { SmartRouter, TaskType } from "../providers/smart-router";
import type { ToolRegistry } from "../tools/registry";
import type { ToolExecutionContext, ToolResult } from "../tools/types";
import { ContextWindowManager } from "../providers/context-manager";
import type { MemoryBank } from "../memory/memory-bank";
import { SystemPromptBuilder } from "./system-prompt-builder";
import { StagedEdits } from "./staged-edits";
import type { ResponseCache } from "../providers/response-cache";

export { PromptInjectionError };

const DEFAULT_MAX_ITERATIONS = 25;

// PROMPT_BASED_BASE_INSTRUCTIONS and MODE_INSTRUCTIONS live in
// src/agent/system-prompt-builder.ts — see SystemPromptBuilder.

export interface ProcessMessageOptions {
  abortSignal?: AbortSignal;
  maxIterations?: number;
  /** Approval callback invoked before destructive tool calls. */
  requestApproval?: (description: string) => Promise<boolean>;
  /** Called after user input PII is redacted, before the LLM is called. */
  onPiiRedacted?: (summary: string) => void;
}

export interface ProcessMessageResult {
  text: string;
  toolCalls: Array<{ call: ToolCall; result: ToolResult }>;
}

export type StreamDeltaListener = (delta: StreamDelta) => void;
export type IterationStartListener = (
  iteration: number,
  totalTokens: number,
) => void;

/**
 * Optional grounding source. If supplied, AgentController calls
 * getRepoMap() once per session and prepends the result to the system
 * prompt so the model has factual workspace context. The repo map
 * builder lives in src/indexing/repo-map-builder.ts.
 */
export interface RepoMapProvider {
  getRepoMap(): Promise<string>;
}

/**
 * Available agent modes. See SystemPromptBuilder for the per-mode
 * system prompt content. Mode controls:
 *  - which tools are exposed to the model
 *  - which mode-specific instructions are appended to the system prompt
 */
export type AgentMode = "agent" | "ask" | "manual" | "plan" | "composer";

/**
 * Tools that read state but never modify it. Allowed in every mode.
 */
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "grep_search",
  "file_search",
  "codebase_search",
  "web_search",
]);

export class AgentController {
  private history: LLMMessage[] = [];
  private streamListeners = new Set<StreamDeltaListener>();
  private iterationStartListeners = new Set<IterationStartListener>();
  private workspaceRoot: string;
  private provider: LLMProvider;
  private repoMapProvider: RepoMapProvider | undefined;
  private cachedRepoMap: string | undefined;
  private mode: AgentMode = "agent";
  /**
   * Secret scanner used to redact API keys, passwords, and other
   * sensitive strings from tool outputs before they're added to the
   * conversation history (and therefore sent to the LLM on the next
   * turn). See docs/HALLUCINATION_MITIGATION.md and src/safety/.
   */
  private readonly secretScanner = new SecretScanner();
  private readonly piiScanner = new PiiScanner();
  private promptGuard = new PromptGuard();
  private smartRouter: SmartRouter | null = null;
  // Inline import type avoids a top-level circular-dependency risk; analytics
  // is optional infrastructure and should not be in the core import chain.
  private analyticsInstance:
    | import("../observability/agent-analytics").AgentAnalytics
    | null = null;
  private analyticsAgentName = "champ";
  /**
   * Files the model has read in this session. Used to enforce the
   * "read before edit" rule from docs/HALLUCINATION_MITIGATION.md —
   * before edit_file is called on a path not in this set, the agent
   * auto-injects a read_file call first.
   */
  private filesReadThisSession = new Set<string>();
  /**
   * MemoryBank for this workspace session. Used for two purposes:
   *  1. Injecting pinned/recent context into the system prompt (delegated to systemPromptBuilder).
   *  2. Storing interaction summaries after each message.
   */
  private memoryBank: MemoryBank | undefined;
  private editReviewTracker?: import("./edit-review-tracker").EditReviewTracker;
  private responseCache: ResponseCache | null = null;
  /** True while a processMessage() call is actively executing (streaming or tool calls). */
  private _isProcessing = false;
  /** FIFO queue of processMessage() calls that arrived while _isProcessing was true. */
  private _messageQueue: Array<{
    userText: string | import("../providers/types").ContentBlock[];
    options: ProcessMessageOptions;
    resolve: (r: ProcessMessageResult) => void;
    reject: (e: unknown) => void;
  }> = [];
  /** Provider swap queued while _isProcessing was true. Applied after the current call ends. */
  private _pendingProvider: LLMProvider | null = null;
  private _auditLog?: import("../observability/audit-log").AuditLog;
  /** Owns all system prompt construction. Injectable for tests. */
  private readonly systemPromptBuilder: SystemPromptBuilder;

  constructor(
    provider: LLMProvider,
    private readonly toolRegistry: ToolRegistry,
    workspaceRoot = process.cwd(),
    systemPromptBuilder?: SystemPromptBuilder,
  ) {
    this.provider = provider;
    this.workspaceRoot = workspaceRoot;
    this.systemPromptBuilder =
      systemPromptBuilder ?? new SystemPromptBuilder("agent");
  }

  setEditReviewTracker(
    tracker: import("./edit-review-tracker").EditReviewTracker,
  ): void {
    this.editReviewTracker = tracker;
  }

  /** Wire the audit log — called from extension.ts after activation. */
  setAuditLog(log: import("../observability/audit-log").AuditLog): void {
    this._auditLog = log;
  }

  /**
   * Attach a TTL-based response cache. When set, single-turn responses
   * (no tool calls) are looked up in the cache before calling the provider
   * and stored in the cache after receiving a complete response. Pass null
   * to disable caching.
   */
  setResponseCache(cache: ResponseCache | null): void {
    this.responseCache = cache;
  }

  /**
   * Attach a repo-map provider. If supplied, the map is fetched lazily
   * on the first processMessage() call and cached for the session.
   */
  setRepoMapProvider(provider: RepoMapProvider): void {
    this.repoMapProvider = provider;
    this.cachedRepoMap = undefined;
  }

  /**
   * Set the active agent mode. Affects which tools are exposed to the
   * model and which mode-specific instructions are appended to the
   * system prompt.
   */
  setMode(mode: AgentMode): void {
    this.mode = mode;
    this.systemPromptBuilder.setMode(mode);
  }

  getMode(): AgentMode {
    return this.mode;
  }

  /** Attach an analytics recorder for this controller's sessions. Called once after construction. */
  setAnalytics(
    analytics: import("../observability/agent-analytics").AgentAnalytics,
    agentName = "champ",
  ): void {
    this.analyticsInstance = analytics;
    this.analyticsAgentName = agentName;
  }

  setSmartRouter(router: SmartRouter): void {
    this.smartRouter = router;
  }

  setPromptGuardEnabled(enabled: boolean): void {
    this.promptGuard = new PromptGuard(enabled);
  }

  /**
   * Inject project/user rules content into every system prompt built by
   * this controller. Called from loadProvider() after RulesEngine has
   * loaded rules from disk. Pass an empty string to clear.
   */
  setProjectRules(content: string): void {
    this.systemPromptBuilder.setProjectRules(content);
  }

  /** Attach a MemoryBank so cross-session facts are injected into prompts. */
  setMemoryBank(bank: MemoryBank): void {
    this.memoryBank = bank;
    this.systemPromptBuilder.setMemoryBank(bank);
  }

  /** Attach a global (user-level, cross-workspace) MemoryBank. */
  setGlobalMemoryBank(bank: MemoryBank): void {
    this.systemPromptBuilder.setGlobalMemoryBank(bank);
  }

  /** Map agent mode to a SmartRouter task type for model selection. */
  private modeToTaskType(mode: AgentMode): TaskType {
    switch (mode) {
      case "agent":
      case "composer":
        return "coding";
      case "ask":
      case "plan":
      case "manual":
      default:
        return "chat";
    }
  }

  /**
   * Filter the full tool catalog based on the active mode. Ask and
   * Plan modes restrict to read-only tools; other modes expose all
   * tools.
   */
  private filterToolsByMode(allTools: ToolDefinition[]): ToolDefinition[] {
    if (this.mode === "ask" || this.mode === "plan") {
      return allTools.filter((t) => READ_ONLY_TOOLS.has(t.name));
    }
    return allTools;
  }

  /**
   * Hot-swap the active LLM provider. Used when the user changes the
   * provider setting at runtime — the agent picks up the new provider
   * on the next call to processMessage() without needing a re-init.
   *
   * If a stream is currently in flight, the swap is queued and applied
   * atomically after the stream ends to prevent mid-stream provider
   * corruption (tool-format mismatches, history inconsistency).
   */
  setProvider(provider: LLMProvider): void {
    if (this._isProcessing) {
      // Queue the swap — applied after the active processMessage() call finishes.
      this._pendingProvider = provider;
      return;
    }
    this.provider = provider;
  }

  /**
   * Get the currently active LLM provider.
   */
  getProvider(): LLMProvider {
    return this.provider;
  }

  /**
   * Register a listener for streaming deltas. Used by the UI to render
   * text as it arrives.
   */
  onStreamDelta(listener: StreamDeltaListener): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  /**
   * Register a listener called at the start of each agent iteration with
   * the current iteration index (0-based) and the cumulative token count
   * so far. Used by the UI to show a live progress indicator during long runs.
   */
  onIterationStart(listener: IterationStartListener): () => void {
    this.iterationStartListeners.add(listener);
    return () => this.iterationStartListeners.delete(listener);
  }

  /**
   * Get a snapshot of the conversation history.
   */
  getHistory(): LLMMessage[] {
    return [...this.history];
  }

  /**
   * Clear conversation history and per-session caches. Called when the
   * user starts a new chat.
   */
  reset(): void {
    this.history = [];
    this.cachedRepoMap = undefined;
    this.filesReadThisSession.clear();
  }

  /** Replace conversation history (used when restoring persisted sessions). */
  setHistory(messages: LLMMessage[]): void {
    this.history = [...messages];
  }

  /** Remove all history entries at index >= from. */
  truncateHistory(from: number): void {
    this.history.splice(from);
  }

  /**
   * Lazily fetch the repo map from the configured provider, caching
   * the result for the session. Returns empty string if no provider
   * is attached or if the fetch fails.
   */
  private async getRepoMap(): Promise<string> {
    if (this.cachedRepoMap !== undefined) return this.cachedRepoMap;
    if (!this.repoMapProvider) {
      this.cachedRepoMap = "";
      return "";
    }
    try {
      this.cachedRepoMap = await this.repoMapProvider.getRepoMap();
    } catch {
      this.cachedRepoMap = "";
    }
    return this.cachedRepoMap;
  }

  /**
   * Process a user message through the full agent loop.
   * If a call is already in progress, the new call is queued and resolved
   * in FIFO order after the current call completes.
   */
  async processMessage(
    userText: string | ContentBlock[],
    options: ProcessMessageOptions = {},
  ): Promise<ProcessMessageResult> {
    if (this._isProcessing) {
      return new Promise<ProcessMessageResult>((resolve, reject) => {
        this._messageQueue.push({ userText, options, resolve, reject });
      });
    }
    return this._runMessage(userText, options);
  }

  /**
   * Internal implementation of processMessage(). Contains the full agent loop.
   * Always called with _isProcessing === false; sets it true for its duration.
   */
  private async _runMessage(
    userText: string | ContentBlock[],
    options: ProcessMessageOptions = {},
  ): Promise<ProcessMessageResult> {
    this._isProcessing = true;
    try {
      const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

      // ── Smart routing: pick the best provider for this agent mode ─────────
      // Selection is done once per message (not per-iteration) to avoid
      // tool-calling format mismatches mid-conversation.
      let activeProvider = this.provider;
      if (this.smartRouter) {
        const taskType = this.modeToTaskType(this.mode);
        const routed = this.smartRouter.select(taskType);
        if (routed) {
          const routedPromptBased = !routed.provider.supportsToolUse();
          const currentPromptBased = !this.provider.supportsToolUse();
          const hasHistory = this.history.length > 0;

          if (routedPromptBased === currentPromptBased || !hasHistory) {
            // Same tool format, or no history yet — safe to route.
            activeProvider = routed.provider;
            console.log(
              `Champ SmartRouter: ${this.mode} → ${routed.model.id} [${routed.reason}]`,
            );
          } else {
            console.log(
              `Champ SmartRouter: skipping ${routed.model.id} — ` +
                `tool format mismatch with existing history`,
            );
          }
        }
      }

      // ── Prompt injection guard ────────────────────────────────────────────
      // Check the raw text before anything else. Blocks the request if an
      // injection attempt is detected and fires telemetry.
      const rawText = Array.isArray(userText)
        ? userText
            .filter(
              (b): b is ContentBlock & { type: "text" } => b.type === "text",
            )
            .map((b) => b.text)
            .join(" ")
        : userText;

      const guardResult = this.promptGuard.check(rawText);
      if (!guardResult.safe) {
        // Emit a text delta so the UI can show the block reason inline.
        this.emit({
          type: "text",
          text: `⛔ **Request blocked** — ${guardResult.reason}`,
        });
        throw new PromptInjectionError(guardResult);
      }

      // ── PII redaction ─────────────────────────────────────────────────────
      // Scan the user's message text and replace PII before it goes to history
      // (and therefore to the LLM). Non-text content blocks are not modified.
      if (typeof userText === "string") {
        const piiResult = this.piiScanner.scan(userText);
        if (piiResult.hasFindings) {
          const types = [
            ...new Set(piiResult.findings.map((f) => f.type)),
          ].join(", ");
          const summary = `${piiResult.findings.length} value(s) redacted before sending (${types})`;
          console.log(`Champ PII: ${summary}`);
          options.onPiiRedacted?.(summary);
          userText = piiResult.redacted;
        }
      } else {
        const allFindings: import("../safety/pii-scanner").PiiFinding[] = [];
        userText = userText.map((block) => {
          if (block.type !== "text") return block;
          const piiResult = this.piiScanner.scan(block.text);
          if (piiResult.hasFindings) allFindings.push(...piiResult.findings);
          return piiResult.hasFindings
            ? { ...block, text: piiResult.redacted }
            : block;
        });
        if (allFindings.length > 0) {
          const types = [...new Set(allFindings.map((f) => f.type))].join(", ");
          const summary = `${allFindings.length} value(s) redacted before sending (${types})`;
          console.log(`Champ PII: ${summary}`);
          options.onPiiRedacted?.(summary);
        }
      }

      // ── Image stripping for non-vision providers ──────────────────────────
      if (Array.isArray(userText)) {
        const supportsImages = activeProvider.modelInfo().supportsImages;
        if (!supportsImages) {
          const textParts = userText
            .filter(
              (b): b is ContentBlock & { type: "text" } => b.type === "text",
            )
            .map((b) => b.text)
            .join("\n");
          const imageCount = userText.filter((b) => b.type === "image").length;
          const combined =
            imageCount > 0
              ? `${textParts}\n\n[${imageCount} image(s) attached — this provider does not support image input]`
              : textParts;
          // Re-scan the collapsed string for PII — the image placeholder
          // itself is safe, but text parts from blocks were already redacted
          // individually; this second pass is a safety net for anything
          // introduced by the join or the image note.
          const postStripPii = this.piiScanner.scan(combined);
          if (postStripPii.hasFindings) {
            const types = [
              ...new Set(postStripPii.findings.map((f) => f.type)),
            ].join(", ");
            const summary = `${postStripPii.findings.length} value(s) redacted before sending (${types})`;
            options.onPiiRedacted?.(summary);
            userText = postStripPii.redacted;
          } else {
            userText = combined;
          }
        }
      }

      this.history.push({ role: "user", content: userText });

      // Reset the system prompt cache at the start of each message so it's rebuilt fresh
      this.systemPromptBuilder.invalidateCache();

      const collectedText: string[] = [];
      const collectedToolCalls: Array<{ call: ToolCall; result: ToolResult }> =
        [];

      const usePromptBased = !activeProvider.supportsToolUse();
      // Filter tools by the active mode (Ask/Plan = read-only).
      const allTools = this.filterToolsByMode(
        this.toolRegistry.getDefinitions(),
      );
      // Fetch the repo map once per session for grounding. Cached after
      // first call. Empty string if no provider attached.
      const repoMap = await this.getRepoMap();
      // Context window manager — created once per message, reused across iterations.
      const contextManager = new ContextWindowManager(activeProvider);

      // Analytics tracking — optional; must not affect message processing if it fails.
      const toolStartTimes = new Map<string, number>();
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let hadError = false;
      let analyticsActive = false;
      if (this.analyticsInstance) {
        try {
          this.analyticsInstance.startTask(this.analyticsAgentName);
          analyticsActive = true;
        } catch {
          // ignore — analytics failure must not break the message path
        }
      }

      // Staging buffer: all edit_file calls within this agent turn write to
      // this buffer instead of disk. Flushed atomically after the loop ends.
      const stagedEdits = new StagedEdits();

      let iterationRan = false;
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (options.abortSignal?.aborted) break;
        iterationRan = true;

        // Emit iteration start event so the UI can display live progress.
        this.emitIterationStart(
          iteration,
          totalInputTokens + totalOutputTokens,
        );

        // Yield to the event loop between iterations. This keeps the VS Code
        // extension host responsive and allows cancellation signals (abort,
        // UI interactions) to be processed between agent steps.
        if (iteration > 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (options.abortSignal?.aborted) break;
        }

        const pendingToolCalls: ToolCall[] = [];
        let assistantText = "";

        // Build the message list to send. In prompt-based mode we prepend
        // (or merge into) a system message with the tool catalog as XML.
        // For native-tool-calling providers we still inject the repo map
        // and base directives as a system message — they need grounding too.
        const rawMessages = usePromptBased
          ? this.systemPromptBuilder.withInjectedToolPrompt(
              this.history,
              allTools,
              repoMap,
            )
          : this.systemPromptBuilder.withGroundingSystemPrompt(
              this.history,
              repoMap,
            );

        // Fit into context window — summarises dropped turns via LLM instead of
        // silently discarding them. Falls back to plain drop if summarize throws.
        const messagesToSend = await contextManager.fitWithSummary(
          rawMessages,
          async (dropped) => {
            const turns = dropped
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => {
                const text =
                  typeof m.content === "string"
                    ? m.content.slice(0, 300)
                    : (m.content as ContentBlock[])
                        .filter(
                          (b): b is ContentBlock & { type: "text" } =>
                            b.type === "text",
                        )
                        .map((b) => b.text)
                        .join(" ")
                        .slice(0, 300);
                return `${m.role}: ${text}`;
              })
              .join("\n");
            // Safe: calls the provider directly (not processMessage), so fitWithSummary
            // is never re-entered. The summarization request is always a single small message.
            const summaryStream = activeProvider.chat(
              [
                {
                  role: "user",
                  content: `Summarize this conversation in 2 sentences, preserving key facts and decisions:\n\n${turns}`,
                },
              ],
              { abortSignal: options.abortSignal },
            );
            const parts: string[] = [];
            for await (const delta of summaryStream) {
              if (delta.type === "text" && delta.text) parts.push(delta.text);
              if (delta.type === "done" || delta.type === "error") break;
            }
            return (
              parts.join("").trim() ||
              "Earlier conversation context not available."
            );
          },
        );
        if (messagesToSend.length < rawMessages.length) {
          const dropped = rawMessages.length - messagesToSend.length;
          console.log(
            `Champ: context window — compacted ${dropped} oldest message(s) into summary`,
          );
        }

        // ── Response cache lookup ─────────────────────────────────────────────
        // Only cache on the first iteration (no tool calls yet) and when there
        // are no tool calls in-flight. Tool-using responses are never cached
        // because they depend on live workspace state.
        // Include tool names in cache key so different tool sets produce different keys.
        const toolNames = allTools
          .map((t) => t.name)
          .sort()
          .join(",");
        const cacheMessagesJson =
          this.responseCache && iteration === 0
            ? `${JSON.stringify(messagesToSend)}::tools:${toolNames}`
            : null;
        const cachedResponse =
          cacheMessagesJson && this.responseCache
            ? this.responseCache.get(
                activeProvider.modelInfo().name,
                activeProvider.modelInfo().id ?? "",
                cacheMessagesJson,
              )
            : null;

        if (cachedResponse !== null) {
          // Cache hit — emit the stored response as if it came from the provider.
          console.log("Champ ResponseCache: hit");
          this.emit({ type: "text", text: cachedResponse });
          collectedText.push(cachedResponse);
          assistantText = cachedResponse;
          this.history.push({ role: "assistant", content: cachedResponse });
          // No tool calls — break immediately.
          break;
        }

        const stream = activeProvider.chat(messagesToSend, {
          // Native tool defs only when the provider says it supports them.
          tools: usePromptBased ? undefined : allTools,
          abortSignal: options.abortSignal,
        });

        let errorOccurred = false;
        for await (const delta of stream) {
          if (delta.type === "text" && delta.text) {
            assistantText += delta.text;
            if (!usePromptBased) {
              // Native mode: stream text directly to the UI for live render.
              this.emit(delta);
              collectedText.push(delta.text);
            }
            // In prompt-based mode we buffer the text so we can strip out
            // the <tool_call> XML before showing it to the user.
          } else if (delta.type === "tool_call_start" && delta.toolCall) {
            // In native mode, if no text has been streamed yet, emit a synthetic
            // prefix so the user sees activity rather than a silent spinner.
            if (
              !usePromptBased &&
              assistantText.length === 0 &&
              pendingToolCalls.length === 0
            ) {
              this.emit({
                type: "text",
                text: `Using \`${delta.toolCall.name}\`…\n`,
              });
            }
            pendingToolCalls.push(delta.toolCall);
            toolStartTimes.set(delta.toolCall.id, Date.now());
            this.emit(delta);
          } else if (delta.type === "tool_call_end") {
            this.emit(delta);
          } else if (delta.type === "done") {
            totalInputTokens += delta.usage.inputTokens;
            totalOutputTokens += delta.usage.outputTokens;
            this.emit(delta);
            break;
          } else if (delta.type === "error") {
            this.emit(delta);
            errorOccurred = true;
            break;
          } else {
            this.emit(delta);
          }
        }
        if (errorOccurred) {
          hadError = true;
          if (analyticsActive && this.analyticsInstance) {
            try {
              this.analyticsInstance.recordTokens(
                this.analyticsAgentName,
                totalInputTokens,
                totalOutputTokens,
              );
              this.analyticsInstance.endTask(
                this.analyticsAgentName,
                false,
                "stream error",
              );
            } catch {
              // ignore — analytics failure must not break the message path
            }
          }
          return {
            text: collectedText.join(""),
            toolCalls: collectedToolCalls,
          };
        }

        // Prompt-based mode: parse <tool_call> blocks out of the buffered
        // response text, then emit a cleaned text delta to the UI so the
        // user sees prose without the XML noise.
        if (usePromptBased && assistantText) {
          const parsed = parseToolCallsFromText(assistantText);
          const promptToolStart = Date.now();
          for (const call of parsed) {
            pendingToolCalls.push(call);
            toolStartTimes.set(call.id, promptToolStart);
          }
          const cleaned = extractPreToolText(assistantText);
          if (cleaned) {
            this.emit({ type: "text", text: cleaned });
            collectedText.push(cleaned);
          }
          for (const call of parsed) {
            this.emit({ type: "tool_call_start", toolCall: call });
          }
        }

        // Persist the assistant turn to history. Strip any fabricated
        // <tool_output> blocks that the model self-generated (Qwen models
        // often output both the tool call AND a fake result in one turn).
        // We keep the tool_call blocks so the model stays consistent.
        const historyText = assistantText
          .replace(
            /<｜tool▁outputs▁begin｜>[\s\S]*?<｜tool▁outputs▁end｜>/g,
            "",
          )
          .trim();
        const assistantMessage: LLMMessage = {
          role: "assistant",
          content: historyText || assistantText,
          toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
        };
        this.history.push(assistantMessage);

        // If the model produced no tool calls, we're done.
        if (pendingToolCalls.length === 0) {
          // ── Response cache store ──────────────────────────────────────────
          // Only cache clean, tool-free responses. Store the raw assistant text
          // (before prompt-based cleaning) so the same content is returned on hit.
          if (this.responseCache && cacheMessagesJson && assistantText) {
            this.responseCache.set(
              activeProvider.modelInfo().name,
              activeProvider.modelInfo().id ?? "",
              cacheMessagesJson,
              assistantText,
            );
          }
          break;
        }

        // Prompt-based mode: if the model produced tool calls with no visible
        // text, emit a synthetic prefix so the user isn't watching a silent spinner.
        if (usePromptBased && pendingToolCalls.length > 0) {
          const hasNarration =
            (extractTextContent(assistantText) || "").trim().length > 0;
          if (!hasNarration) {
            const toolNames = pendingToolCalls
              .map((c) => `\`${c.name}\``)
              .join(", ");
            this.emit({ type: "text", text: `Using ${toolNames}…\n` });
          }
        }

        // Execute each tool call and append results to history. Native and
        // prompt-based modes use slightly different result formats so the
        // model parses them correctly on the next turn.
        for (const call of pendingToolCalls) {
          if (options.abortSignal?.aborted) break;

          const toolContext: ToolExecutionContext = {
            workspaceRoot: this.workspaceRoot,
            abortSignal: options.abortSignal ?? new AbortController().signal,
            reportProgress: (chunk: string) => {
              this.emit({
                type: "terminal_chunk",
                executionId: call.id,
                chunk,
                done: false,
              });
            },
            requestApproval: options.requestApproval ?? (async () => true),
            editReviewTracker: this.editReviewTracker,
            stagedEdits,
            auditLog: this._auditLog,
          };

          const result = await this.toolRegistry.execute(
            call.name,
            call.arguments,
            toolContext,
          );

          // Emit terminal done sentinel so the webview closes the streaming block.
          this.emit({
            type: "terminal_chunk",
            executionId: call.id,
            chunk: "",
            done: true,
          });

          // Re-check after tool execution — user may have cancelled during a
          // long-running tool. Don't commit the result to history if aborted.
          if (options.abortSignal?.aborted) break;

          collectedToolCalls.push({ call, result });

          // Redact secrets from the tool output before adding it to
          // history. This prevents API keys / passwords / PEM blocks in
          // file contents and command output from leaking to the LLM
          // on the next turn. The user-visible result (collected above)
          // intentionally retains the unredacted output for display.
          // 1. Redact secrets from tool output before sending to LLM.
          const secretScan = this.secretScanner.scan(result.output);
          // 2. Check tool output for indirect prompt injection (e.g. malicious
          //    instructions embedded in workspace files or command output).
          const injectionCheck = this.promptGuard.check(secretScan.redacted);
          const redactedOutput = injectionCheck.safe
            ? secretScan.redacted
            : `[Tool output blocked — possible prompt injection in ${call.name} output (${injectionCheck.category ?? "unknown"})]`;
          if (!injectionCheck.safe) {
            console.warn(
              `Champ PromptGuard: blocked indirect injection in ${call.name} output — ${injectionCheck.reason}`,
            );
          }
          const redactedResult: ToolResult = {
            ...result,
            output: redactedOutput,
          };

          // Emit tool result so the UI can update the "Running..." card.
          this.emit({
            type: "tool_call_end",
            toolCallId: call.id,
            toolName: call.name,
            toolResult: redactedOutput,
            toolSuccess: result.success,
            fileEditDiff: result.metadata?.fileEditDiff,
          });

          // Record tool call for analytics
          if (analyticsActive && this.analyticsInstance) {
            const toolStart = toolStartTimes.get(call.id) ?? Date.now();
            toolStartTimes.delete(call.id);
            this.analyticsInstance.recordToolCall(this.analyticsAgentName, {
              toolName: call.name,
              args: call.arguments,
              startTime: toolStart,
              durationMs: Date.now() - toolStart,
              success: result.success,
              result: result.success ? result.output.slice(0, 200) : undefined,
              error: result.success ? undefined : result.output,
            });
          }

          if (usePromptBased) {
            // For prompt-based providers, the next user message contains
            // the tool result wrapped in <tool_result> so the model can
            // see it as part of the conversation.
            this.history.push({
              role: "user",
              content: this.formatToolResultForPromptBased(
                call,
                redactedResult,
              ),
            });
          } else {
            const toolResultBlock: ContentBlock = {
              type: "tool_result",
              toolUseId: call.id,
              content: redactedOutput,
              isError: !result.success,
            };
            this.history.push({
              role: "tool",
              content: [toolResultBlock],
              toolCallId: call.id,
            });
          }
        }
      }

      // Flush all staged file edits to disk atomically now that the turn is done.
      // This ensures edits across multiple files are applied together — no half-
      // applied states — and later edits to the same file correctly compose.
      if (stagedEdits.size() > 0) {
        const flushed = await stagedEdits.flush();
        for (const change of flushed) {
          if (this.editReviewTracker) {
            this.editReviewTracker.record({
              path: change.relativePath,
              oldContent: change.oldContent,
              newContent: change.newContent,
            });
          }
        }
      }

      // Warn the user if the loop was cut short by the iteration cap.
      if (iterationRan && !hadError && !options.abortSignal?.aborted) {
        // If the loop ran maxIterations without breaking early (no-tool-call
        // break), the for-loop simply exhausted — notify the user.
        const reachedCap =
          collectedToolCalls.length > 0 && collectedText.join("").trim() === "";
        if (reachedCap) {
          this.emit({
            type: "text",
            text: `\n\n⚠️ Reached the ${maxIterations}-iteration limit. The task may be incomplete — try continuing with a follow-up message.`,
          });
        }
      }

      // Finalize analytics for this processMessage call
      if (analyticsActive && this.analyticsInstance) {
        try {
          this.analyticsInstance.recordTokens(
            this.analyticsAgentName,
            totalInputTokens,
            totalOutputTokens,
          );
          this.analyticsInstance.endTask(
            this.analyticsAgentName,
            iterationRan && !hadError,
            iterationRan ? undefined : "aborted before first iteration",
          );
        } catch {
          // ignore — analytics failure must not break the message path
        }
      }

      if (this.memoryBank && userText) {
        const query =
          typeof userText === "string"
            ? userText.slice(0, 120)
            : (userText as ContentBlock[])
                .filter(
                  (b): b is ContentBlock & { type: "text" } =>
                    b.type === "text",
                )
                .map((b) => b.text)
                .join(" ")
                .slice(0, 120);
        const summary =
          collectedText.join("").slice(0, 200).replace(/\n/g, " ") ||
          "(no text response)";
        void this.memoryBank.store({
          userQuery: query,
          assistantSummary: summary,
          sessionId: this.analyticsAgentName,
        });
      }

      return {
        text: collectedText.join(""),
        toolCalls: collectedToolCalls,
      };
    } finally {
      this._isProcessing = false;
      if (this._pendingProvider) {
        this.provider = this._pendingProvider;
        this._pendingProvider = null;
      }
      void this._drainQueue();
    }
  }

  /**
   * Drain the FIFO message queue, processing one entry at a time.
   * Called from the finally block of _runMessage() so queued calls
   * are processed in order after each completes.
   */
  private async _drainQueue(): Promise<void> {
    while (this._messageQueue.length > 0 && !this._isProcessing) {
      const next = this._messageQueue.shift()!;
      try {
        const result = await this._runMessage(next.userText, next.options);
        next.resolve(result);
      } catch (e) {
        next.reject(e);
      }
    }
  }

  /**
   * Format a tool result as plain text wrapped in a <tool_result> block,
   * suitable for sending back to a prompt-based-tools model.
   */
  private formatToolResultForPromptBased(
    call: ToolCall,
    result: ToolResult,
  ): string {
    const status = result.success ? "success" : "error";
    return `<tool_result tool="${call.name}" status="${status}">
${result.output}
</tool_result>`;
  }

  private emit(delta: StreamDelta): void {
    for (const listener of this.streamListeners) {
      try {
        listener(delta);
      } catch {
        // Swallow listener errors to prevent one bad consumer from
        // breaking the stream.
      }
    }
  }

  private emitIterationStart(iteration: number, totalTokens: number): void {
    for (const listener of this.iterationStartListeners) {
      try {
        listener(iteration, totalTokens);
      } catch {
        // Swallow listener errors — analytics/UI consumers must not break the loop.
      }
    }
  }
}
