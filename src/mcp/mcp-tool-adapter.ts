import type { MCPClientManager, MCPTool } from "./mcp-client";
import type { Tool, ToolExecutionContext, ToolResult } from "../tools/types";
import type { ToolParameterSchema } from "../providers/types";

function toToolParameterSchema(raw: unknown): ToolParameterSchema {
  if (
    raw !== null &&
    typeof raw === "object" &&
    (raw as Record<string, unknown>).type === "object"
  ) {
    const r = raw as Record<string, unknown>;
    return {
      type: "object",
      properties: (r.properties as ToolParameterSchema["properties"]) ?? {},
      required: Array.isArray(r.required) ? (r.required as string[]) : [],
    };
  }
  return { type: "object", properties: {}, required: [] };
}

/**
 * Wrap a single MCPTool as a Tool that the ToolRegistry can dispatch.
 * Naming: `mcp_{serverName}_{toolName}` — prefix prevents collisions with
 * built-in tools and makes MCP origin visible to the LLM.
 */
export function createMcpToolAdapter(
  serverName: string,
  mcpTool: MCPTool,
  manager: MCPClientManager,
): Tool {
  const sanitise = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
  const name = `mcp_${sanitise(serverName)}_${sanitise(mcpTool.name)}`;
  const description = `${mcpTool.description ?? mcpTool.name} [MCP: ${serverName}]`;

  const parameters: ToolParameterSchema = toToolParameterSchema(
    mcpTool.inputSchema,
  );

  return {
    name,
    description,
    parameters,
    requiresApproval: true,

    async execute(
      args: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolResult> {
      const result = await manager.invokeTool(serverName, mcpTool.name, args);

      const output = result.content
        .filter(
          (b): b is typeof b & { type: "text"; text: string } =>
            b.type === "text" &&
            typeof b.text === "string" &&
            b.text.length > 0,
        )
        .map((b) => b.text)
        .join("\n");

      return {
        success: !result.isError,
        output: output || (result.isError ? "MCP tool returned an error" : ""),
      };
    },
  };
}
