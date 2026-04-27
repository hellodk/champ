import type * as vscode from "vscode";
import { MCPClientManager, type MCPServerConfig } from "./mcp-client";
import { createMcpToolAdapter } from "./mcp-tool-adapter";
import { resolveEnvSecrets } from "./secret-resolver";
import type { ToolRegistry } from "../tools/registry";

/**
 * Manages the lifecycle of MCP server connections and their tool registrations.
 *
 * On each loadServers() call it diffs the desired server list against the
 * currently connected set — connecting new servers, disconnecting removed ones,
 * and leaving unchanged ones alone. This makes config reloads cheap.
 */
export class McpRegistry {
  /** serverName → tool names registered from that server */
  private registeredTools = new Map<string, string[]>();
  private loading = false;

  constructor(
    private readonly manager: MCPClientManager,
    private readonly toolRegistry: ToolRegistry,
    private readonly secretStorage: Pick<vscode.SecretStorage, "get">,
  ) {}

  /**
   * Reconcile the desired server list with the current connections.
   * Idempotent — safe to call on every config reload.
   */
  async loadServers(servers: MCPServerConfig[]): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const desired = new Map(servers.map((s) => [s.name, s]));
      const connected = new Set(this.manager.getConnectedServers());

      for (const name of connected) {
        if (!desired.has(name)) {
          await this.disconnectServer(name);
        }
      }

      for (const [name, config] of desired) {
        if (connected.has(name)) continue;

        try {
          const resolvedEnv = config.env
            ? await resolveEnvSecrets(config.env, this.secretStorage)
            : undefined;

          await this.manager.connect({ ...config, env: resolvedEnv });
          await this.registerServerTools(name);

          console.log(`Champ MCP: connected "${name}"`);
        } catch (err) {
          console.error(
            `Champ MCP: failed to connect "${name}":`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } finally {
      this.loading = false;
    }
  }

  async disposeAll(): Promise<void> {
    const names = [...this.registeredTools.keys()];
    for (const name of names) {
      await this.disconnectServer(name);
    }
  }

  private async registerServerTools(serverName: string): Promise<void> {
    const tools = await this.manager.listTools(serverName);
    const names: string[] = [];

    for (const mcpTool of tools) {
      const adapter = createMcpToolAdapter(serverName, mcpTool, this.manager);
      this.toolRegistry.register(adapter);
      names.push(adapter.name);
    }

    this.registeredTools.set(serverName, names);
    console.log(
      `Champ MCP: registered ${names.length} tool(s) from "${serverName}": ${names.join(", ")}`,
    );
  }

  private unregisterServerTools(serverName: string): void {
    const names = this.registeredTools.get(serverName) ?? [];
    for (const name of names) {
      this.toolRegistry.unregister(name);
    }
    this.registeredTools.delete(serverName);
  }

  private async disconnectServer(serverName: string): Promise<void> {
    this.unregisterServerTools(serverName);
    await this.manager.disconnect(serverName);
    console.log(`Champ MCP: disconnected "${serverName}"`);
  }
}
