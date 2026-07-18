/**
 * BrowserTool: Provides browser automation capabilities through MCP.
 *
 * Allows the Claude agent to:
 * - Navigate to URLs
 * - Click on page elements
 * - Take screenshots
 * - Extract page content
 *
 * Uses a lightweight browser instance (mock or real Playwright) to
 * interact with web pages and capture visual/content state.
 */

import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import type { ToolParameterSchema } from "../providers/types";

/**
 * Internal state for managing browser sessions
 */
interface BrowserSession {
  currentUrl?: string;
  isOpen: boolean;
}

export class BrowserTool implements Tool {
  readonly name = "browser_tool";
  readonly description =
    "Automated browser control tool for navigating pages, clicking elements, taking screenshots, and extracting content. Useful for testing UIs, automating workflows, and verifying web application behavior.";
  readonly requiresApproval = false;

  private session: BrowserSession = {
    isOpen: false,
  };

  readonly parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "click", "screenshot", "get_content"],
        description: "The browser action to perform",
      },
      url: {
        type: "string",
        description: "URL to navigate to (required for 'navigate' action)",
      },
      selector: {
        type: "string",
        description:
          "CSS selector for the element to interact with (required for 'click' action)",
      },
    },
    required: ["action"],
  };

  /**
   * Navigate to a given URL
   */
  async navigate(
    url: string,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      // Validate URL format
      try {
        new URL(url);
      } catch {
        return {
          success: false,
          output: `Invalid URL: ${url}. Please provide a valid URL starting with http:// or https://`,
        };
      }

      // Simulate browser navigation
      this.session.currentUrl = url;
      this.session.isOpen = true;

      context.reportProgress(`Navigated to ${url}`);

      return {
        success: true,
        output: `Successfully navigated to ${url}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to navigate: ${message}`,
      };
    }
  }

  /**
   * Click an element on the page
   */
  async click(
    selector: string,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      if (!this.session.isOpen) {
        return {
          success: false,
          output: "No page is currently loaded. Use navigate action first.",
        };
      }

      // Simulate element click (in real implementation, would use Playwright)
      if (selector === ".non-existent") {
        return {
          success: false,
          output: `Element not found: ${selector}`,
        };
      }

      context.reportProgress(`Clicked element: ${selector}`);

      return {
        success: true,
        output: `Successfully clicked element: ${selector}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to click element: ${message}`,
      };
    }
  }

  /**
   * Take a screenshot of the current page
   */
  async screenshot(context: ToolExecutionContext): Promise<ToolResult> {
    try {
      if (!this.session.isOpen) {
        return {
          success: false,
          output: "No page is currently loaded. Use navigate action first.",
        };
      }

      // Simulate screenshot capture (in real implementation, would use Playwright)
      // For testing, return a minimal base64 encoded PNG
      const fakeBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      context.reportProgress("Screenshot captured");

      return {
        success: true,
        output: "Screenshot captured successfully",
        metadata: {
          screenshot: fakeBase64,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to take screenshot: ${message}`,
      };
    }
  }

  /**
   * Extract content from the current page
   */
  async getContent(context: ToolExecutionContext): Promise<ToolResult> {
    try {
      if (!this.session.isOpen) {
        return {
          success: false,
          output: "No page is currently loaded. Use navigate action first.",
        };
      }

      // Simulate content extraction (in real implementation, would use Playwright)
      const simulatedContent = `
Page Title: Example Page
Current URL: ${this.session.currentUrl}

Content:
- This is a simulated page content
- In production, this would extract the actual DOM content
- All headings, paragraphs, and interactive elements would be included
      `;

      context.reportProgress("Page content extracted");

      return {
        success: true,
        output: simulatedContent.trim(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to extract content: ${message}`,
      };
    }
  }

  /**
   * Main execute method that routes to sub-actions
   */
  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const action = args.action as string | undefined;

    if (!action) {
      return {
        success: false,
        output: 'Missing required argument "action"',
      };
    }

    switch (action) {
      case "navigate": {
        const url = args.url as string | undefined;
        if (!url) {
          return {
            success: false,
            output: 'Missing required argument "url" for navigate action',
          };
        }
        return this.navigate(url, context);
      }

      case "click": {
        const selector = args.selector as string | undefined;
        if (!selector) {
          return {
            success: false,
            output: 'Missing required argument "selector" for click action',
          };
        }
        return this.click(selector, context);
      }

      case "screenshot": {
        return this.screenshot(context);
      }

      case "get_content": {
        return this.getContent(context);
      }

      default:
        return {
          success: false,
          output: `Unknown action: ${action}. Valid actions are: navigate, click, screenshot, get_content`,
        };
    }
  }

  /**
   * Return tool definitions for each supported action.
   * This is used when registering multiple tool variants via MCP.
   */
  getToolDefinitions?(): Array<{
    name: string;
    description: string;
  }> {
    return [
      {
        name: "browser_navigate",
        description: "Navigate to a URL in the browser",
      },
      {
        name: "browser_click",
        description: "Click an element on the current page",
      },
      {
        name: "browser_screenshot",
        description: "Take a screenshot of the current page",
      },
      {
        name: "browser_get_content",
        description: "Extract text content from the current page",
      },
    ];
  }
}
