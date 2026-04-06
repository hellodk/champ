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
import type { ToolRegistry } from "../tools/registry";
import type { ToolExecutionContext, ToolResult } from "../tools/types";

const DEFAULT_MAX_ITERATIONS = 25;

/**
 * Base instructions injected at the top of every prompt-based system
 * message. Tells the model it has tools, explains the response shape
 * expected, and includes anti-hallucination directives based on
 * docs/HALLUCINATION_MITIGATION.md.
 */
const PROMPT_BASED_BASE_INSTRUCTIONS = `You are AIDev, an autonomous AI coding assistant integrated into the user's code editor. You have access to tools that let you read files, edit files, search the codebase, and run commands in the user's workspace.

# Core directive

When the user asks you to do something that requires modifying files, running commands, or inspecting the workspace, you MUST use the tools provided. Do NOT just describe what to do — perform it.

# Anti-hallucination rules (mandatory)

1. **Verify before claim.** Before referencing a function, file, class, variable, or line number, you MUST first verify it exists with read_file or grep_search. If you have not verified, do not claim it exists.
2. **Never invent.** Do not invent function names, library APIs, file paths, or line numbers. If you do not know the answer, say so explicitly. "I don't know — let me check" is a valid response. Inventing is not.
3. **Read before edit.** Before calling edit_file on any file, you MUST have read that file in this session. If you have not, call read_file first.
4. **Tool calls over descriptions.** If the user asks for an action, your response is incomplete until you have actually called the tool. A markdown explanation is not a substitute for a tool call.
5. **Honest failure.** If a tool fails or returns nothing, report that honestly. Do not pretend the action succeeded.

# Examples

User: "create a hello world python file"

Wrong response (no tool call):
> Sure! Here's a Python script:
> \`\`\`python
> print("Hello, World!")
> \`\`\`
> Save this as hello_world.py.

Correct response:
> I'll create the file now.
> [calls create_file with path="hello_world.py" content="print(\\"Hello, World!\\")\\n"]
> Created hello_world.py with a hello world print statement.

---

User: "what does the validateToken function do?"

Wrong response (hallucinated):
> The validateToken function checks the JWT signature and returns the decoded user payload.

Correct response:
> Let me check.
> [calls grep_search query="validateToken"]
> [calls read_file with the matching file]
> Looking at src/auth/auth-service.ts line 42, validateToken accepts a token string, calls jwt.verify with the secret from process.env.JWT_SECRET, and returns the decoded user object or null on failure.

---

User: "fix the off-by-one in the loop in main.ts"

Wrong response (hallucinated edit):
> [calls edit_file with old_content="for (let i = 0; i <= arr.length; i++)" new_content="for (let i = 0; i < arr.length; i++)"]

(This may fail because main.ts may not contain that exact line.)

Correct response:
> Let me read main.ts first to find the actual loop.
> [calls read_file path="main.ts"]
> Found the loop at line 17. Fixing the bound.
> [calls edit_file with the actual content from the file]

# Format

Always explain your reasoning briefly before calling a tool, call the tool, then summarize the result after. Be concise.`;

export interface ProcessMessageOptions {
  abortSignal?: AbortSignal;
  maxIterations?: number;
  /** Approval callback invoked before destructive tool calls. */
  requestApproval?: (description: string) => Promise<boolean>;
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
  agent: `\n\n# Mode: Agent\nYou are in autonomous mode. Use your tools to complete the user's request end-to-end. Iterate until the task is done or you hit an error you cannot recover from.`,
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
    userText: string,
    options: ProcessMessageOptions = {},
  ): Promise<ProcessMessageResult> {
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    this.history.push({ role: "user", content: userText });

    const collectedText: string[] = [];
    const collectedToolCalls: Array<{ call: ToolCall; result: ToolResult }> =
      [];

    const usePromptBased = !this.provider.supportsToolUse();
    // Filter tools by the active mode (Ask/Plan = read-only).
    const allTools = this.filterToolsByMode(this.toolRegistry.getDefinitions());
    // Fetch the repo map once per session for grounding. Cached after
    // first call. Empty string if no provider attached.
    const repoMap = await this.getRepoMap();

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (options.abortSignal?.aborted) break;

      const pendingToolCalls: ToolCall[] = [];
      let assistantText = "";

      // Build the message list to send. In prompt-based mode we prepend
      // (or merge into) a system message with the tool catalog as XML.
      // For native-tool-calling providers we still inject the repo map
      // and base directives as a system message — they need grounding too.
      const messagesToSend = usePromptBased
        ? this.withInjectedToolPrompt(this.history, allTools, repoMap)
        : this.withGroundingSystemPrompt(this.history, repoMap);

      const stream = this.provider.chat(messagesToSend, {
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
          this.emit(delta);
        } else if (delta.type === "tool_call_end") {
          this.emit(delta);
        } else if (delta.type === "done") {
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
        for (const call of parsed) {
          pendingToolCalls.push(call);
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

      // Persist the assistant turn to history. We store the original
      // unfiltered text in prompt-based mode so the model sees its own
      // <tool_call> blocks on the next turn — that helps it stay
      // consistent with its own format.
      const assistantMessage: LLMMessage = {
        role: "assistant",
        content: assistantText,
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      };
      this.history.push(assistantMessage);

      // If the model produced no tool calls, we're done.
      if (pendingToolCalls.length === 0) {
        break;
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
        collectedToolCalls.push({ call, result });

        // Redact secrets from the tool output before adding it to
        // history. This prevents API keys / passwords / PEM blocks in
        // file contents and command output from leaking to the LLM
        // on the next turn. The user-visible result (collected above)
        // intentionally retains the unredacted output for display.
        const redactedOutput = this.secretScanner.scan(result.output).redacted;
        const redactedResult: ToolResult = {
          ...result,
          output: redactedOutput,
        };

        // Emit a synthetic tool_call_end + result for the UI.
        this.emit({ type: "tool_call_end", toolCallId: call.id });

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
