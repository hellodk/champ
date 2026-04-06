/**
 * AgentController: the single-agent loop.
 *
 * Receives a user message, streams an LLM response, parses tool calls,
 * executes them via the ToolRegistry, feeds results back to the LLM, and
 * repeats until the LLM produces a text-only response or an iteration
 * limit is hit.
 *
 * This is the building block that each multi-agent role (Planner, Code,
 * Reviewer, etc.) uses internally. The orchestrator layer on top of it
 * handles inter-agent workflows.
 */
import type {
  LLMProvider,
  LLMMessage,
  StreamDelta,
  ToolCall,
  ContentBlock,
} from "../providers/types";
import type { ToolRegistry } from "../tools/registry";
import type { ToolExecutionContext, ToolResult } from "../tools/types";

const DEFAULT_MAX_ITERATIONS = 25;

export interface ProcessMessageOptions {
  abortSignal?: AbortSignal;
  maxIterations?: number;
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

  constructor(
    private readonly provider: LLMProvider,
    private readonly toolRegistry: ToolRegistry,
    workspaceRoot = process.cwd(),
  ) {
    this.workspaceRoot = workspaceRoot;
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

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (options.abortSignal?.aborted) break;

      const pendingToolCalls: ToolCall[] = [];
      let assistantText = "";

      const stream = this.provider.chat(this.history, {
        tools: this.toolRegistry.getDefinitions(),
        abortSignal: options.abortSignal,
      });

      for await (const delta of stream) {
        this.emit(delta);

        if (delta.type === "text" && delta.text) {
          assistantText += delta.text;
          collectedText.push(delta.text);
        } else if (delta.type === "tool_call_start" && delta.toolCall) {
          pendingToolCalls.push(delta.toolCall);
        } else if (delta.type === "done") {
          break;
        } else if (delta.type === "error") {
          // Record the error but don't crash the loop; stop iterating.
          return {
            text: collectedText.join(""),
            toolCalls: collectedToolCalls,
          };
        }
      }

      // Persist the assistant turn to history.
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

      // Execute each tool call and append results as tool messages.
      for (const call of pendingToolCalls) {
        if (options.abortSignal?.aborted) break;

        const toolContext: ToolExecutionContext = {
          workspaceRoot: this.workspaceRoot,
          abortSignal: options.abortSignal ?? new AbortController().signal,
          reportProgress: () => {
            // Progress is streamed via listeners if needed.
          },
          // Approval is granted by default here; the UI layer overrides this
          // when the controller is used inside a real chat view.
          requestApproval: async () => true,
        };

        const result = await this.toolRegistry.execute(
          call.name,
          call.arguments,
          toolContext,
        );
        collectedToolCalls.push({ call, result });

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

    return {
      text: collectedText.join(""),
      toolCalls: collectedToolCalls,
    };
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
