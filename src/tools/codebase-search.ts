/**
 * codebase_search: fused semantic + keyword + symbol retrieval.
 *
 * Previously this tool chose either vector search or ripgrep, never both.
 * Hybrid retrieval runs all available channels and merges overlapping hits so
 * a natural-language query and an exact symbol name can reinforce each other.
 */
import * as path from "path";
import {
  hybridRetrieve,
  type SemanticIndexGetter,
  type SemanticIndex,
} from "../retrieval/hybrid-retrieval";
import type { Tool } from "./types";

export type {
  SemanticIndex,
  SemanticIndexGetter,
  SemanticIndexGetter as IndexingServiceGetter,
};

export function createCodebaseSearchTool(
  getIndexingService: SemanticIndexGetter,
): Tool {
  return {
    name: "codebase_search",
    description:
      "Search the codebase by meaning and by exact terms. Combines semantic vector search (when an embedding model is available), ripgrep keyword hits and symbol metadata, then de-duplicates overlapping results. Use queries like 'authentication logic' or an exact symbol such as 'verifyToken'.",
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
      const result = await hybridRetrieve(
        query,
        context.workspaceRoot,
        getIndexingService,
        {
          topK,
          semanticTopK: topK,
        },
      );

      const channels = [
        result.semanticUsed ? "vector" : null,
        result.keywordUsed ? "keyword" : null,
        result.hits.some((hit) => hit.sources.includes("symbol"))
          ? "symbols"
          : null,
      ].filter(Boolean);
      const channelText = channels.length ? channels.join(" + ") : "no index";

      const lines: string[] = [
        `Semantic search results for: "${query}" (hybrid: ${channelText})\n`,
      ];
      if (result.hits.length === 0) {
        lines.push(
          "No matches found. Try a different query or pull an embedding model for semantic search.",
        );
        for (const warning of result.warnings) lines.push(`Note: ${warning}`);
        return { output: lines.join("\n"), success: true };
      }

      result.hits.forEach((hit, index) => {
        const rel = path.relative(context.workspaceRoot, hit.filePath);
        const loc = hit.symbolName
          ? `${rel}:${hit.startLine}-${hit.endLine} (${hit.chunkType ?? "symbol"} ${hit.symbolName})`
          : `${rel}:${hit.startLine}${hit.endLine !== hit.startLine ? `-${hit.endLine}` : ""}`;
        lines.push(
          `### [${index + 1}] ${loc} — sources: ${hit.sources.join(", ")}; score: ${hit.score.toFixed(2)}`,
        );
        lines.push("```");
        lines.push(
          hit.snippet.slice(0, 400) +
            (hit.snippet.length > 400 ? "\n… (truncated)" : ""),
        );
        lines.push("```");
        lines.push("");
      });
      for (const warning of result.warnings) lines.push(`Note: ${warning}`);

      return { output: lines.join("\n"), success: true };
    },
  };
}
