import { describe, it, expect } from "vitest";
import { fetchUrlTool } from "@/tools/fetch-url";
import type { ToolExecutionContext } from "@/tools/types";

describe("fetch_url URL guard", () => {
  const mockContext: ToolExecutionContext = {
    workspaceRoot: "/test/workspace",
    abortSignal: new AbortController().signal,
    reportProgress: vi.fn(),
    requestApproval: vi.fn(() => Promise.resolve(true)),
  };

  it("rejects non-http schemes with the established message", async () => {
    const result = await fetchUrlTool.execute(
      { url: "file:///etc/passwd" },
      mockContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain(
      "Only http:// and https:// URLs are allowed",
    );
  });

  it("rejects loopback addresses with the established message", async () => {
    const result = await fetchUrlTool.execute(
      { url: "http://127.0.0.1:8080/admin" },
      mockContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("internal/private network addresses");
  });

  it("rejects link-local metadata endpoints", async () => {
    const result = await fetchUrlTool.execute(
      { url: "http://169.254.169.254/latest/meta-data" },
      mockContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("internal/private network addresses");
  });

  it("rejects unparseable URLs with the established message", async () => {
    const result = await fetchUrlTool.execute(
      { url: "not-a-url" },
      mockContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toBe('Error: Invalid URL "not-a-url"');
  });
});
