/**
 * Browser tool for automated UI testing and navigation.
 *
 * The tool is protocol-neutral: it calls a BrowserAdapter selected from
 * environment configuration. W3C WebDriver is the default; Playwright, CDP
 * and remote WebDriver endpoints are optional adapters.
 */

import type {
  Tool,
  ToolResult,
  ToolExecutionContext,
  ToolPreview,
} from "./types";
import type { ToolParameterSchema } from "../providers/types";
import { validatePublicHttpUrl } from "../utils/url-guard";
import { createBrowserAdapter, type BrowserAdapter } from "./browser-adapters";

/**
 * Adapter instance shared across tool invocations within a session.
 * Rebuilt after `close`; created lazily so startup never loads an adapter.
 */
let browserAdapter: BrowserAdapter | null = null;

function currentAdapter(): BrowserAdapter {
  if (!browserAdapter) {
    browserAdapter = createBrowserAdapter();
  }
  return browserAdapter;
}

/** Close the current browser session and clean up resources. */
export async function closeBrowser(): Promise<void> {
  const adapter = browserAdapter;
  browserAdapter = null;
  if (!adapter) return;
  try {
    await adapter.close();
  } catch {
    // Ignore errors during cleanup.
  }
}

function failure(message: string): ToolResult {
  return { success: false, output: message };
}

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

    return { type: "command", content };
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      if (context.abortSignal.aborted) {
        return failure("Operation cancelled by user.");
      }

      const action = String(args.action);
      const timeout = (args.timeout as number) || 30_000;
      const operation = {
        timeoutMs: timeout,
        signal: context.abortSignal,
      };

      switch (action) {
        case "goto": {
          const url = String(args.url || "");
          const verdict = validatePublicHttpUrl(url);
          if (!verdict.ok) {
            return failure(`Invalid URL: ${url}. ${verdict.reason}`);
          }

          context.reportProgress(`Navigating to ${url}...`);
          try {
            await currentAdapter().navigate(url, operation);
            return {
              success: true,
              output: `Successfully navigated to ${url}`,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return failure(
              `Failed to navigate: browser is unavailable: ${message}`,
            );
          }
        }

        case "screenshot": {
          context.reportProgress("Taking screenshot...");
          try {
            const base64 = await currentAdapter().screenshot(operation);
            const dataUrl = `data:image/png;base64,${base64}`;
            const bytes = Buffer.from(base64, "base64").length;
            return {
              success: true,
              output: `Screenshot captured (${bytes} bytes). Image: ${dataUrl.substring(0, 50)}...`,
              metadata: { screenshot: dataUrl },
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return failure(
              `Failed to capture screenshot: browser is unavailable: ${message}`,
            );
          }
        }

        case "click": {
          const selector = String(args.selector || "");
          if (!selector) {
            return failure("Selector is required for 'click' action.");
          }

          context.reportProgress(`Clicking on ${selector}...`);
          try {
            await currentAdapter().click(selector, operation);
            return {
              success: true,
              output: `Successfully clicked on element: ${selector}`,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return failure(
              `Failed to click element "${selector}": browser is unavailable: ${message}`,
            );
          }
        }

        case "type": {
          const selector = String(args.selector || "");
          const text = String(args.text || "");
          if (!selector) {
            return failure("Selector is required for 'type' action.");
          }

          context.reportProgress(`Typing in ${selector}...`);
          try {
            await currentAdapter().type(selector, text, operation);
            return {
              success: true,
              output: `Successfully typed text in element: ${selector}`,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return failure(
              `Failed to type in element "${selector}": browser is unavailable: ${message}`,
            );
          }
        }

        case "close": {
          context.reportProgress("Closing browser...");
          await closeBrowser();
          return { success: true, output: "Browser closed successfully." };
        }

        default:
          return failure(
            `Unknown action: ${action}. Supported actions: goto, screenshot, click, type, close.`,
          );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failure(`Unexpected error in browser tool: ${message}`);
    }
  },
};
