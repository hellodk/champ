import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ToolExecutionContext } from "@/tools/types";

vi.mock("@playwright/test", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

import { browserTool } from "@/tools/browser";
import { chromium } from "@playwright/test";

describe("browser tool SSRF guard", () => {
  let mockContext: ToolExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = {
      workspaceRoot: "/test/workspace",
      abortSignal: new AbortController().signal,
      reportProgress: vi.fn(),
      requestApproval: vi.fn(() => Promise.resolve(true)),
    };
  });

  it("rejects goto to loopback address without launching playwright", async () => {
    const result = await browserTool.execute(
      { action: "goto", url: "http://127.0.0.1:9222" },
      mockContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/loopback|private|internal/i);
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it("rejects goto to file:// URLs without launching playwright", async () => {
    const result = await browserTool.execute(
      { action: "goto", url: "file:///etc/passwd" },
      mockContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/scheme|http/i);
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});
