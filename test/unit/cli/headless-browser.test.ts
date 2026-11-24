import { describe, expect, it, vi } from "vitest";

const launch = vi.fn(async () => ({ newContext: vi.fn() }));
vi.mock("@playwright/test", () => ({
  chromium: { launch: (...args: unknown[]) => launch(...args) },
}));

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
    expect(launch).not.toHaveBeenCalled();
  });

  it("returns a structured error when the browser cannot start", async () => {
    launch.mockRejectedValueOnce(new Error("playwright-core is missing"));
    const result = await browserTool.execute(
      { action: "goto", url: "https://example.com" },
      context(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("browser is unavailable");
  });
});
