/**
 * ToolRegistry: central dispatcher for LLM tool calls.
 *
 * Tools are registered at extension activation. When the LLM invokes a
 * tool, the registry checks whether it requires approval, optionally
 * prompts the user, and then executes it.
 */
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import type { ToolDefinition } from "../providers/types";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Returns tool definitions in the format expected by LLMProvider.chat().
   */
  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Execute a tool by name. Handles approval flow and error reporting.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: `Unknown tool: ${name}`,
      };
    }

    if (tool.requiresApproval) {
      const approved = await context.requestApproval(
        `Tool "${name}" wants to execute with args: ${JSON.stringify(args, null, 2)}`,
      );
      if (!approved) {
        return {
          success: false,
          output: `User denied execution of tool "${name}".`,
        };
      }
    }

    try {
      return await tool.execute(args, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Tool "${name}" threw an error: ${message}`,
      };
    }
  }
}
