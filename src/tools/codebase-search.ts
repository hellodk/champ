import * as path from "path";
import { spawnSync } from "child_process";
import type { IndexingService } from "../indexing/indexing-service";
import type { Tool } from "./types";

export function createCodebaseSearchTool(
  getIndexingService: () => IndexingService | null,
): Tool {
  return {
    name: "codebase_search",
    description:
      "Search the codebase by meaning, not just keywords. Uses semantic vector search when an embedding model is available; falls back to fast keyword search (ripgrep) otherwise. Use this to find code by concept, e.g. 'authentication logic', 'rate limiting', 'database connection handling'.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language description of what you are looking for.",
        },
        topK: {
          type: "number",
          description: "Maximum number of results to return (default 8).",
        },
      },
      required: ["query"],
    },
    requiresApproval: false,
    async execute(args, context) {
      const query = String(args.query ?? "").trim();
      if (!query) return { output: "query is required", success: false };

      const topK = typeof args.topK === "number" ? Math.min(args.topK, 20) : 8;
      const indexingService = getIndexingService();

      // ── Semantic path ───────────────────────────────────────────────
      if (indexingService?.isReady()) {
        const results = await indexingService.search(query, topK);
        if (results.length === 0) {
          return {
            output:
              "No semantic matches found. Try a different query or use grep_search for exact keywords.",
            success: true,
          };
        }

        const lines: string[] = [`Semantic search results for: "${query}"\n`];
        for (const r of results) {
          const rel = path.relative(context.workspaceRoot, r.filePath);
          const loc = r.symbolName
            ? `${rel}:${r.startLine} (${r.chunkType} ${r.symbolName})`
            : `${rel}:${r.startLine}-${r.endLine}`;
          lines.push(`### ${loc}`);
          lines.push("```");
          lines.push(
            r.chunkText.slice(0, 400) +
              (r.chunkText.length > 400 ? "\n… (truncated)" : ""),
          );
          lines.push("```");
          lines.push("");
        }
        return { output: lines.join("\n"), success: true };
      }

      // ── Keyword fallback ────────────────────────────────────────────
      // No embedding index available — use ripgrep keyword search.
      const rgArgs = [
        "--line-number",
        "--with-filename",
        "--max-count=5",
        "--max-filesize=500K",
        "--type-not=lock",
        "-i", // case-insensitive
        "--",
        query,
        context.workspaceRoot,
      ];

      const rg = spawnSync("rg", rgArgs, {
        encoding: "utf8",
        maxBuffer: 512 * 1024,
        timeout: 10_000,
      });

      const raw = (rg.stdout ?? "").trim();
      if (!raw) {
        return {
          output: `No matches found for "${query}". (Tip: pull an embedding model like nomic-embed-text for semantic search.)`,
          success: true,
        };
      }

      const truncated =
        raw.length > 8000 ? raw.slice(0, 8000) + "\n…(truncated)" : raw;
      return {
        output: `Keyword search results for "${query}" (no embedding index — pull nomic-embed-text for semantic search):\n\n${truncated}`,
        success: true,
      };
    },
  };
}
