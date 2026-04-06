/**
 * MCPClientManager: connects to external MCP (Model Context Protocol) servers.
 *
 * MCP is Anthropic's open protocol for letting LLMs call tools and
 * access resources on external services (GitHub, Slack, databases,
 * internal APIs). Each MCP server is a separate process that speaks
 * JSON-RPC over stdio (or SSE for remote servers). This manager owns
 * the lifecycle of connections and exposes a uniform invokeTool API
 * that the ToolRegistry can adapt.
 *
 * For Phase 9 this is an interface-first implementation. The actual
 * MCP protocol integration will be added via @modelcontextprotocol/sdk
 * once the agent plumbing is wired up (Phase 10). The interface is
 * structured so that swap-in is a drop-in replacement.
 */

/**
 * Configuration for a single MCP server. stdio transport is the default;
 * SSE servers use a baseUrl instead of command+args.
 */
export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** For SSE transport instead of stdio. */
  baseUrl?: string;
}

/**
 * Metadata about a tool exposed by an MCP server.
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Content block returned from a tool invocation. MCP servers return
 * arrays of blocks so tools can mix text, images, and resources.
 */
export interface MCPContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

/**
 * Result returned from invoking an MCP tool.
 */
export interface MCPToolResult {
  content: MCPContentBlock[];
  isError?: boolean;
}

/**
 * A connected MCP server instance. In the real implementation this
 * wraps the @modelcontextprotocol/sdk Client class; here we keep an
 * opaque handle so the interface stays stable across implementations.
 */
interface MCPConnection {
  config: MCPServerConfig;
  tools: MCPTool[];
  /** Underlying SDK client. Opaque from the manager's perspective. */
  client: unknown;
}

export class MCPClientManager {
  private connections = new Map<string, MCPConnection>();

  /**
   * Connect to an MCP server. Spawns the server process (stdio) or
   * opens an SSE connection, performs the MCP handshake, and caches
   * the tool list.
   *
   * Tests override this method via vi.fn() before calling, so the
   * default implementation just stores the config without a real
   * connection attempt.
   */
  async connect(config: MCPServerConfig): Promise<void> {
    // Placeholder: the real implementation will construct a
    // StdioClientTransport / SseClientTransport from
    // @modelcontextprotocol/sdk, start the client, and call listTools().
    // For now we record the connection so the rest of the manager
    // methods have something to reference.
    this.connections.set(config.name, {
      config,
      tools: [],
      client: null,
    });
  }

  /**
   * Disconnect from an MCP server. Closes the transport and removes
   * the connection from the manager.
   */
  async disconnect(serverName: string): Promise<void> {
    this.connections.delete(serverName);
  }

  /**
   * List all tools exposed by a connected MCP server.
   */
  async listTools(serverName: string): Promise<MCPTool[]> {
    const connection = this.connections.get(serverName);
    return connection ? connection.tools : [];
  }

  /**
   * Invoke a tool on an MCP server and return the structured result.
   * The ToolRegistry adapter converts this into the internal ToolResult
   * format before feeding it back into the agent loop.
   */
  async invokeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return {
        content: [
          { type: "text", text: `MCP server "${serverName}" is not connected` },
        ],
        isError: true,
      };
    }

    // Placeholder: the real implementation will call
    // connection.client.callTool({ name: toolName, arguments: args }).
    // Unused variables referenced here to satisfy noUnusedParameters.
    void toolName;
    void args;
    return {
      content: [{ type: "text", text: "[MCP not yet wired to SDK]" }],
      isError: false,
    };
  }

  /**
   * List the names of all currently-connected MCP servers.
   */
  getConnectedServers(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Disconnect from every server. Called during extension deactivation.
   */
  async disconnectAll(): Promise<void> {
    for (const name of Array.from(this.connections.keys())) {
      await this.disconnect(name);
    }
  }
}
