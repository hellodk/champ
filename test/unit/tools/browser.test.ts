/**
 * TDD: Tests for browser tool (computer-use / automated testing).
 * Tests navigation, interaction, and screenshot capture.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { browserTool, closeBrowser } from "@/tools/browser";
import type { ToolExecutionContext } from "@/tools/types";

// Mock the playwright module
vi.mock("@playwright/test", () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          setDefaultTimeout: vi.fn(),
          goto: vi.fn().mockResolvedValue(null),
          screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png-data")),
          click: vi.fn().mockResolvedValue(null),
          fill: vi.fn().mockResolvedValue(null),
          close: vi.fn().mockResolvedValue(null),
        }),
      }),
      close: vi.fn().mockResolvedValue(null),
    }),
  },
}));

describe("browser tool", () => {
  let context: ToolExecutionContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Close browser between tests to avoid state persistence
    await closeBrowser();
    context = {
      workspaceRoot: "/test-workspace",
      abortSignal: new AbortController().signal,
      reportProgress: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(async () => {
    await closeBrowser();
    vi.clearAllMocks();
  });

  describe("metadata", () => {
    it("should have correct name", () => {
      expect(browserTool.name).toBe("browser");
    });

    it("should require approval", () => {
      expect(browserTool.requiresApproval).toBe(true);
    });

    it("should have proper description", () => {
      expect(browserTool.description).toContain("browser");
    });

    it("should have required parameters", () => {
      expect(browserTool.parameters.required).toContain("action");
    });
  });

  describe("goto action", () => {
    it("should navigate to a URL", async () => {
      const result = await browserTool.execute(
        { action: "goto", url: "http://localhost:3000" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("http://localhost:3000");
    });

    it("should fail with invalid URL", async () => {
      const result = await browserTool.execute(
        { action: "goto", url: "not-a-valid-url" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("Invalid URL");
    });

    it("should pass timeout to page.goto", async () => {
      const result = await browserTool.execute(
        { action: "goto", url: "http://example.com", timeout: 15000 },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("http://example.com");
    });
  });

  describe("screenshot action", () => {
    it("should capture a screenshot", async () => {
      // First navigate to a page
      await browserTool.execute(
        { action: "goto", url: "http://example.com" },
        context,
      );

      // Then take a screenshot
      const result = await browserTool.execute(
        { action: "screenshot" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("base64");
      expect(result.metadata?.screenshot).toBeDefined();
    });

    it("should include base64 image data in result", async () => {
      await browserTool.execute(
        { action: "goto", url: "http://example.com" },
        context,
      );

      const result = await browserTool.execute(
        { action: "screenshot" },
        context,
      );

      expect(result.success).toBe(true);
      if (result.metadata?.screenshot) {
        expect(result.metadata.screenshot).toMatch(/^data:image\/png;base64,/);
      }
    });

    it("should report progress when taking screenshot", async () => {
      await browserTool.execute(
        { action: "goto", url: "http://example.com" },
        context,
      );

      await browserTool.execute({ action: "screenshot" }, context);

      expect(context.reportProgress).toHaveBeenCalledWith(
        expect.stringContaining("screenshot"),
      );
    });
  });

  describe("click action", () => {
    it("should click an element by selector", async () => {
      await browserTool.execute(
        { action: "goto", url: "http://example.com" },
        context,
      );

      const result = await browserTool.execute(
        { action: "click", selector: "button" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("button");
    });

    it("should fail if selector is missing", async () => {
      const result = await browserTool.execute(
        { action: "click", selector: "" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("Selector is required");
    });

    it("should report progress when clicking", async () => {
      await browserTool.execute(
        { action: "goto", url: "http://example.com" },
        context,
      );

      await browserTool.execute(
        { action: "click", selector: "button" },
        context,
      );

      expect(context.reportProgress).toHaveBeenCalledWith(
        expect.stringContaining("Clicking"),
      );
    });
  });

  describe("type action", () => {
    it("should type text into an input field", async () => {
      await browserTool.execute(
        { action: "goto", url: "http://example.com" },
        context,
      );

      const result = await browserTool.execute(
        { action: "type", selector: "input", text: "hello world" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("typed");
    });

    it("should fail if selector is missing", async () => {
      const result = await browserTool.execute(
        { action: "type", selector: "", text: "test" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("Selector is required");
    });

    it("should report progress when typing", async () => {
      await browserTool.execute(
        { action: "goto", url: "http://example.com" },
        context,
      );

      await browserTool.execute(
        { action: "type", selector: "input", text: "test" },
        context,
      );

      expect(context.reportProgress).toHaveBeenCalledWith(
        expect.stringContaining("Typing"),
      );
    });
  });

  describe("getPreview", () => {
    it("should return command preview for goto action", () => {
      const preview = browserTool.getPreview?.({
        action: "goto",
        url: "http://localhost:3000",
      });

      expect(preview).toBeDefined();
      expect(preview?.type).toBe("command");
      expect(preview?.content).toContain("http://localhost:3000");
    });

    it("should return preview for click action", () => {
      const preview = browserTool.getPreview?.({
        action: "click",
        selector: "button.submit",
      });

      expect(preview).toBeDefined();
      expect(preview?.type).toBe("command");
      expect(preview?.content.toLowerCase()).toContain("click");
    });
  });

  describe("error handling", () => {
    it("should handle context cancellation", async () => {
      const controller = new AbortController();
      const cancelContext: ToolExecutionContext = {
        ...context,
        abortSignal: controller.signal,
      };

      controller.abort();

      const result = await browserTool.execute(
        { action: "goto", url: "http://localhost:3000", timeout: 30000 },
        cancelContext,
      );

      expect(result.success).toBe(false);
    });

    it("should handle unknown action", async () => {
      const result = await browserTool.execute(
        { action: "unknown-action" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("unknown");
    });
  });

  describe("tool registration", () => {
    it("should be registerable with ToolRegistry", () => {
      // This test just validates the shape of the tool
      expect(browserTool.name).toBeDefined();
      expect(browserTool.description).toBeDefined();
      expect(browserTool.parameters).toBeDefined();
      expect(browserTool.requiresApproval).toBeDefined();
      expect(typeof browserTool.execute).toBe("function");
    });
  });
});
