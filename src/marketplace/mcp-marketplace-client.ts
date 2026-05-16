import type { MCPServerConfig } from "../mcp/mcp-client";

export interface McpMarketplaceEntry {
  name: string;
  description: string;
  author: string;
  url: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  baseUrl?: string;
  tags: string[];
}

const DEFAULT_MCP_MANIFEST_URL =
  "https://raw.githubusercontent.com/hellodk/champ/master/marketplace/mcp-manifest.json";

export class McpMarketplaceClient {
  constructor(
    private readonly manifestUrl: string = DEFAULT_MCP_MANIFEST_URL,
  ) {}

  static isValidEntry(item: unknown): item is McpMarketplaceEntry {
    return isValidManifestEntry(item);
  }

  async fetchManifest(): Promise<McpMarketplaceEntry[]> {
    try {
      const res = await fetch(this.manifestUrl, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return [];
      return (data as unknown[]).filter(isValidManifestEntry);
    } catch {
      return [];
    }
  }
}

/**
 * Runtime guard: validates that a manifest entry has the required shape
 * and correct field types before it is used. Rejects entries with missing
 * required fields to prevent cryptic failures downstream.
 */
function isValidManifestEntry(item: unknown): item is McpMarketplaceEntry {
  if (typeof item !== "object" || item === null) return false;
  const e = item as Record<string, unknown>;
  if (typeof e.name !== "string" || !e.name.trim()) return false;
  if (typeof e.description !== "string") return false;
  if (typeof e.author !== "string") return false;
  if (typeof e.url !== "string") return false;
  if (e.transport !== "stdio" && e.transport !== "sse") return false;
  if (!Array.isArray(e.tags)) return false;
  if (e.transport === "stdio" && typeof e.command !== "string") return false;
  if (e.transport === "sse" && typeof e.baseUrl !== "string") return false;
  return true;
}

export function buildMcpServerConfig(
  entry: McpMarketplaceEntry,
  resolvedEnv: Record<string, string>,
): MCPServerConfig {
  if (entry.transport === "stdio") {
    if (!entry.command) {
      throw new Error(
        `MCP server "${entry.name}" has transport "stdio" but no command — cannot start`,
      );
    }
    return {
      name: entry.name,
      transport: "stdio",
      command: entry.command,
      args: entry.args ?? [],
      ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
    };
  } else {
    if (!entry.baseUrl) {
      throw new Error(
        `MCP server "${entry.name}" has transport "sse" but no baseUrl — cannot connect`,
      );
    }
    return {
      name: entry.name,
      transport: "sse",
      url: entry.baseUrl,
      ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
    };
  }
}

export function upsertMcpServer(
  servers: MCPServerConfig[],
  newServer: MCPServerConfig,
): { servers: MCPServerConfig[]; wasUpdate: boolean } {
  const idx = servers.findIndex((s) => s.name === newServer.name);
  if (idx !== -1) {
    servers[idx] = newServer;
    return { servers, wasUpdate: true };
  }
  servers.push(newServer);
  return { servers, wasUpdate: false };
}

export async function isOllamaReachable(
  baseUrl: string = "http://localhost:11434",
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function isEmbeddingModelAvailable(
  modelName: string,
  baseUrl: string = "http://localhost:11434",
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    const models = body.models ?? [];
    return models.some(
      (m) => m.name === modelName || m.name.startsWith(`${modelName}:`),
    );
  } catch {
    return false;
  }
}
