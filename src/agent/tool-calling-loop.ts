/**
 * ToolCallingLoop: lightweight tool-calling state machine for TeamAgent.
 *
 * Handles both native tool-call deltas (llama3.1 via Ollama) and
 * prompt-based tool invocations (qwen3, gemma). Does NOT import
 * AgentController to avoid circular dependencies.
 *
 * Loop:
 *   1. Call provider.chat(messages, { tools })
 *   2. Collect text chunks + tool calls from stream
 *   3. Execute each tool call via scoped ToolRegistry
 *   4. Append assistant message + tool results to history
 *   5. Repeat until no tool calls or maxIterations reached
 */
import type { LLMProvider, LLMMessage, ContentBlock } from "../providers/types";
import type { ToolRegistry } from "../tools/registry";
import type { ToolExecutionContext } from "../tools/types";
import type { MetricsCollector } from "../observability/metrics-collector";

export interface ToolLoopResult {
  /** Final accumulated text from the last LLM turn with no tool calls. */
  text: string;
  /** Total token usage across all iterations. */
  usage: { inputTokens: number; outputTokens: number };
  /** Whether any tool calls were executed. */
  usedTools: boolean;
  /** Error message if execution failed. */
  error?: string;
}

const MAX_ITERATIONS = 4;

export class ToolCallingLoop {
  constructor(
    private readonly provider: LLMProvider,
    private readonly toolRegistry: ToolRegistry,
    private readonly context: ToolExecutionContext,
    private readonly metrics?: MetricsCollector,
  ) {}

  async run(
    messages: LLMMessage[],
    onChunk?: (text: string) => void,
  ): Promise<ToolLoopResult> {
    const history: LLMMessage[] = [...messages];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let usedTools = false;
    let finalText = "";

    // Build tool definitions from the scoped registry
    const toolDefs = this.toolRegistry.getDefinitions();

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (this.context.abortSignal?.aborted) {
        return {
          text: finalText,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          },
          usedTools,
          error: "Aborted",
        };
      }

      let iterText = "";
      let iterError: string | undefined;
      let iterInputTokens = 0;
      let iterOutputTokens = 0;

      // Collect tool calls from stream
      const pendingToolCalls: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
      }> = [];

      // Accumulation state for streaming tool call arguments
      let currentToolCallId: string | undefined;
      let currentToolName: string | undefined;
      let currentToolArgs = "";

      try {
        const stream = this.provider.chat(history, {
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          abortSignal: this.context.abortSignal,
        });

        for await (const delta of stream) {
          if (delta.type === "text" && delta.text) {
            iterText += delta.text;
            onChunk?.(delta.text);
          } else if (delta.type === "tool_call_start" && delta.toolCall) {
            currentToolCallId = delta.toolCall.id ?? `call_${Date.now()}`;
            currentToolName = delta.toolCall.name;
            // Arguments may be fully populated in the start delta (Ollama native)
            // or accumulated via tool_call_delta (Claude / OpenAI)
            const startArgs = delta.toolCall.arguments;
            if (startArgs && Object.keys(startArgs).length > 0) {
              pendingToolCalls.push({
                id: currentToolCallId,
                name: currentToolName,
                args: startArgs,
              });
              currentToolCallId = undefined;
              currentToolName = undefined;
              currentToolArgs = "";
            }
          } else if (delta.type === "tool_call_delta") {
            currentToolArgs += delta.argumentsDelta ?? "";
          } else if (delta.type === "tool_call_end") {
            // Flush accumulated args if we have a pending tool call
            if (currentToolCallId && currentToolName) {
              try {
                pendingToolCalls.push({
                  id: currentToolCallId,
                  name: currentToolName,
                  args: currentToolArgs ? JSON.parse(currentToolArgs) : {},
                });
              } catch {
                // Malformed args — skip this tool call
              }
              currentToolCallId = undefined;
              currentToolName = undefined;
              currentToolArgs = "";
            }
          } else if (delta.type === "error") {
            iterError = delta.error;
          } else if (delta.type === "done") {
            if (delta.usage) {
              iterInputTokens = delta.usage.inputTokens ?? 0;
              iterOutputTokens = delta.usage.outputTokens ?? 0;
            }
            break;
          }
        }
      } catch (err) {
        return {
          text: finalText || iterText,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          },
          usedTools,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      totalInputTokens += iterInputTokens;
      totalOutputTokens += iterOutputTokens;

      if (iterError) {
        return {
          text: iterText,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          },
          usedTools,
          error: iterError,
        };
      }

      // No tool calls — we're done
      if (pendingToolCalls.length === 0) {
        finalText = iterText;
        break;
      }

      // Execute tool calls
      usedTools = true;

      // Build assistant message with tool use blocks
      const assistantContent: ContentBlock[] = [];
      if (iterText) {
        assistantContent.push({ type: "text", text: iterText });
      }
      for (const tc of pendingToolCalls) {
        assistantContent.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.args,
        });
      }
      history.push({ role: "assistant", content: assistantContent });

      // Execute each tool and collect results
      const toolResultBlocks: ContentBlock[] = [];
      for (const tc of pendingToolCalls) {
        if (this.context.abortSignal?.aborted) break;

        const toolStartTime = Date.now();
        let toolResultStr: string | undefined;
        let toolSuccess = false;
        let toolError: string | undefined;
        let result: Awaited<ReturnType<ToolRegistry["execute"]>>;
        try {
          result = await this.toolRegistry.execute(
            tc.name,
            tc.args,
            this.context,
          );
          toolResultStr =
            typeof result.output === "string"
              ? result.output.slice(0, 500)
              : JSON.stringify(result.output).slice(0, 500);
          toolSuccess = result.success;
        } catch (err) {
          toolError = err instanceof Error ? err.message : String(err);
          this.metrics?.recordToolCall({
            toolName: tc.name,
            startTime: toolStartTime,
            durationMs: Date.now() - toolStartTime,
            success: false,
            args: tc.args,
            error: toolError,
          });
          throw err;
        }
        this.metrics?.recordToolCall({
          toolName: tc.name,
          startTime: toolStartTime,
          durationMs: Date.now() - toolStartTime,
          success: toolSuccess,
          args: tc.args,
          result: toolResultStr,
          error: toolError,
        });

        toolResultBlocks.push({
          type: "tool_result",
          toolUseId: tc.id,
          content: result.output,
          isError: !result.success,
        });
      }

      // Append tool results as user message
      history.push({ role: "user", content: toolResultBlocks });

      // Last iteration — stop regardless of remaining tool calls
      if (iteration === MAX_ITERATIONS - 1) {
        finalText = iterText || "(reached max tool-calling iterations)";
      }
    }

    return {
      text: finalText,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      usedTools,
    };
  }
}
