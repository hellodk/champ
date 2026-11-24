/**
 * CLI tool parity with the VS Code extension.
 *
 * The headless registry must expose every built-in tool that does not require
 * VS Code APIs, and must be able to load MCP servers from the same config the
 * extension reads. The two remote-SSH tools stay extension-only: they need a
 * live SSH pool that the CLI does not own. The simulated browser tool is
 * deliberately excluded until a real, url-guarded implementation exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHeadlessToolRegistry,
  loadHeadlessMcpServers,
} from "@/tools/headless";
import type { ToolExecutionContext } from "@/tools/types";
import type { MCPClientManager, MCPTool } from "@/mcp/mcp-client";

const HEADLESS_BUILTINS = [
  "read_file",
  "edit_file",
  "create_file",
  "delete_file",
  "list_directory",
  "grep_search",
  "file_search",
  "run_terminal_cmd",
  "run_tests",
  "generate_diagram",
  "generate_doc",
  "fetch_url",
  "web_search",
  "codebase_search",
  "git",
  "delegate_task",
];

function context(): ToolExecutionContext {
  return {
    workspaceRoot: "/tmp/ws",
    abortSignal: new AbortController().signal,
    reportProgress: () => {},
    requestApproval: async () => true,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("headless CLI tool parity", () => {
  it("registers every built-in tool available to the VS Code agent", () => {
    const registry = createHeadlessToolRegistry();
    expect(
      registry
        .getAll()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([...HEADLESS_BUILTINS].sort());
  });

  it("does not advertise the simulated browser tool", () => {
    expect(createHeadlessToolRegistry().get("browser_tool")).toBeUndefined();
  });

  it("reports a CLI-specific Brave key hint instead of a VS Code command", async () => {
    const tool = createHeadlessToolRegistry().get("web_search");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ query: "hello" }, context());
    expect(result.success).toBe(false);
    expect(result.output).toContain("BRAVE_API_KEY");
    expect(result.output).not.toContain("Command Palette");
  });

  it("uses an injected Brave API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: [{ title: "t", url: "https://x", description: "d" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const registry = createHeadlessToolRegistry({ braveApiKey: "test-key" });
    const result = await registry
      .get("web_search")!
      .execute({ query: "hello" }, context());

    expect(result.success).toBe(true);
    const headers = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers["X-Subscription-Token"]).toBe("test-key");
  });

  it("loads MCP tools with secrets resolved from CLI config", async () => {
    const mcpTool: MCPTool = {
      name: "echo",
      description: "echo tool",
      inputSchema: { type: "object", properties: {}, required: [] },
    };
    const connected: string[] = [];
    let seenEnv: Record<string, string> | undefined;
    const manager = {
      onServerExit: undefined,
      connect: async (config: { env?: Record<string, string> }) => {
        seenEnv = config.env;
        connected.push("demo");
      },
      getConnectedServers: () => connected,
      listTools: async () => [mcpTool],
      listResources: async () => [],
      listPrompts: async () => [],
      disconnect: async () => {},
      reconnect: async () => {},
    } as unknown as MCPClientManager;

    const registry = createHeadlessToolRegistry();
    await loadHeadlessMcpServers(
      registry,
      [
        {
          name: "demo",
          transport: "stdio",
          command: "node",
          args: [],
          env: { TOKEN: "${{ secrets.DEMO_TOKEN }}" },
        },
      ],
      {
        manager,
        secrets: {
          get: async (key) => (key === "DEMO_TOKEN" ? "s3cret" : undefined),
        },
      },
    );

    expect(seenEnv?.TOKEN).toBe("s3cret");
    expect(registry.get("mcp_demo_echo")?.name).toBe("mcp_demo_echo");
  });
});
