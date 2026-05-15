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
  transport?: "stdio" | "sse";
  url?: string;
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
  /** Set when transport is SSE. Null for stdio connections. */
  sseConnection?: MCPSSEConnection;
}

/**
 * MCPSSEConnection: connects to an MCP server via HTTP POST + Server-Sent Events.
 * The server receives requests as HTTP POST to /message, and sends responses as SSE on /sse.
 */
export class MCPSSEConnection {
  private pendingRequests = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private sseAbort: AbortController | null = null;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECTS = 3;
  readonly tools: MCPTool[] = [];
  connected = false;
  error: string | undefined;

  private readonly messageUrl: string;
  private readonly sseUrl: string;

  constructor(
    private readonly baseUrl: string,
    private readonly extraHeaders: Record<string, string> = {},
  ) {
    const base = baseUrl.replace(/\/$/, "");
    this.messageUrl = `${base}/message`;
    this.sseUrl = `${base}/sse`;
  }

  async connect(): Promise<void> {
    this.sseAbort = new AbortController();
    // Start background SSE listener before initialize (server may push init response via SSE)
    void this.listenSSE();
    // Small delay to let SSE connection establish
    await new Promise<void>((r) => setTimeout(r, 100));

    const result = await this.sendRequestInternal("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "champ", version: "1" },
    });
    if (!result)
      throw new Error(`MCP SSE initialize failed at ${this.baseUrl}`);
    await this.sendNotificationInternal("notifications/initialized", {});
    const toolsResult = (await this.sendRequestInternal("tools/list", {})) as {
      tools?: MCPTool[];
    };
    (this.tools as MCPTool[]).push(...(toolsResult?.tools ?? []));
    this.connected = true;
  }

  private async listenSSE(): Promise<void> {
    while (this.reconnectAttempts <= MCPSSEConnection.MAX_RECONNECTS) {
      if (this.sseAbort?.signal.aborted) return;
      try {
        const res = await fetch(this.sseUrl, {
          signal: this.sseAbort!.signal,
          headers: { Accept: "text/event-stream", ...this.extraHeaders },
        });
        if (!res.ok) throw new Error(`SSE ${res.status} ${res.statusText}`);
        if (!res.body) throw new Error("SSE response has no body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        this.reconnectAttempts = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (data) this.handleSSEMessage(data);
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        this.reconnectAttempts++;
        if (this.reconnectAttempts > MCPSSEConnection.MAX_RECONNECTS) {
          this.connected = false;
          this.error = `SSE connection lost after ${MCPSSEConnection.MAX_RECONNECTS} retries`;
          return;
        }
        // Exponential backoff: 1s, 2s, 4s
        await new Promise<void>((r) =>
          setTimeout(r, 1000 * this.reconnectAttempts),
        );
      }
    }
  }

  private handleSSEMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as {
        id?: string;
        result?: unknown;
        error?: { message?: string };
      };
      if (msg.id === undefined) return;
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new Error(msg.error.message ?? JSON.stringify(msg.error)),
        );
      } else {
        pending.resolve(msg.result);
      }
    } catch {
      // Malformed SSE message — ignore
    }
  }

  async sendRequestInternal(method: string, params: unknown): Promise<unknown> {
    const id = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP SSE request "${method}" timed out after 30s`));
      }, 30_000);
      this.pendingRequests.set(id, { resolve, reject, timer });
      void fetch(this.messageUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.extraHeaders },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }).catch((err: Error) => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
  }

  async sendNotificationInternal(
    method: string,
    params: unknown,
  ): Promise<void> {
    await fetch(this.messageUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.extraHeaders },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    }).catch(() => {});
  }

  disconnect(): void {
    this.sseAbort?.abort();
    this.sseAbort = null;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP SSE disconnected"));
    }
    this.pendingRequests.clear();
    this.connected = false;
  }
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
    // If already connected, cleanly disconnect before reconnecting.
    if (this.connections.has(config.name)) {
      await this.disconnect(config.name);
    }

    // SSE/HTTP transport
    if (config.transport === "sse") {
      const url = config.url;
      if (!url) {
        throw new Error(
          `MCP server "${config.name}" requires a \`url\` field for SSE transport`,
        );
      }
      const sseConn = new MCPSSEConnection(url, {});
      await sseConn.connect();
      const stub: MCPConnection = {
        config,
        tools: sseConn.tools,
        process: null,
        nextId: 0,
        pendingRequests: new Map(),
        buffer: "",
        sseConnection: sseConn,
      };
      this.connections.set(config.name, stub);
      return;
    }

    if (!config.command) {
      throw new Error(`MCP server "${config.name}" has no command configured`);
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
    if (connection?.sseConnection) {
      connection.sseConnection.disconnect();
    } else if (connection?.process) {
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
    if (!connection) {
      return Promise.reject(
        new Error(`MCP server "${serverName}" is not connected`),
      );
    }

    // SSE transport: delegate to the SSE connection
    if (connection.sseConnection) {
      return connection.sseConnection.sendRequestInternal(method, params);
    }

    // Stdio transport
    if (!connection.process?.stdin) {
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
