import { describe, expect, it, vi } from "vitest";

const { adapter, createBrowserAdapter } = vi.hoisted(() => ({
  adapter: {
    protocol: "webdriver",
    navigate: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue("cG5n"),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  },
  createBrowserAdapter: vi.fn(),
}));

createBrowserAdapter.mockReturnValue(adapter);
vi.mock("@/tools/browser-adapters", () => ({ createBrowserAdapter }));

import { createHeadlessToolRegistry } from "@/tools/headless";
import { browserTool } from "@/tools/browser";
import type { ToolExecutionContext } from "@/tools/types";

function context(): ToolExecutionContext {
  return {
    workspaceRoot: "/repo",
    abortSignal: new AbortController().signal,
    reportProgress: () => undefined,
    requestApproval: async () => true,
  };
}

describe("headless browser tool (#145)", () => {
  it("exposes the real browser tool in the headless registry", () => {
    const names = createHeadlessToolRegistry()
      .getAll()
      .map((tool) => tool.name);
    expect(names).toContain("browser");
  });

  it("still exposes fetch_url and web_search alongside browser", () => {
    const names = createHeadlessToolRegistry()
      .getAll()
      .map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["fetch_url", "web_search"]));
  });

  it("rejects private URLs before launching the browser", async () => {
    const result = await browserTool.execute(
      { action: "goto", url: "http://127.0.0.1:8080" },
      context(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid URL");
    expect(adapter.navigate).not.toHaveBeenCalled();
  });

  it("returns a structured error when the browser cannot start", async () => {
    adapter.navigate.mockRejectedValueOnce(
      new Error("webdriver endpoint unavailable"),
    );
    const result = await browserTool.execute(
      { action: "goto", url: "https://example.com" },
      context(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("browser is unavailable");
  });
});
