import { describe, expect, it } from "vitest";
import {
  applyMcpHealth,
  markMcpRestarting,
  mcpSummary,
  sortMcpServers,
  type McpServerStatus,
} from "@/tui/mcp";

const servers: McpServerStatus[] = [
  {
    name: "filesystem",
    transport: "stdio",
    status: "running",
    health: "healthy",
    tools: 6,
  },
  {
    name: "broken",
    transport: "http",
    status: "stopped",
    health: "down",
    tools: 0,
    error: "connection refused",
  },
];

describe("MCP status", () => {
  it("sorts healthy servers first", () => {
    expect(sortMcpServers(servers).map((server) => server.name)).toEqual([
      "filesystem",
      "broken",
    ]);
  });

  it("marks a server restarting without losing its identity", () => {
    const restarting = markMcpRestarting(servers, "broken");
    expect(restarting.find((server) => server.name === "broken")?.status).toBe(
      "restarting",
    );
  });

  it("applies health updates and errors", () => {
    const updated = applyMcpHealth(servers, "broken", "degraded", "slow");
    expect(updated.find((server) => server.name === "broken")).toMatchObject({
      health: "degraded",
      error: "slow",
      status: "running",
    });
  });

  it("renders a one-line summary", () => {
    expect(mcpSummary(servers[1])).toContain("connection refused");
    expect(mcpSummary(servers[0])).toContain("6 tool(s)");
  });
});
