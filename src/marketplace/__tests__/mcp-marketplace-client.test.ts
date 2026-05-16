import { describe, it, expect, vi, afterEach } from "vitest";
import {
  McpMarketplaceClient,
  buildMcpServerConfig,
  upsertMcpServer,
  isOllamaReachable,
  isEmbeddingModelAvailable,
  type McpMarketplaceEntry,
} from "../mcp-marketplace-client";
import type { MCPServerConfig } from "../../mcp/mcp-client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => vi.clearAllMocks());

const SAMPLE_ENTRY: McpMarketplaceEntry = {
  name: "sqlite",
  description: "SQLite MCP server",
  author: "anthropics",
  url: "https://example.com/sqlite/README.md",
  transport: "stdio",
  command: "uvx",
  args: ["mcp-server-sqlite", "--db-path", "$SQLITE_DB_PATH"],
  env: { SQLITE_DB_PATH: "Absolute path to the SQLite database file" },
  tags: ["database", "local", "sql"],
};

// ---------------------------------------------------------------------------
// fetchManifest
// ---------------------------------------------------------------------------
describe("McpMarketplaceClient.fetchManifest", () => {
  it("returns parsed manifest on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [SAMPLE_ENTRY],
    });
    const entries = await new McpMarketplaceClient().fetchManifest();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("sqlite");
  });

  it("returns empty array on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ENOTFOUND"));
    expect(await new McpMarketplaceClient().fetchManifest()).toEqual([]);
  });

  it("returns empty array on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    expect(await new McpMarketplaceClient().fetchManifest()).toEqual([]);
  });

  it("returns empty array when response is not an array", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ foo: "bar" }),
    });
    expect(await new McpMarketplaceClient().fetchManifest()).toEqual([]);
  });

  it("uses custom URL when provided", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await new McpMarketplaceClient(
      "https://custom.com/mcp-manifest.json",
    ).fetchManifest();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://custom.com/mcp-manifest.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildMcpServerConfig
// ---------------------------------------------------------------------------
describe("buildMcpServerConfig", () => {
  it("builds stdio config correctly", () => {
    const config = buildMcpServerConfig(SAMPLE_ENTRY, {
      SQLITE_DB_PATH: "/home/user/data.db",
    });
    expect(config.name).toBe("sqlite");
    expect(config.transport).toBe("stdio");
    expect(config.command).toBe("uvx");
    expect(config.args).toContain("mcp-server-sqlite");
    expect(config.env).toEqual({ SQLITE_DB_PATH: "/home/user/data.db" });
  });

  it("builds sse config correctly", () => {
    const sseEntry: McpMarketplaceEntry = {
      ...SAMPLE_ENTRY,
      name: "remote-server",
      transport: "sse",
      baseUrl: "http://localhost:3000",
    };
    const config = buildMcpServerConfig(sseEntry, {});
    expect(config.transport).toBe("sse");
    expect(config.url).toBe("http://localhost:3000");
    expect(config.env).toBeUndefined();
  });

  it("omits env field when resolvedEnv is empty", () => {
    const config = buildMcpServerConfig(SAMPLE_ENTRY, {});
    expect(config.env).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// upsertMcpServer
// ---------------------------------------------------------------------------
describe("upsertMcpServer", () => {
  const base: MCPServerConfig = {
    name: "sqlite",
    command: "uvx",
    args: ["mcp-server-sqlite"],
    transport: "stdio",
  };

  it("appends a new server when name is not present", () => {
    const servers: MCPServerConfig[] = [];
    const { servers: result, wasUpdate } = upsertMcpServer(servers, base);
    expect(result).toHaveLength(1);
    expect(wasUpdate).toBe(false);
  });

  it("replaces existing server with same name", () => {
    const existing: MCPServerConfig = { ...base, command: "old-cmd" };
    const servers: MCPServerConfig[] = [existing];
    const { servers: result, wasUpdate } = upsertMcpServer(servers, base);
    expect(result).toHaveLength(1);
    expect(result[0].command).toBe("uvx");
    expect(wasUpdate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isOllamaReachable
// ---------------------------------------------------------------------------
describe("isOllamaReachable", () => {
  it("returns true when ollama responds with ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    expect(await isOllamaReachable()).toBe(true);
  });

  it("returns false when ollama responds with non-ok status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    expect(await isOllamaReachable()).toBe(false);
  });

  it("returns false on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await isOllamaReachable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEmbeddingModelAvailable
// ---------------------------------------------------------------------------
describe("isEmbeddingModelAvailable", () => {
  it("returns true when exact model name is in the list", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "nomic-embed-text" }] }),
    });
    expect(await isEmbeddingModelAvailable("nomic-embed-text")).toBe(true);
  });

  it("returns true when model name matches with a tag prefix", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "nomic-embed-text:latest" }] }),
    });
    expect(await isEmbeddingModelAvailable("nomic-embed-text")).toBe(true);
  });

  it("returns false when model is not in the list", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "llama3" }] }),
    });
    expect(await isEmbeddingModelAvailable("nomic-embed-text")).toBe(false);
  });
});
