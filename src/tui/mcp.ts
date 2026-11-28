/** Read-only MCP server status surfaced by the MCP screen. */
export type McpHealth = "healthy" | "degraded" | "down" | "unknown";

export interface McpServerStatus {
  name: string;
  transport: string;
  status: "running" | "stopped" | "restarting";
  health: McpHealth;
  tools: number;
  error?: string;
  lastChecked?: string;
}

const HEALTH_ORDER: Record<McpHealth, number> = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  down: 3,
};

export function sortMcpServers(
  servers: readonly McpServerStatus[],
): McpServerStatus[] {
  return [...servers].sort(
    (left, right) =>
      HEALTH_ORDER[left.health] - HEALTH_ORDER[right.health] ||
      left.name.localeCompare(right.name),
  );
}

export function markMcpRestarting(
  servers: readonly McpServerStatus[],
  name: string,
): McpServerStatus[] {
  return servers.map((server) =>
    server.name === name ? { ...server, status: "restarting" } : server,
  );
}

export function applyMcpHealth(
  servers: readonly McpServerStatus[],
  name: string,
  health: McpHealth,
  error?: string,
): McpServerStatus[] {
  return servers.map((server) => {
    if (server.name !== name) return server;
    const status =
      health === "down" && server.status !== "restarting"
        ? "stopped"
        : health === "down"
          ? server.status
          : "running";
    return {
      ...server,
      health,
      status,
      error,
      lastChecked: new Date().toISOString(),
    };
  });
}

export function mcpSummary(server: McpServerStatus): string {
  return [
    `${server.name} [${server.status}]`,
    server.health,
    `${server.tools} tool(s)`,
    server.transport,
    server.error ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}
