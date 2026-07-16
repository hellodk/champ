/**
 * web_search tool: Search the internet using the Brave Search API.
 *
 * Enables the agent to query the web for information to supplement code
 * context and provide current data. Requires a Brave Search API key stored
 * in VS Code's SecretStorage.
 */
import type { Tool, ToolResult, ToolExecutionContext } from "./types";

const BRAVE_SEARCH_API_ENDPOINT =
  "https://api.search.brave.com/res/v1/web/search";
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const TIMEOUT_MS = 15_000;

/**
 * Search result from the Brave Search API.
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

/**
 * Input parameters for the web search tool.
 */
export interface WebSearchInput {
  query: string;
  count?: number; // default: 5, max: 10
  offset?: number; // for pagination
  freshness?: "pd" | "pw" | "pm" | "py"; // past day/week/month/year
}

/**
 * Brave Search API response type.
 */
interface BraveSearchResponse {
  web?: Array<{
    title: string;
    url: string;
    description: string;
    thumbnail?: string;
  }>;
  error?: string;
}

/**
 * Creates a web search tool with access to the VS Code SecretStorage.
 *
 * The tool uses the Brave Search API to query the internet. The API key
 * is read from SecretStorage (stored via the 'Champ: Set Brave API Key' command).
 */
export function createWebSearchTool(secretStorage: {
  get: (key: string) => PromiseLike<string | undefined>;
}): Tool {
  return {
    name: "web_search",
    description:
      "Search the internet for information using the Brave Search API. Returns ranked search results with titles, URLs, and snippets. Requires a Brave Search API key configured via 'Champ: Set Brave API Key' command.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search query to execute (e.g., 'TypeScript generics')",
        },
        count: {
          type: "number",
          description: "Number of results to return (default: 5, max: 10)",
        },
        offset: {
          type: "number",
          description: "Pagination offset for result sets (default: 0)",
        },
        freshness: {
          type: "string",
          enum: ["pd", "pw", "pm", "py"],
          description:
            "Filter by freshness: pd=past day, pw=past week, pm=past month, py=past year",
        },
      },
      required: ["query"],
    },
    requiresApproval: false,

    async execute(
      args: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolResult> {
      const query = args.query as string;
      let count = (args.count as number) ?? DEFAULT_RESULTS;
      const offset = (args.offset as number) ?? 0;
      const freshness = args.freshness as string | undefined;

      // Validate query
      if (!query || typeof query !== "string" || query.trim().length === 0) {
        return {
          success: false,
          output:
            "Error: query parameter is required and must be a non-empty string",
        };
      }

      // Enforce max results limit
      if (count < 1 || count > MAX_RESULTS) {
        count = Math.min(Math.max(count, 1), MAX_RESULTS);
      }

      // Get API key from SecretStorage
      const apiKey = await secretStorage.get("brave-search-api-key");
      if (!apiKey) {
        return {
          success: false,
          output:
            "Error: Brave API key not configured. " +
            "Please run the 'Champ: Set Brave API Key' command to configure it.",
        };
      }

      try {
        // Build API URL with parameters
        const url = new URL(BRAVE_SEARCH_API_ENDPOINT);
        url.searchParams.append("q", query);
        url.searchParams.append("count", String(count));
        if (offset > 0) {
          url.searchParams.append("offset", String(offset));
        }
        if (freshness) {
          url.searchParams.append("freshness", freshness);
        }

        // Make the API request
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(url.toString(), {
          signal: controller.signal,
          headers: {
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": apiKey,
          },
        });
        clearTimeout(timer);

        // Handle HTTP errors
        if (!response.ok) {
          return {
            success: false,
            output: `Error: HTTP ${response.status} ${response.statusText} from Brave Search API`,
          };
        }

        // Parse response
        let data: BraveSearchResponse;
        try {
          data = (await response.json()) as BraveSearchResponse;
        } catch (err) {
          return {
            success: false,
            output: `Error: Failed to parse Brave Search API response: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // Check for API errors
        if (data.error) {
          return {
            success: false,
            output: `Error: Brave Search API returned error: ${data.error}`,
          };
        }

        // Extract and format results
        const results = data.web ?? [];
        if (results.length === 0) {
          return {
            success: true,
            output: `No results found for: "${query}"`,
          };
        }

        // Format results for output
        const formattedResults = results
          .slice(0, count)
          .map((result, index) => {
            const lines = [
              `${index + 1}. ${result.title}`,
              `   URL: ${result.url}`,
              `   ${result.description}`,
            ];
            return lines.join("\n");
          });

        const output = [
          `Search results for: "${query}"`,
          `Found ${results.length} result(s)${offset > 0 ? ` (starting from offset ${offset})` : ""}`,
          "",
          formattedResults.join("\n\n"),
        ].join("\n");

        return { success: true, output };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("abort") || msg.includes("AbortError")) {
          return {
            success: false,
            output: `Error: Search request timed out after ${TIMEOUT_MS / 1000}s`,
          };
        }
        return {
          success: false,
          output: `Error: Failed to search the web: ${msg}`,
        };
      }
    },
  };
}

/**
 * Create a default web search tool (exported for convenient registration).
 * Note: In production, this requires injecting the actual VS Code SecretStorage.
 */
export const createDefaultWebSearchTool = (secretStorage: {
  get: (key: string) => PromiseLike<string | undefined>;
}): Tool => createWebSearchTool(secretStorage);
