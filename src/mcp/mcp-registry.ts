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
  private pendingServers: MCPServerConfig[] | null = null;

  constructor(
    private readonly manager: MCPClientManager,
    private readonly toolRegistry: ToolRegistry,
    private readonly secretStorage: Pick<vscode.SecretStorage, "get">,
  ) {
    // When a server process exits unexpectedly, unregister its tools
    // so the LLM cannot call dead tool entries.
    this.manager.onServerExit = (serverName) => {
      if (this.registeredTools.has(serverName)) {
        console.warn(
          `Champ MCP: server "${serverName}" exited — unregistering its tools`,
        );
        this.unregisterServerTools(serverName);
      }
    };
  }

  /**
   * Reconcile the desired server list with the current connections.
   * Idempotent — safe to call on every config reload.
   */
  async loadServers(servers: MCPServerConfig[]): Promise<void> {
    if (this.loading) {
      // Queue the latest config so it's applied when the current call finishes.
      this.pendingServers = servers;
      return;
    }
    this.loading = true;
    try {
      await this.doLoadServers(servers);
    } finally {
      this.loading = false;
      // If a newer config arrived while we were loading, apply it now.
      if (this.pendingServers !== null) {
        const next = this.pendingServers;
        this.pendingServers = null;
        void this.loadServers(next);
      }
    }
  }

  private async doLoadServers(servers: MCPServerConfig[]): Promise<void> {
    const desired = new Map(servers.map((s) => [s.name, s]));
    const connected = new Set(this.manager.getConnectedServers());

    // Disconnect servers no longer in config.
    for (const name of connected) {
      if (!desired.has(name)) {
        await this.disconnectServer(name);
      }
    }

    // Connect new servers (skip already connected).
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
    // Seed the entry immediately so any partial registrations are
    // tracked and can be cleaned up if a later registration throws.
    this.registeredTools.set(serverName, names);

    for (const mcpTool of tools) {
      const adapter = createMcpToolAdapter(serverName, mcpTool, this.manager);
      this.toolRegistry.register(adapter);
      names.push(adapter.name);
      // Update the tracked list after each successful registration.
      this.registeredTools.set(serverName, [...names]);
    }

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
    try {
      await this.manager.disconnect(serverName);
    } finally {
      // Always unregister tools — even if disconnect threw, the connection
      // is likely broken and we should not leave orphaned tool entries.
      this.unregisterServerTools(serverName);
    }
    console.log(`Champ MCP: disconnected "${serverName}"`);
  }
}
