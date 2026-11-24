/**
 * fetch_url: fetch a public URL and return guarded, citable text.
 *
 * SSRF protection stays in the shared url-guard. Remote content is passed
 * through PromptGuard before it can enter model context, and the page gets a
 * stable [S#] source id shared with web_search citations.
 */
import { PromptGuard } from "../safety/prompt-guard";
import {
  formatIstTimestamp,
  WebSourceRegistry,
  type WebSource,
} from "./web-sources";
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

export interface FetchUrlToolOptions {
  guard?: Pick<PromptGuard, "check">;
  sources?: WebSourceRegistry;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createFetchUrlTool(options: FetchUrlToolOptions = {}): Tool {
  return {
    name: "fetch_url",
    description:
      "Fetch the content of a public HTTP(S) URL and return its text with a citable [S#] source id. HTML is stripped and remote content is screened for prompt injection. Limited to 20KB.",
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
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      const url = args.url as string;

      // Shared SSRF guard: scheme, loopback, mDNS and private-range rules.
      const verdict = validatePublicHttpUrl(url);
      if (!verdict.ok) {
        return { success: false, output: `Error: ${verdict.reason}` };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const onParentAbort = (): void => controller.abort();
      if (context.abortSignal?.aborted) controller.abort();
      context.abortSignal?.addEventListener("abort", onParentAbort, {
        once: true,
      });
      const doFetch = options.fetchImpl ?? fetch;

      try {
        const response = await doFetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Champ-AI-Agent/1.0 (documentation-fetcher)",
          },
        });

        if (!response.ok) {
          return {
            success: false,
            output: `Error: HTTP ${response.status} ${response.statusText} fetching ${url}`,
          };
        }

        const contentType = response.headers.get("content-type") ?? "";
        const buffer = await response.arrayBuffer();
        const raw = new TextDecoder().decode(buffer);
        const text = contentType.includes("text/html") ? stripHtml(raw) : raw;
        const truncated = text.length > MAX_BYTES;
        const body = truncated
          ? text.slice(0, MAX_BYTES) + "\n\n[... truncated at 20KB ...]"
          : text;

        const now = options.now ?? Date.now;
        const registry = options.sources ?? new WebSourceRegistry();
        const source: WebSource = registry.register({
          title: url,
          url,
          snippet: body.slice(0, 240),
          retrievedAt: new Date(now()).toISOString(),
        });

        // Never hand untrusted page content to the model when it contains an
        // injection attempt. The source id is still recorded for the user.
        const guard = options.guard ?? new PromptGuard();
        const check = guard.check(body);
        if (!check.safe) {
          return {
            success: false,
            output: [
              `Error: content from ${url} was blocked by PromptGuard (${check.category ?? "prompt_injection"}); nothing was added to context.`,
              `[Source ${source.id}]`,
              ...registry.formatCitations([source]).split("\n"),
            ].join("\n"),
          };
        }

        const lines = [
          `[${source.id}] URL: ${url}`,
          `Status: ${response.status}`,
          `Content-Type: ${contentType}`,
          `Retrieved: ${formatIstTimestamp(source.retrievedAt)}`,
        ];
        if (truncated) lines.push("Note: Content truncated at 20KB");
        lines.push("", body, registry.formatCitations([source]));

        return { success: true, output: lines.join("\n") };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("abort") || msg.includes("AbortError")) {
          return {
            success: false,
            output: `Error: Request timed out or was cancelled fetching ${url}`,
          };
        }
        return { success: false, output: `Error fetching ${url}: ${msg}` };
      } finally {
        clearTimeout(timer);
        context.abortSignal?.removeEventListener("abort", onParentAbort);
      }
    },
  };
}

/** Default instance used by the extension until a shared registry is wired. */
export const fetchUrlTool: Tool = createFetchUrlTool();
