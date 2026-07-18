import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BrowserTool } from "../../src/tools/browser-tool";
import type { ToolExecutionContext } from "../../src/tools/types";

describe("BrowserTool", () => {
  let tool: BrowserTool;
  let mockContext: ToolExecutionContext;

  beforeEach(() => {
    tool = new BrowserTool();
    mockContext = {
      workspaceRoot: "/test/workspace",
      abortSignal: new AbortController().signal,
      reportProgress: vi.fn(),
      requestApproval: vi.fn(() => Promise.resolve(true)),
    };
  });

  describe("navigate", () => {
    it("should have navigate capability in tool definition", () => {
      const definitions = tool.getToolDefinitions?.();
      expect(definitions).toBeDefined();
      const navigateTool = definitions?.find(
        (t) => t.name === "browser_navigate",
      );
      expect(navigateTool).toBeDefined();
      expect(navigateTool?.description.toLowerCase()).toContain("navigate");
    });

    it("should navigate to a URL successfully", async () => {
      const result = await tool.navigate("https://example.com", mockContext);
      expect(result.success).toBe(true);
      expect(result.output).toContain("https://example.com");
    });

    it("should handle invalid URLs", async () => {
      const result = await tool.navigate("not-a-url", mockContext);
      expect(result.success).toBe(false);
    });
  });

  describe("click", () => {
    it("should have click capability in tool definition", () => {
      const definitions = tool.getToolDefinitions?.();
      const clickTool = definitions?.find((t) => t.name === "browser_click");
      expect(clickTool).toBeDefined();
    });

    it("should click an element by selector", async () => {
      await tool.navigate("https://example.com", mockContext);
      const result = await tool.click("button.submit", mockContext);
      expect(result.success).toBe(true);
    });

    it("should return error when element not found", async () => {
      await tool.navigate("https://example.com", mockContext);
      const result = await tool.click(".non-existent", mockContext);
      expect(result.success).toBe(false);
    });
  });

  describe("screenshot", () => {
    it("should have screenshot capability in tool definition", () => {
      const definitions = tool.getToolDefinitions?.();
      const screenshotTool = definitions?.find(
        (t) => t.name === "browser_screenshot",
      );
      expect(screenshotTool).toBeDefined();
    });

    it("should take a screenshot and return base64 data", async () => {
      await tool.navigate("https://example.com", mockContext);
      const result = await tool.screenshot(mockContext);
      expect(result.success).toBe(true);
      expect(result.output).toBeTruthy();
    });

    it("should include screenshot data in metadata", async () => {
      await tool.navigate("https://example.com", mockContext);
      const result = await tool.screenshot(mockContext);
      expect(result.metadata?.screenshot).toBeTruthy();
    });
  });

  describe("getContent", () => {
    it("should have getContent capability in tool definition", () => {
      const definitions = tool.getToolDefinitions?.();
      const contentTool = definitions?.find(
        (t) => t.name === "browser_get_content",
      );
      expect(contentTool).toBeDefined();
    });

    it("should extract page content", async () => {
      await tool.navigate("https://example.com", mockContext);
      const result = await tool.getContent(mockContext);
      expect(result.success).toBe(true);
      expect(result.output).toBeTruthy();
    });
  });

  describe("tool registration", () => {
    it("should be properly typed as a Tool", () => {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
      expect(tool.requiresApproval).toBeDefined();
      expect(tool.execute).toBeDefined();
    });

    it("should have name 'browser_tool'", () => {
      expect(tool.name).toBe("browser_tool");
    });

    it("should not require approval for read operations", () => {
      expect(tool.requiresApproval).toBe(false);
    });

    it("should execute navigate command through execute method", async () => {
      const result = await tool.execute(
        {
          action: "navigate",
          url: "https://example.com",
        },
        mockContext,
      );
      expect(result.success).toBe(true);
    });

    it("should execute click command through execute method", async () => {
      await tool.navigate("https://example.com", mockContext);
      const result = await tool.execute(
        {
          action: "click",
          selector: "button",
        },
        mockContext,
      );
      expect(result.success).toBe(true);
    });

    it("should execute screenshot command through execute method", async () => {
      await tool.navigate("https://example.com", mockContext);
      const result = await tool.execute(
        {
          action: "screenshot",
        },
        mockContext,
      );
      expect(result.success).toBe(true);
    });
  });
});
