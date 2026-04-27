import type { MCPClientManager, MCPTool } from "./mcp-client";
import type { Tool, ToolExecutionContext, ToolResult } from "../tools/types";
import type { ToolParameterSchema } from "../providers/types";

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
  const name = `mcp_${serverName}_${mcpTool.name}`;
  const description = `${mcpTool.description} [MCP: ${serverName}]`;

  const parameters: ToolParameterSchema =
    mcpTool.inputSchema &&
    typeof mcpTool.inputSchema === "object" &&
    mcpTool.inputSchema.type === "object"
      ? (mcpTool.inputSchema as unknown as ToolParameterSchema)
      : { type: "object", properties: {}, required: [] };

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
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n");

      return {
        success: !result.isError,
        output: output || (result.isError ? "MCP tool returned an error" : ""),
      };
    },
  };
}
