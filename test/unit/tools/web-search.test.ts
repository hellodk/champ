/**
 * TDD: Tests for web_search tool.
 * Validates Brave Search API integration with error handling and result formatting.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createWebSearchTool } from "@/tools/web-search";
import type { ToolExecutionContext } from "@/tools/types";

describe("web_search tool", () => {
  let context: ToolExecutionContext;
  let mockSecretStorage: {
    get: (key: string) => PromiseLike<string | undefined>;
  };
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSecretStorage = {
      get: vi.fn(),
    };
    context = {
      workspaceRoot: "/test-workspace",
      abortSignal: new AbortController().signal,
      reportProgress: vi.fn(),
      requestApproval: vi.fn(),
    };
    fetchSpy = vi.spyOn(global, "fetch" as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should have correct metadata", async () => {
    const tool = createWebSearchTool(mockSecretStorage);
    expect(tool.name).toBe("web_search");
    expect(tool.requiresApproval).toBe(false);
    expect(tool.parameters.required).toContain("query");
    expect(tool.parameters.properties.count).toBeDefined();
  });

  it("should return error when API key is not set", async () => {
    (mockSecretStorage.get as any).mockResolvedValue(undefined);
    const tool = createWebSearchTool(mockSecretStorage);

    const result = await tool.execute({ query: "test" }, context);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Brave API key not configured");
  });

  it("should successfully search with valid API key", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          web: [
            {
              title: "Test Result 1",
              url: "https://example.com/1",
              description: "This is a test result",
              thumbnail: "https://example.com/thumb.jpg",
            },
            {
              title: "Test Result 2",
              url: "https://example.com/2",
              description: "Another test result",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    const result = await tool.execute({ query: "test query" }, context);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Test Result 1");
    expect(result.output).toContain("https://example.com/1");
    expect(result.output).toContain("This is a test result");
  });

  it("should truncate results to specified count", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    const webResults = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      description: `Description ${i + 1}`,
    }));
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ web: webResults }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    const result = await tool.execute({ query: "test", count: 3 }, context);

    expect(result.success).toBe(true);
    // Should only include first 3 results
    expect(result.output).toContain("Result 1");
    expect(result.output).toContain("Result 2");
    expect(result.output).toContain("Result 3");
    expect(result.output).not.toContain("Result 4");
  });

  it("should default to 5 results when count is not specified", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    const webResults = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      description: `Description ${i + 1}`,
    }));
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ web: webResults }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    const result = await tool.execute({ query: "test" }, context);

    expect(result.success).toBe(true);
    // Should only include first 5 results (default)
    expect(result.output).toContain("Result 1");
    expect(result.output).toContain("Result 5");
    expect(result.output).not.toContain("Result 6");
  });

  it("should handle API error responses", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid API key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    const result = await tool.execute({ query: "test" }, context);

    expect(result.success).toBe(false);
    expect(result.output).toContain("HTTP 401");
  });

  it("should handle network errors", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    fetchSpy.mockRejectedValue(new Error("Network timeout"));

    const tool = createWebSearchTool(mockSecretStorage);
    const result = await tool.execute({ query: "test" }, context);

    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
  });

  it("should properly format search results with URL and snippet", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          web: [
            {
              title: "How to use TypeScript",
              url: "https://www.typescriptlang.org/docs/",
              description:
                "Official TypeScript documentation with guides and examples",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    const result = await tool.execute({ query: "typescript" }, context);

    expect(result.success).toBe(true);
    expect(result.output).toContain("How to use TypeScript");
    expect(result.output).toContain("https://www.typescriptlang.org/docs/");
    expect(result.output).toContain("Official TypeScript documentation");
  });

  it("should support pagination with offset parameter", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          web: [
            {
              title: "Result 6",
              url: "https://example.com/6",
              description: "Sixth result",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    const result = await tool.execute(
      { query: "test", offset: 5, count: 1 },
      context,
    );

    expect(result.success).toBe(true);
    // Verify that the offset parameter was used in the API call
    expect(fetchSpy).toHaveBeenCalled();
    const callUrl = (fetchSpy.mock.calls[0]?.[0] as string) || "";
    expect(callUrl).toContain("offset=5");
  });

  it("should respect freshness parameter", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ web: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    await tool.execute({ query: "test", freshness: "pw" }, context);

    // Verify the freshness parameter was passed in the API call
    expect(fetchSpy).toHaveBeenCalled();
    const callUrl = (fetchSpy.mock.calls[0]?.[0] as string) || "";
    expect(callUrl).toContain("freshness=pw");
  });

  it("should use correct Brave Search API endpoint", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ web: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    await tool.execute({ query: "test" }, context);

    expect(fetchSpy).toHaveBeenCalled();
    const callUrl = (fetchSpy.mock.calls[0]?.[0] as string) || "";
    expect(callUrl).toContain("api.search.brave.com");
    expect(callUrl).toContain("/res/v1/web/search");
  });

  it("should handle malformed API response", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    fetchSpy.mockResolvedValue(
      new Response("invalid json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    const result = await tool.execute({ query: "test" }, context);

    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
  });

  it("should enforce max results limit of 10", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("test-api-key");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ web: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    await tool.execute({ query: "test", count: 15 }, context);

    // Verify the count was capped at 10
    expect(fetchSpy).toHaveBeenCalled();
    const callUrl = (fetchSpy.mock.calls[0]?.[0] as string) || "";
    expect(callUrl).toContain("count=10");
  });

  it("should include Authorization header with API key", async () => {
    (mockSecretStorage.get as any).mockResolvedValue("my-secret-key");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ web: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tool = createWebSearchTool(mockSecretStorage);
    await tool.execute({ query: "test" }, context);

    expect(fetchSpy).toHaveBeenCalled();
    const callOptions = fetchSpy.mock.calls[0]?.[1];
    expect(callOptions?.headers?.["Accept-Encoding"]).toBe("gzip");
    expect(callOptions?.headers?.["X-Subscription-Token"]).toBe(
      "my-secret-key",
    );
  });
});
