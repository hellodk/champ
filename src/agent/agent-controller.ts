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
  injectToolsIntoPrompt,
  parseToolCallsFromText,
  extractTextContent,
} from "../providers/prompt-based-tools";
import { SecretScanner } from "../safety/secret-scanner";
import { PiiScanner } from "../safety/pii-scanner";
import { PromptGuard, PromptInjectionError } from "../safety/prompt-guard";
import type { SmartRouter, TaskType } from "../providers/smart-router";
import type { ToolRegistry } from "../tools/registry";
import type { ToolExecutionContext, ToolResult } from "../tools/types";
import { ContextWindowManager } from "../providers/context-manager";

export { PromptInjectionError };

const DEFAULT_MAX_ITERATIONS = 25;

/**
 * Base instructions injected at the top of every prompt-based system
 * message. Tells the model it has tools, explains the response shape
 * expected, and includes anti-hallucination directives based on
 * docs/HALLUCINATION_MITIGATION.md.
 */
const PROMPT_BASED_BASE_INSTRUCTIONS = `You are Champ, an autonomous AI coding assistant running inside the user's code editor. You have REAL tools wired to the user's actual workspace on disk. Every tool call executes immediately and returns real output.

# YOU ARE AN AGENT — NOT A CHATBOT

You have tools. Use them. Do not describe, explain, or ask — act.

BANNED phrases (never say these):
- "I don't have access to..."
- "I can't run commands..."
- "I don't have a file system..."
- "Would you like me to..."
- "I could try running..."
- "As an AI, I..."
- "I'm unable to..."

If you catch yourself about to write any of the above, STOP. Call a tool instead.

# Tools available

You have: read_file, edit_file, create_file, delete_file, list_directory, run_terminal_cmd, grep_search, file_search.

These tools work. They execute in the user's real workspace. Use them without hesitation.

# Core rules

1. **Act, don't describe.** User asks for action → call the tool. A description is not a result.
2. **Verify before claim.** Before stating a file/function/variable exists, read or grep for it first.
3. **Read before edit.** Always read_file before edit_file so you use the actual current content.
4. **Honest failure.** If a tool returns nothing or errors, say so. Never fabricate a result.
5. **No permission-asking.** The user has already given you permission by asking. Just do it.

# Examples

User: "what is the current directory" or "pwd"

WRONG:
> I don't have a local file system. As an AI running on a server, I can't tell you the current directory unless I run a script. Would you like me to try?

CORRECT:
> [calls run_terminal_cmd with command="pwd"]
> /home/dk/Documents/git/k8s-cluster-health

---

User: "create a hello world python file"

WRONG:
> Sure! Here's a Python script you can save as hello_world.py:
> \`\`\`python
> print("Hello, World!")
> \`\`\`

CORRECT:
> [calls create_file path="hello_world.py" content="print(\\"Hello, World!\\")\\n"]
> Created hello_world.py.

---

User: "what does validateToken do?"

WRONG:
> The validateToken function validates a JWT token and returns the user payload.

CORRECT:
> [calls grep_search query="validateToken"]
> [calls read_file on the result]
> validateToken is at src/auth/auth-service.ts:42 — it calls jwt.verify and returns the decoded user or null on failure.

---

User: "fix the off-by-one in main.ts"

WRONG:
> [calls edit_file with invented content not from the actual file]

CORRECT:
> [calls read_file path="main.ts"]
> Found loop at line 17 — i <= arr.length should be i < arr.length.
> [calls edit_file with the actual line from the file]

# Format — mandatory narration pattern

You MUST narrate every step. Users are watching your work in real time.

**Before every tool call** write one sentence explaining what you are about to do and why:
> "Reading auth.ts to understand the token validation flow..."
> "Searching for all places that call validateUser to check the callers..."
> "Running the tests to confirm the fix works..."

**After a tool result** write one sentence summarising what you found:
> "Found the issue — the token is validated before the middleware runs."
> "Three files call validateUser: auth.ts, middleware.ts, and user.service.ts."
> "All 12 tests pass."

Never silently call a tool. Never go silent for more than one tool call in a row.
If a task has many steps, briefly state your overall plan first, then narrate each step.`;

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

/**
 * Append-only mode-specific instruction blocks. Mirrors what
 * SystemPromptBuilder produces — duplicated here so AgentController
 * doesn't have to take SystemPromptBuilder as a dependency.
 */
const MODE_INSTRUCTIONS: Record<AgentMode, string> = {
  agent: `\n\n# Mode: Agent\nYou are in autonomous mode. Use your tools to complete the user's request end-to-end. Iterate until the task is done or you hit an error you cannot recover from.\n\nRemember: narrate before each tool call ("Reading X to understand Y...") and after each result ("Found Z."). Never call a tool silently.`,
  ask: `\n\n# Mode: Ask (Read-Only)\nYou are in read-only mode. You may use read_file, list_directory, grep_search, file_search, codebase_search to answer questions. Do NOT use edit_file, create_file, delete_file, or run_terminal_cmd. If the user asks you to modify something, tell them they need to switch to Agent mode.`,
  manual: `\n\n# Mode: Manual\nBefore each tool call, briefly explain what you plan to do. Each destructive call requires explicit user approval — proceed only if granted.`,
  plan: `\n\n# Mode: Plan\nProduce a detailed plan as a numbered list. Do NOT make any edits or run commands. You may use read-only tools (read_file, grep_search, file_search) to gather information for the plan.`,
  composer: `\n\n# Mode: Composer\nYou are producing a multi-file diff for the user to review. Plan first, then generate concrete diffs across all affected files. Bundled changes are reviewed and applied as a unit.`,
};

export class AgentController {
  private history: LLMMessage[] = [];
  private streamListeners = new Set<StreamDeltaListener>();
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

  constructor(
    provider: LLMProvider,
    private readonly toolRegistry: ToolRegistry,
    workspaceRoot = process.cwd(),
  ) {
    this.provider = provider;
    this.workspaceRoot = workspaceRoot;
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
   */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
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
   */
  async processMessage(
    userText: string | ContentBlock[],
    options: ProcessMessageOptions = {},
  ): Promise<ProcessMessageResult> {
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
        const types = [...new Set(piiResult.findings.map((f) => f.type))].join(
          ", ",
        );
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

    const collectedText: string[] = [];
    const collectedToolCalls: Array<{ call: ToolCall; result: ToolResult }> =
      [];

    const usePromptBased = !activeProvider.supportsToolUse();
    // Filter tools by the active mode (Ask/Plan = read-only).
    const allTools = this.filterToolsByMode(this.toolRegistry.getDefinitions());
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

    let iterationRan = false;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (options.abortSignal?.aborted) break;
      iterationRan = true;

      const pendingToolCalls: ToolCall[] = [];
      let assistantText = "";

      // Build the message list to send. In prompt-based mode we prepend
      // (or merge into) a system message with the tool catalog as XML.
      // For native-tool-calling providers we still inject the repo map
      // and base directives as a system message — they need grounding too.
      const rawMessages = usePromptBased
        ? this.withInjectedToolPrompt(this.history, allTools, repoMap)
        : this.withGroundingSystemPrompt(this.history, repoMap);

      // Fit into context window — drops oldest non-system turns if needed.
      const messagesToSend = contextManager.fitMessages(rawMessages);
      if (messagesToSend.length < rawMessages.length) {
        const dropped = rawMessages.length - messagesToSend.length;
        console.log(
          `Champ: context window — dropped ${dropped} oldest message(s) to fit`,
        );
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
        const cleaned = extractTextContent(assistantText);
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
        .replace(/<｜tool▁outputs▁begin｜>[\s\S]*?<｜tool▁outputs▁end｜>/g, "")
        .trim();
      const assistantMessage: LLMMessage = {
        role: "assistant",
        content: historyText || assistantText,
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      };
      this.history.push(assistantMessage);

      // If the model produced no tool calls, we're done.
      if (pendingToolCalls.length === 0) {
        break;
      }

      // If the model called tools without any preceding narration, emit a
      // synthetic prefix so the user is never watching a silent spinner.
      if (usePromptBased && pendingToolCalls.length > 0) {
        const hasNarration =
          (extractTextContent(assistantText) || "").trim().length > 0;
        if (!hasNarration && pendingToolCalls.length > 0) {
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
          reportProgress: () => {
            // Progress is streamed via listeners if needed.
          },
          requestApproval: options.requestApproval ?? (async () => true),
        };

        const result = await this.toolRegistry.execute(
          call.name,
          call.arguments,
          toolContext,
        );

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
            content: this.formatToolResultForPromptBased(call, redactedResult),
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

    return {
      text: collectedText.join(""),
      toolCalls: collectedToolCalls,
    };
  }

  /**
   * Build a copy of the conversation history with a system message
   * containing tool-injection instructions, the repo map (if any),
   * and the active mode's instruction block.
   */
  private withInjectedToolPrompt(
    history: LLMMessage[],
    tools: ToolDefinition[],
    repoMap: string,
  ): LLMMessage[] {
    const base = PROMPT_BASED_BASE_INSTRUCTIONS + MODE_INSTRUCTIONS[this.mode];
    const withMap = repoMap ? `${base}\n\n${repoMap}` : base;

    const fullPrompt =
      tools.length === 0 ? withMap : injectToolsIntoPrompt(withMap, tools);

    const systemMsg: LLMMessage = {
      role: "system",
      content: fullPrompt,
    };
    return this.prependOrMergeSystem(history, systemMsg);
  }

  /**
   * For native-tool-calling providers (Claude/OpenAI/Gemini), the tool
   * definitions go in the chat options, not the system prompt — but we
   * still want to inject the base directives + repo map for grounding.
   */
  private withGroundingSystemPrompt(
    history: LLMMessage[],
    repoMap: string,
  ): LLMMessage[] {
    const base = PROMPT_BASED_BASE_INSTRUCTIONS + MODE_INSTRUCTIONS[this.mode];
    const content = repoMap ? `${base}\n\n${repoMap}` : base;
    const systemMsg: LLMMessage = { role: "system", content };
    return this.prependOrMergeSystem(history, systemMsg);
  }

  private prependOrMergeSystem(
    history: LLMMessage[],
    systemMsg: LLMMessage,
  ): LLMMessage[] {
    if (history.length > 0 && history[0].role === "system") {
      const existing = history[0];
      const existingText =
        typeof existing.content === "string" ? existing.content : "";
      const merged: LLMMessage = {
        role: "system",
        content: `${systemMsg.content as string}\n\n${existingText}`,
      };
      return [merged, ...history.slice(1)];
    }
    return [systemMsg, ...history];
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
}
