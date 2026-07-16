/**
 * Browser tool for automated UI testing and navigation.
 * Provides actions for navigating to URLs, taking screenshots, clicking elements, and typing text.
 * Uses Playwright for cross-browser automation.
 */

import type {
  Tool,
  ToolResult,
  ToolExecutionContext,
  ToolPreview,
} from "./types";
import type { ToolParameterSchema } from "../providers/types";
import { chromium, type Browser, type Page } from "@playwright/test";

/**
 * Global browser instance shared across tool invocations within a session.
 * Initialized lazily on first use, closed when context is destroyed or explicitly requested.
 */
let browser: Browser | null = null;
let page: Page | null = null;

/**
 * Ensures a browser instance is available.
 */
async function ensureBrowser(): Promise<void> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  if (!page) {
    const context = await browser.newContext();
    page = await context.newPage();
    // Set a reasonable timeout for all page operations
    page.setDefaultTimeout(30000);
  }
}

/**
 * Closes the browser instance and cleans up resources.
 */
export async function closeBrowser(): Promise<void> {
  if (page) {
    try {
      await page.close();
    } catch {
      // Ignore errors during cleanup
    }
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      // Ignore errors during cleanup
    }
  }
  browser = null;
  page = null;
}

/**
 * Validates a URL string.
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Main browser tool that exposes navigation and interaction capabilities to the LLM.
 */
export const browserTool: Tool = {
  name: "browser",
  description:
    "Navigate and interact with web browsers for automated testing. Supports goto, screenshot, click, and type actions.",
  requiresApproval: true,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["goto", "screenshot", "click", "type", "close"],
        description: "The browser action to perform.",
      },
      url: {
        type: "string",
        description: "URL to navigate to (required for 'goto' action).",
      },
      selector: {
        type: "string",
        description:
          "CSS selector for the target element (required for 'click' and 'type' actions).",
      },
      text: {
        type: "string",
        description:
          "Text to type into an element (required for 'type' action).",
      },
      timeout: {
        type: "number",
        description:
          "Timeout in milliseconds for the operation (default: 30000).",
      },
    },
    required: ["action"],
  } as ToolParameterSchema,

  /**
   * Generate a preview of the action to be taken.
   */
  getPreview(args: Record<string, unknown>): ToolPreview | undefined {
    const action = String(args.action);
    let content = "";

    switch (action) {
      case "goto":
        content = `Navigate to: ${args.url || "unknown URL"}`;
        break;
      case "screenshot":
        content = "Capture screenshot of current page";
        break;
      case "click":
        content = `Click on element: ${args.selector || "unknown selector"}`;
        break;
      case "type":
        content = `Type text in element: ${args.selector || "unknown selector"}\nText: ${args.text || ""}`;
        break;
      case "close":
        content = "Close browser and cleanup resources";
        break;
      default:
        return undefined;
    }

    return {
      type: "command",
      content,
    };
  },

  /**
   * Execute a browser action.
   */
  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      // Check for cancellation
      if (context.abortSignal.aborted) {
        return {
          success: false,
          output: "Operation cancelled by user.",
        };
      }

      const action = String(args.action);
      const timeout = (args.timeout as number) || 30000;

      switch (action) {
        case "goto": {
          const url = String(args.url || "");
          if (!isValidUrl(url)) {
            return {
              success: false,
              output: `Invalid URL: ${url}. Must be a valid HTTP(S) URL.`,
            };
          }

          try {
            await ensureBrowser();
            if (!page) {
              return {
                success: false,
                output: "Failed to initialize browser page.",
              };
            }

            context.reportProgress(`Navigating to ${url}...`);

            // Use abort signal for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            try {
              await page.goto(url, { waitUntil: "domcontentloaded" });
              clearTimeout(timeoutId);
            } catch (err) {
              clearTimeout(timeoutId);
              if (context.abortSignal.aborted || controller.signal.aborted) {
                return {
                  success: false,
                  output: `Navigation timeout after ${timeout}ms.`,
                };
              }
              throw err;
            }

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

        case "screenshot": {
          try {
            await ensureBrowser();
            if (!page) {
              return {
                success: false,
                output: "No browser page loaded. Use 'goto' action first.",
              };
            }

            context.reportProgress("Taking screenshot...");
            const screenshotBuffer = await page.screenshot();
            const base64 = screenshotBuffer.toString("base64");
            const dataUrl = `data:image/png;base64,${base64}`;

            return {
              success: true,
              output: `Screenshot captured (${screenshotBuffer.length} bytes). Image: ${dataUrl.substring(0, 50)}...`,
              metadata: {
                screenshot: dataUrl,
              },
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              success: false,
              output: `Failed to capture screenshot: ${message}`,
            };
          }
        }

        case "click": {
          const selector = String(args.selector || "");
          if (!selector) {
            return {
              success: false,
              output: "Selector is required for 'click' action.",
            };
          }

          try {
            await ensureBrowser();
            if (!page) {
              return {
                success: false,
                output: "No browser page loaded. Use 'goto' action first.",
              };
            }

            context.reportProgress(`Clicking on ${selector}...`);
            await page.click(selector, { timeout });

            return {
              success: true,
              output: `Successfully clicked on element: ${selector}`,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              success: false,
              output: `Failed to click element "${selector}": ${message}`,
            };
          }
        }

        case "type": {
          const selector = String(args.selector || "");
          const text = String(args.text || "");

          if (!selector) {
            return {
              success: false,
              output: "Selector is required for 'type' action.",
            };
          }

          try {
            await ensureBrowser();
            if (!page) {
              return {
                success: false,
                output: "No browser page loaded. Use 'goto' action first.",
              };
            }

            context.reportProgress(`Typing in ${selector}...`);
            await page.fill(selector, text, { timeout });

            return {
              success: true,
              output: `Successfully typed text in element: ${selector}`,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              success: false,
              output: `Failed to type in element "${selector}": ${message}`,
            };
          }
        }

        case "close": {
          try {
            context.reportProgress("Closing browser...");
            await closeBrowser();
            return {
              success: true,
              output: "Browser closed successfully.",
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              success: false,
              output: `Failed to close browser: ${message}`,
            };
          }
        }

        default:
          return {
            success: false,
            output: `Unknown action: ${action}. Supported actions: goto, screenshot, click, type, close.`,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Unexpected error in browser tool: ${message}`,
      };
    }
  },
};
