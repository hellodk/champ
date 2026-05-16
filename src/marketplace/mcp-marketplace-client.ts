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

  async fetchManifest(): Promise<McpMarketplaceEntry[]> {
    try {
      const res = await fetch(this.manifestUrl);
      if (!res.ok) return [];
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return [];
      return data as McpMarketplaceEntry[];
    } catch {
      return [];
    }
  }
}

export function buildMcpServerConfig(
  entry: McpMarketplaceEntry,
  resolvedEnv: Record<string, string>,
): MCPServerConfig {
  const config: MCPServerConfig = {
    name: entry.name,
    transport: entry.transport,
    ...(entry.transport === "stdio"
      ? { command: entry.command!, args: entry.args ?? [] }
      : { url: entry.baseUrl! }),
    ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
  };
  return config;
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
