/**
 * ToolRegistry: central dispatcher for LLM tool calls.
 *
 * Tools are registered at extension activation. When the LLM invokes a
 * tool, the registry checks whether it requires approval, optionally
 * prompts the user, and then executes it.
 */
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import type { ToolDefinition } from "../providers/types";

/**
 * Validate tool arguments against the declared JSON schema before execution
 * (issue #106). Returns null when valid, or a human-readable reason that is
 * fed back to the model so it can correct its call.
 */
export function validateToolArgs(tool: Tool, args: unknown): string | null {
  const params = tool.parameters;
  if (!params || typeof params !== "object") {
    return null;
  }
  if (params.type !== "object") {
    return null; // only object schemas are used by tools today
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "expected a JSON object of named arguments";
  }
  const record = args as Record<string, unknown>;
  for (const req of params.required ?? []) {
    if (!(req in record)) {
      return `missing required argument "${req}"`;
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const expected = params.properties?.[key]?.type;
    if (!expected) {
      continue; // unknown extra properties are tolerated
    }
    if (!jsonTypeMatches(expected, value)) {
      return `argument "${key}" must be of type ${expected}`;
    }
  }
  return null;
}

function jsonTypeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    default:
      return true; // unknown schema types are not enforced
  }
}

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

    // Schema-validate BEFORE approval so the model gets fast, actionable
    // feedback instead of a runtime failure inside the tool (issue #106).
    const validationError = validateToolArgs(tool, args);
    if (validationError) {
      return {
        success: false,
        output: `Invalid arguments for tool "${name}": ${validationError}. Fix the arguments and call the tool again.`,
      };
    }

    if (tool.requiresApproval) {
      const preview = tool.getPreview?.(args);
      const approved = await context.requestApproval(
        `Tool "${name}" wants to execute with args: ${JSON.stringify(args, null, 2)}`,
        preview,
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
