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
  ContentBlock,
} from "../providers/types";
import {
  injectToolsIntoPrompt,
  parseToolCallsFromText,
  extractTextContent,
} from "../providers/prompt-based-tools";
import type { ToolRegistry } from "../tools/registry";
import type { ToolExecutionContext, ToolResult } from "../tools/types";

const DEFAULT_MAX_ITERATIONS = 25;

/**
 * Base instructions injected at the top of every prompt-based system
 * message. Tells the model it has tools and explains the response shape
 * expected. The injectToolsIntoPrompt helper appends the tool catalog
 * and the <tool_call> format spec.
 */
const PROMPT_BASED_BASE_INSTRUCTIONS = `You are AIDev, an autonomous AI coding assistant integrated into the user's code editor. You have access to tools that let you read files, edit files, search the codebase, and run commands in the user's workspace.

When the user asks you to do something that requires modifying files, running commands, or inspecting the workspace, you MUST use the tools provided. Do NOT just describe what to do — actually call the tools.

For example, if the user says "create a hello world Python file", do not just print the code. Instead, call the create_file tool with path="hello_world.py" and the content. Then briefly confirm what you did.

Always explain your reasoning briefly before calling a tool, then call the tool, then summarize the result after.`;

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

export class AgentController {
  private history: LLMMessage[] = [];
  private streamListeners = new Set<StreamDeltaListener>();
  private workspaceRoot: string;
  private provider: LLMProvider;

  constructor(
    provider: LLMProvider,
    private readonly toolRegistry: ToolRegistry,
    workspaceRoot = process.cwd(),
  ) {
    this.provider = provider;
    this.workspaceRoot = workspaceRoot;
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
   * Clear conversation history. Called when the user starts a new chat.
   */
  reset(): void {
    this.history = [];
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
    const allTools = this.toolRegistry.getDefinitions();

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (options.abortSignal?.aborted) break;

      const pendingToolCalls: ToolCall[] = [];
      let assistantText = "";

      // Build the message list to send. In prompt-based mode we prepend
      // (or merge into) a system message with the tool catalog as XML.
      const messagesToSend = usePromptBased
        ? this.withInjectedToolPrompt(this.history, allTools)
        : this.history;

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

        // Emit a synthetic tool_call_end + result for the UI.
        this.emit({ type: "tool_call_end", toolCallId: call.id });

        if (usePromptBased) {
          // For prompt-based providers, the next user message contains
          // the tool result wrapped in <tool_result> so the model can
          // see it as part of the conversation.
          this.history.push({
            role: "user",
            content: this.formatToolResultForPromptBased(call, result),
          });
        } else {
          const toolResultBlock: ContentBlock = {
            type: "tool_result",
            toolUseId: call.id,
            content: result.output,
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
   * containing tool-injection instructions. If the history already has a
   * system message at index 0, the tool prompt is appended to it; otherwise
   * a new system message is prepended.
   */
  private withInjectedToolPrompt(
    history: LLMMessage[],
    tools: Array<{
      name: string;
      description: string;
      parameters: unknown;
    }>,
  ): LLMMessage[] {
    if (tools.length === 0) {
      // Nothing to inject — still want the base instructions so the
      // model knows it's an autonomous coding assistant.
      const systemMsg: LLMMessage = {
        role: "system",
        content: PROMPT_BASED_BASE_INSTRUCTIONS,
      };
      return this.prependOrMergeSystem(history, systemMsg);
    }

    const fullPrompt = injectToolsIntoPrompt(
      PROMPT_BASED_BASE_INSTRUCTIONS,
      tools as never,
    );
    const systemMsg: LLMMessage = {
      role: "system",
      content: fullPrompt,
    };
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
