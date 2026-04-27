/**
 * MCPClientManager: connects to external MCP (Model Context Protocol) servers.
 *
 * MCP is Anthropic's open protocol for letting LLMs call tools and
 * access resources on external services (GitHub, Slack, databases,
 * internal APIs). Each MCP server is a separate process that speaks
 * JSON-RPC 2.0 over stdio.
 *
 * This implementation uses raw child_process.spawn + JSON-RPC so it
 * doesn't depend on @modelcontextprotocol/sdk. The protocol flow is:
 *   1. spawn(command, args, { stdio: ['pipe','pipe','pipe'] })
 *   2. send `initialize` JSON-RPC → receive capabilities
 *   3. send `tools/list` → receive tool catalog
 *   4. send `tools/call` with tool name + args → receive result
 *
 * Each message is a JSON-RPC 2.0 object terminated by a newline.
 */
import { spawn, type ChildProcess } from "child_process";

export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  baseUrl?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

export interface MCPToolResult {
  content: MCPContentBlock[];
  isError?: boolean;
}

interface MCPConnection {
  config: MCPServerConfig;
  tools: MCPTool[];
  process: ChildProcess | null;
  nextId: number;
  pendingRequests: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  buffer: string;
}

export class MCPClientManager {
  private connections = new Map<string, MCPConnection>();

  /** Called when a server process exits unexpectedly. Wired by McpRegistry. */
  onServerExit?: (serverName: string, code: number | null) => void;

  /**
   * Connect to an MCP server via stdio. Spawns the server process,
   * performs the JSON-RPC initialize handshake, and fetches the tool list.
   */
  async connect(config: MCPServerConfig): Promise<void> {
    if (!config.command) {
      throw new Error(`MCP server "${config.name}" has no command configured`);
    }

    // If already connected, cleanly disconnect before reconnecting.
    if (this.connections.has(config.name)) {
      await this.disconnect(config.name);
    }

    const env = { ...process.env, ...(config.env ?? {}) };
    const child = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const connection: MCPConnection = {
      config,
      tools: [],
      process: child,
      nextId: 1,
      pendingRequests: new Map(),
      buffer: "",
    };

    // Wire stdout to parse JSON-RPC responses.
    child.stdout?.on("data", (chunk: Buffer) => {
      connection.buffer += chunk.toString();
      this.processBuffer(connection);
    });

    child.on("error", (err) => {
      console.error(`Champ MCP: server "${config.name}" error:`, err.message);
    });

    child.on("exit", (code) => {
      console.log(
        `Champ MCP: server "${config.name}" exited with code ${code}`,
      );
      // Reject and clean up all pending requests.
      for (const [, pending] of connection.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server exited with code ${code}`));
      }
      connection.pendingRequests.clear();
      // Remove the dead connection so reconnect works correctly.
      this.connections.delete(config.name);
      // Notify the registry so it can unregister the server's tools.
      this.onServerExit?.(config.name, code);
    });

    this.connections.set(config.name, connection);

    // MCP handshake: initialize.
    try {
      await this.sendRequest(config.name, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "champ-vscode", version: "0.3.0" },
      });

      // Notify initialized.
      this.sendNotification(config.name, "notifications/initialized", {});

      // Fetch tool catalog.
      const toolsResult = (await this.sendRequest(
        config.name,
        "tools/list",
        {},
      )) as { tools?: MCPTool[] };
      connection.tools = toolsResult?.tools ?? [];
    } catch (err) {
      // If handshake fails, clean up.
      child.kill();
      this.connections.delete(config.name);
      throw err;
    }
  }

  async disconnect(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (connection?.process) {
      connection.process.kill();
    }
    this.connections.delete(serverName);
  }

  async listTools(serverName: string): Promise<MCPTool[]> {
    const connection = this.connections.get(serverName);
    return connection ? [...connection.tools] : [];
  }

  async invokeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return {
        content: [
          {
            type: "text",
            text: `MCP server "${serverName}" is not connected`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = (await this.sendRequest(serverName, "tools/call", {
        name: toolName,
        arguments: args,
      })) as { content?: MCPContentBlock[]; isError?: boolean };

      return {
        content: result?.content ?? [{ type: "text", text: "" }],
        isError: result?.isError ?? false,
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  getConnectedServers(): string[] {
    return Array.from(this.connections.keys());
  }

  async disconnectAll(): Promise<void> {
    for (const name of Array.from(this.connections.keys())) {
      await this.disconnect(name);
    }
  }

  // ---- JSON-RPC helpers ------------------------------------------------

  private sendRequest(
    serverName: string,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const connection = this.connections.get(serverName);
    if (!connection?.process?.stdin) {
      return Promise.reject(
        new Error(`MCP server "${serverName}" is not connected`),
      );
    }

    const id = connection.nextId++;
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (connection.pendingRequests.has(id)) {
          connection.pendingRequests.delete(id);
          reject(new Error(`MCP request ${method} timed out after 30s`));
        }
      }, 30_000);
      connection.pendingRequests.set(id, { resolve, reject, timer });
      connection.process!.stdin!.write(message + "\n");
    });
  }

  private sendNotification(
    serverName: string,
    method: string,
    params: unknown,
  ): void {
    const connection = this.connections.get(serverName);
    if (!connection?.process?.stdin) return;

    const message = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    connection.process.stdin.write(message + "\n");
  }

  private processBuffer(connection: MCPConnection): void {
    const lines = connection.buffer.split("\n");
    // Keep the last incomplete line in the buffer.
    connection.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as {
          id?: number;
          result?: unknown;
          error?: { code: number; message: string };
        };

        if (msg.id !== undefined) {
          const pending = connection.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            connection.pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(
                new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
              );
            } else {
              pending.resolve(msg.result);
            }
          }
        }
        // Notifications from the server are ignored for now.
      } catch {
        // Malformed JSON — skip.
      }
    }
  }
}
