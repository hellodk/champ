import { describe, it, expect, vi } from "vitest";
import { ContextResolver } from "../context-resolver";

const makeMockRegistry = (readResult: string | null) => ({
  readResource: vi.fn().mockResolvedValue(readResult),
  getPrompt: vi.fn().mockResolvedValue(null),
  listResources: vi.fn().mockResolvedValue([]),
  listPrompts: vi.fn().mockResolvedValue([]),
  getStatus: vi.fn().mockReturnValue([]),
  loadServers: vi.fn(),
  disposeAll: vi.fn(),
  reconnect: vi.fn(),
  onStatusChange: undefined,
});

describe("ContextResolver @MCP reference", () => {
  it("parses @MCP(server:uri) reference", () => {
    const resolver = new ContextResolver(
      {
        workspaceRoot: "/",
        indexingService: { search: vi.fn() },
        webSearchTool: { execute: vi.fn() },
      } as never,
      makeMockRegistry("content") as never,
    );
    const refs = resolver.parseReferences(
      "Check @MCP(myserver:file://path/to/res)",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("mcp");
    expect(refs[0].value).toBe("myserver:file://path/to/res");
  });

  it("resolves @MCP reference by calling mcpRegistry.readResource", async () => {
    const mockRegistry = makeMockRegistry("resource content here");
    const resolver = new ContextResolver(
      {
        workspaceRoot: "/",
        indexingService: { search: vi.fn() },
        webSearchTool: { execute: vi.fn() },
      } as never,
      mockRegistry as never,
    );
    const refs = [
      { type: "mcp", value: "myserver:file://path/to/res", start: 0, end: 10 },
    ];
    const result = await resolver.resolve(refs as never);
    expect(result[0].content).toBe("resource content here");
    expect(mockRegistry.readResource).toHaveBeenCalledWith(
      "myserver",
      "file://path/to/res",
    );
  });
});
