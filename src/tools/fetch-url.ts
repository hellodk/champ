/**
 * fetch_url tool: fetches the content of a URL and returns its text.
 *
 * Useful for reading documentation, API references, README files, or any
 * publicly accessible web resource. HTML responses are stripped of tags;
 * Markdown/JSON/plain-text is returned as-is. Output is capped at 20 KB.
 */
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import { validatePublicHttpUrl } from "../utils/url-guard";

const MAX_BYTES = 20_000;
const TIMEOUT_MS = 15_000;

/** Strip script/style blocks then all remaining HTML tags. */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch the content of a URL and return its text. Use for reading documentation, API references, README files, or any web resource. Returns plain text with HTML stripped. Limited to 20KB.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (must be http:// or https://)",
      },
    },
    required: ["url"],
  },
  requiresApproval: false,

  async execute(
    args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const url = args.url as string;

    // Shared SSRF guard: scheme, loopback, mDNS and private-range rules.
    const verdict = validatePublicHttpUrl(url);
    if (!verdict.ok) {
      return { success: false, output: `Error: ${verdict.reason}` };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Champ-AI-Agent/1.0 (documentation-fetcher)",
        },
      });
      clearTimeout(timer);

      if (!response.ok) {
        return {
          success: false,
          output: `Error: HTTP ${response.status} ${response.statusText} fetching ${url}`,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const buffer = await response.arrayBuffer();
      const raw = new TextDecoder().decode(buffer);

      let text: string;
      if (contentType.includes("text/html")) {
        text = stripHtml(raw);
      } else {
        text = raw; // markdown, plain text, JSON, etc.
      }

      const truncated = text.length > MAX_BYTES;
      if (truncated) {
        text = text.slice(0, MAX_BYTES) + "\n\n[... truncated at 20KB ...]";
      }

      const lines = [
        `URL: ${url}`,
        `Status: ${response.status}`,
        `Content-Type: ${contentType}`,
      ];
      if (truncated) {
        lines.push(`Note: Content truncated at 20KB`);
      }
      lines.push("", text);

      return { success: true, output: lines.join("\n") };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("AbortError")) {
        return {
          success: false,
          output: `Error: Request timed out after ${TIMEOUT_MS / 1000}s`,
        };
      }
      return { success: false, output: `Error fetching ${url}: ${msg}` };
    }
  },
};
