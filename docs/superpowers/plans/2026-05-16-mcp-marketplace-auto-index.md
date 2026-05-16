# MCP Marketplace + Auto Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click MCP server marketplace (`champ.browseMcpServers`) and trigger codebase indexing automatically when a workspace opens with an embedding model available.

**Architecture:** `McpMarketplaceClient` mirrors `TeamMarketplaceClient` — fetches a JSON manifest, presents a QuickPick, then writes the server config to either VS Code `settings.json` or `.champ/config.yaml` based on user choice. Auto-indexing triggers in the extension `activate()` function after checking provider reachability, rather than waiting for SmartRouter discovery.

**Tech Stack:** TypeScript, VS Code Extension API (`workspace.getConfiguration`, `SecretStorage`), native `fetch`, `js-yaml`, existing `IndexingService`.

---

## Task 1: Create `src/marketplace/mcp-marketplace-client.ts`

- [ ] Create `src/marketplace/mcp-marketplace-client.ts` with the following complete implementation:

```typescript
// src/marketplace/mcp-marketplace-client.ts

/**
 * McpMarketplaceClient: fetches the MCP server manifest and provides
 * helpers for building MCPServerConfig objects and checking embedding
 * provider reachability for auto-indexing.
 */
import type { MCPServerConfig } from "../mcp/mcp-client";

export interface McpMarketplaceEntry {
  /** Unique server name. Must be a valid identifier (no spaces). */
  name: string;
  /** One-sentence description shown in the QuickPick. */
  description: string;
  /** Author or organization name. */
  author: string;
  /**
   * URL to the server's install instructions or documentation.
   * Not the binary — a documentation/config manifest URL.
   */
  url: string;
  /** Transport protocol the server uses. */
  transport: "stdio" | "sse";
  /**
   * Shell command to launch the server process.
   * Required when transport === "stdio".
   */
  command?: string;
  /** Arguments passed to the command. May include $VAR placeholders. */
  args?: string[];
  /**
   * Environment variables the server requires.
   * Keys are variable names; values are human-readable descriptions.
   * Actual values are NOT stored here — the user provides them.
   */
  env?: Record<string, string>;
  /**
   * Base URL for SSE transport servers.
   * Required when transport === "sse".
   */
  baseUrl?: string;
  /** Categorization tags for future filtering. */
  tags: string[];
}

const DEFAULT_MCP_MANIFEST_URL =
  "https://raw.githubusercontent.com/hellodk/champ/master/marketplace/mcp-manifest.json";

export class McpMarketplaceClient {
  constructor(
    private readonly manifestUrl: string = DEFAULT_MCP_MANIFEST_URL,
  ) {}

  /**
   * Fetch the MCP server manifest from the remote URL.
   * Returns [] on network error, non-2xx response, or JSON parse failure.
   * Never throws.
   */
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

/**
 * Build an MCPServerConfig from a marketplace entry and resolved env values.
 * resolvedEnv maps env var names to user-provided values.
 */
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

/**
 * Insert or replace an MCPServerConfig in an existing array.
 * If an entry with the same name exists, it is replaced in place.
 * Otherwise the new entry is appended.
 * Returns the updated array (mutated in place for efficiency).
 */
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

/**
 * Check if Ollama is reachable at the given base URL.
 * Sends GET {baseUrl}/api/tags with a 3-second timeout.
 * Returns true only if the response status is 200.
 * Never throws.
 */
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

/**
 * Check if the specified embedding model is available in Ollama's model list.
 * Calls GET {baseUrl}/api/tags and inspects the models array.
 * Returns false if Ollama is unreachable or the model is absent.
 * Never throws.
 */
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
```

---

## Task 2: Create `marketplace/mcp-manifest.json`

- [ ] Create `marketplace/mcp-manifest.json` in the repository root with these 4 entries:

```json
[
  {
    "name": "sqlite",
    "description": "Read and query local SQLite databases via natural language",
    "author": "anthropics",
    "url": "https://raw.githubusercontent.com/anthropics/mcp-servers/main/servers/sqlite/README.md",
    "transport": "stdio",
    "command": "uvx",
    "args": ["mcp-server-sqlite", "--db-path", "$SQLITE_DB_PATH"],
    "env": {
      "SQLITE_DB_PATH": "Absolute path to the SQLite database file to expose"
    },
    "tags": ["database", "local", "sql"]
  },
  {
    "name": "filesystem",
    "description": "Expose a local directory tree for reading and writing files",
    "author": "anthropics",
    "url": "https://raw.githubusercontent.com/anthropics/mcp-servers/main/servers/filesystem/README.md",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@anthropic-ai/mcp-server-filesystem", "$FS_ROOT"],
    "env": {
      "FS_ROOT": "Absolute path to the root directory to expose"
    },
    "tags": ["filesystem", "local"]
  },
  {
    "name": "postgres",
    "description": "Execute read-only SQL queries against a PostgreSQL database",
    "author": "anthropics",
    "url": "https://raw.githubusercontent.com/anthropics/mcp-servers/main/servers/postgres/README.md",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@anthropic-ai/mcp-server-postgres", "$POSTGRES_CONNECTION_STRING"],
    "env": {
      "POSTGRES_CONNECTION_STRING": "PostgreSQL connection URI, e.g. postgresql://user:pass@localhost/db"
    },
    "tags": ["database", "postgres", "sql"]
  },
  {
    "name": "brave-search",
    "description": "Search the web using the Brave Search API",
    "author": "anthropics",
    "url": "https://raw.githubusercontent.com/anthropics/mcp-servers/main/servers/brave-search/README.md",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@anthropic-ai/mcp-server-brave-search"],
    "env": {
      "BRAVE_API_KEY": "Your Brave Search API key from https://api.search.brave.com/"
    },
    "tags": ["search", "web", "brave"]
  }
]
```

---

## Task 3: Unit tests for `McpMarketplaceClient`

- [ ] Create `src/marketplace/__tests__/mcp-marketplace-client.test.ts`:

```typescript
// src/marketplace/__tests__/mcp-marketplace-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  McpMarketplaceClient,
  buildMcpServerConfig,
  upsertMcpServer,
  isOllamaReachable,
  isEmbeddingModelAvailable,
  type McpMarketplaceEntry,
} from "../mcp-marketplace-client";
import type { MCPServerConfig } from "../../mcp/mcp-client";

const SAMPLE_ENTRY: McpMarketplaceEntry = {
  name: "sqlite",
  description: "Query SQLite databases",
  author: "anthropics",
  url: "https://example.com/sqlite.md",
  transport: "stdio",
  command: "uvx",
  args: ["mcp-server-sqlite", "--db-path", "$SQLITE_DB_PATH"],
  env: { SQLITE_DB_PATH: "Path to SQLite file" },
  tags: ["database", "sql"],
};

const SAMPLE_SSE_ENTRY: McpMarketplaceEntry = {
  name: "my-sse-server",
  description: "SSE server",
  author: "test",
  url: "https://example.com/sse.md",
  transport: "sse",
  baseUrl: "http://localhost:3100",
  tags: ["sse"],
};

describe("McpMarketplaceClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchManifest() returns parsed array on 200 with valid JSON", async () => {
    const entries = [SAMPLE_ENTRY];
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => entries,
    } as Response);

    const client = new McpMarketplaceClient("https://example.com/manifest.json");
    const result = await client.fetchManifest();
    expect(result).toEqual(entries);
  });

  it("fetchManifest() returns [] on non-200 response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const client = new McpMarketplaceClient("https://example.com/manifest.json");
    const result = await client.fetchManifest();
    expect(result).toEqual([]);
  });

  it("fetchManifest() returns [] when fetch throws (network error)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network failure"));

    const client = new McpMarketplaceClient("https://example.com/manifest.json");
    const result = await client.fetchManifest();
    expect(result).toEqual([]);
  });

  it("fetchManifest() returns [] when response JSON is not an array", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: "unexpected object" }),
    } as Response);

    const client = new McpMarketplaceClient("https://example.com/manifest.json");
    const result = await client.fetchManifest();
    expect(result).toEqual([]);
  });

  it("fetchManifest() uses custom manifest URL provided to constructor", async () => {
    const customUrl = "https://custom.example.com/custom-manifest.json";
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    const client = new McpMarketplaceClient(customUrl);
    await client.fetchManifest();
    expect(fetch).toHaveBeenCalledWith(customUrl);
  });
});

describe("buildMcpServerConfig", () => {
  it("builds correct MCPServerConfig for stdio entry with env", () => {
    const resolvedEnv = { SQLITE_DB_PATH: "/home/user/data.db" };
    const config = buildMcpServerConfig(SAMPLE_ENTRY, resolvedEnv);
    expect(config).toEqual({
      name: "sqlite",
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-sqlite", "--db-path", "$SQLITE_DB_PATH"],
      env: { SQLITE_DB_PATH: "/home/user/data.db" },
    });
  });

  it("builds correct MCPServerConfig for stdio entry without env", () => {
    const entryNoEnv: McpMarketplaceEntry = { ...SAMPLE_ENTRY, env: undefined };
    const config = buildMcpServerConfig(entryNoEnv, {});
    expect(config).toEqual({
      name: "sqlite",
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-sqlite", "--db-path", "$SQLITE_DB_PATH"],
    });
    expect(config.env).toBeUndefined();
  });

  it("builds correct MCPServerConfig for sse entry", () => {
    const config = buildMcpServerConfig(SAMPLE_SSE_ENTRY, {});
    expect(config).toEqual({
      name: "my-sse-server",
      transport: "sse",
      url: "http://localhost:3100",
    });
  });
});

describe("upsertMcpServer", () => {
  it("appends new server when name not present in array", () => {
    const existing: MCPServerConfig[] = [
      { name: "other", command: "other-cmd" },
    ];
    const newServer: MCPServerConfig = {
      name: "sqlite",
      transport: "stdio",
      command: "uvx",
    };
    const { servers, wasUpdate } = upsertMcpServer(existing, newServer);
    expect(servers).toHaveLength(2);
    expect(servers[1]).toEqual(newServer);
    expect(wasUpdate).toBe(false);
  });

  it("replaces existing server when name already present (duplicate-name update)", () => {
    const existing: MCPServerConfig[] = [
      { name: "sqlite", command: "old-cmd" },
      { name: "other", command: "other-cmd" },
    ];
    const updated: MCPServerConfig = {
      name: "sqlite",
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-sqlite", "--db-path", "/new/path.db"],
    };
    const { servers, wasUpdate } = upsertMcpServer(existing, updated);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toEqual(updated);
    expect(wasUpdate).toBe(true);
  });
});

describe("isOllamaReachable", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when fetch resolves with status 200", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
    const result = await isOllamaReachable("http://localhost:11434");
    expect(result).toBe(true);
  });

  it("returns false when fetch throws (Ollama not running)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await isOllamaReachable("http://localhost:11434");
    expect(result).toBe(false);
  });

  it("returns false on non-200 response (e.g., 500)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);
    const result = await isOllamaReachable("http://localhost:11434");
    expect(result).toBe(false);
  });
});

describe("isEmbeddingModelAvailable", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when model name is absent from Ollama /api/tags response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: "llama3:latest" }, { name: "mistral:7b" }],
      }),
    } as Response);
    const result = await isEmbeddingModelAvailable(
      "nomic-embed-text",
      "http://localhost:11434",
    );
    expect(result).toBe(false);
  });

  it("returns true when model name is present in Ollama /api/tags response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: "llama3:latest" },
          { name: "nomic-embed-text:latest" },
        ],
      }),
    } as Response);
    // Should match prefix: "nomic-embed-text" matches "nomic-embed-text:latest"
    const result = await isEmbeddingModelAvailable(
      "nomic-embed-text",
      "http://localhost:11434",
    );
    expect(result).toBe(true);
  });

  it("returns false when Ollama is not reachable", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));
    const result = await isEmbeddingModelAvailable(
      "nomic-embed-text",
      "http://localhost:11434",
    );
    expect(result).toBe(false);
  });
});
```

- [ ] Run tests: `npx vitest run src/marketplace/__tests__/mcp-marketplace-client.test.ts`
  - Expected: all 12 tests pass.

---

## Task 4: Create `src/indexing/embedding-probe.ts`

- [ ] Create `src/indexing/embedding-probe.ts` — extracts the reachability-check logic for testability:

```typescript
// src/indexing/embedding-probe.ts
/**
 * Lightweight probes for embedding provider reachability.
 * Used by auto-indexing trigger in extension activate().
 * Extracted here for testability — no VS Code API imports.
 */

import {
  isOllamaReachable,
  isEmbeddingModelAvailable,
} from "../marketplace/mcp-marketplace-client";
import type { ChampConfig } from "../config/config-loader";

export type EmbeddingProbeResult =
  | { available: true; provider: "ollama" | "openai" }
  | { available: false; reason: "ollama-unreachable" | "model-not-found" | "openai-key-absent" };

/**
 * Check whether an embedding provider is ready for use.
 *
 * For Ollama: pings /api/tags and verifies the configured model is present.
 * For OpenAI: checks if the API key secret is non-empty (no HTTP ping).
 *
 * @param config  The loaded ChampConfig (indexing section is examined).
 * @param getSecret  Async function that returns a secret by name. Pass
 *                   `(name) => context.secrets.get(name)` from extension.ts.
 */
export async function probeEmbeddingProvider(
  config: ChampConfig,
  getSecret: (name: string) => Promise<string | undefined>,
): Promise<EmbeddingProbeResult> {
  const indexingConfig = config.indexing;

  // If provider is explicitly set to openai, check for API key only.
  if (indexingConfig?.provider === "openai") {
    const key = await getSecret("champ.openaiApiKey");
    if (key && key.length > 0) {
      return { available: true, provider: "openai" };
    }
    return { available: false, reason: "openai-key-absent" };
  }

  // Default: Ollama reachability + model check.
  const baseUrl = indexingConfig?.baseUrl ?? "http://localhost:11434";
  const reachable = await isOllamaReachable(baseUrl);
  if (!reachable) {
    return { available: false, reason: "ollama-unreachable" };
  }

  const modelName = indexingConfig?.embeddingModel;
  if (modelName) {
    const modelAvailable = await isEmbeddingModelAvailable(modelName, baseUrl);
    if (!modelAvailable) {
      return { available: false, reason: "model-not-found" };
    }
  }

  return { available: true, provider: "ollama" };
}
```

- [ ] Create test `src/indexing/__tests__/embedding-probe.test.ts`:

```typescript
// src/indexing/__tests__/embedding-probe.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { probeEmbeddingProvider } from "../embedding-probe";
import type { ChampConfig } from "../../config/config-loader";

describe("probeEmbeddingProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns available=true for Ollama when reachable and model present", async () => {
    vi.mocked(fetch)
      // First call: isOllamaReachable
      .mockResolvedValueOnce({ ok: true } as Response)
      // Second call: isEmbeddingModelAvailable
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: "nomic-embed-text:latest" }],
        }),
      } as Response);

    const config: ChampConfig = {
      indexing: { enabled: true, embeddingModel: "nomic-embed-text" },
    };
    const result = await probeEmbeddingProvider(config, async () => undefined);
    expect(result).toEqual({ available: true, provider: "ollama" });
  });

  it("returns reason=ollama-unreachable when Ollama fetch fails", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const config: ChampConfig = {
      indexing: { enabled: true, embeddingModel: "nomic-embed-text" },
    };
    const result = await probeEmbeddingProvider(config, async () => undefined);
    expect(result).toEqual({ available: false, reason: "ollama-unreachable" });
  });

  it("returns reason=model-not-found when Ollama reachable but model absent", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: "llama3:latest" }] }),
      } as Response);

    const config: ChampConfig = {
      indexing: { enabled: true, embeddingModel: "nomic-embed-text" },
    };
    const result = await probeEmbeddingProvider(config, async () => undefined);
    expect(result).toEqual({ available: false, reason: "model-not-found" });
  });

  it("returns available=true for OpenAI when API key is present", async () => {
    const config: ChampConfig = {
      indexing: { enabled: true, provider: "openai" } as ChampConfig["indexing"],
    };
    const result = await probeEmbeddingProvider(
      config,
      async (name) => (name === "champ.openaiApiKey" ? "sk-test-key" : undefined),
    );
    expect(result).toEqual({ available: true, provider: "openai" });
  });

  it("returns reason=openai-key-absent when OpenAI key is missing", async () => {
    const config: ChampConfig = {
      indexing: { enabled: true, provider: "openai" } as ChampConfig["indexing"],
    };
    const result = await probeEmbeddingProvider(config, async () => undefined);
    expect(result).toEqual({ available: false, reason: "openai-key-absent" });
  });
});
```

- [ ] Run tests: `npx vitest run src/indexing/__tests__/embedding-probe.test.ts`
  - Expected: all 5 tests pass.

---

## Task 5: Register `champ.browseMcpServers` in `package.json`

- [ ] Open `package.json` and add to `contributes.commands` array:

```json
{
  "command": "champ.browseMcpServers",
  "title": "Champ: Browse MCP Servers",
  "category": "Champ"
}
```

---

## Task 6: Implement `champ.browseMcpServers` command in `extension.ts`

- [ ] Add the import at the top of `src/extension.ts` (with other marketplace imports):

```typescript
import {
  McpMarketplaceClient,
  buildMcpServerConfig,
  upsertMcpServer,
} from "./marketplace/mcp-marketplace-client";
```

- [ ] Add the command registration inside `activate()`, after the existing `champ.saveMcpConfig` registration. Full command implementation:

```typescript
vscode.commands.registerCommand("champ.browseMcpServers", async () => {
  // Step 1: Fetch manifest
  const mcpClient = new McpMarketplaceClient();
  const entries = await mcpClient.fetchManifest();

  if (entries.length === 0) {
    void vscode.window.showWarningMessage(
      "Champ: Could not fetch MCP marketplace — check your network connection.",
    );
  }

  // Step 2: QuickPick server selection
  const picked = await vscode.window.showQuickPick(
    entries.map((e) => ({
      label: e.name,
      description: e.transport,
      detail: e.description,
      entry: e,
    })),
    {
      title: "Champ MCP Marketplace",
      placeHolder:
        entries.length === 0
          ? "No servers available (network error)"
          : "Select an MCP server to install",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!picked) return;
  const entry = picked.entry;

  // Step 3: Choose install target
  const targetChoice = await vscode.window.showQuickPick(
    [
      {
        label: "Global (VS Code settings.json)",
        description: "Available in all workspaces",
        target: "global" as const,
      },
      {
        label: "Workspace (.champ/config.yaml)",
        description: "Local to this workspace only",
        target: "workspace" as const,
      },
    ],
    { title: `Install "${entry.name}"`, placeHolder: "Choose installation target" },
  );
  if (!targetChoice) return;

  // Step 4: Prompt for env values
  const resolvedEnv: Record<string, string> = {};
  if (entry.env) {
    for (const [key, description] of Object.entries(entry.env)) {
      const value = await vscode.window.showInputBox({
        prompt: `${key}: ${description}`,
        placeHolder: key,
        ignoreFocusOut: true,
      });
      if (value === undefined) return; // User cancelled — abort entire install
      resolvedEnv[key] = value;
    }
  }

  // Step 5: Build MCPServerConfig
  const serverConfig = buildMcpServerConfig(entry, resolvedEnv);

  try {
    if (targetChoice.target === "global") {
      // Write to VS Code settings.json
      const champConfig = vscode.workspace.getConfiguration("champ");
      const existingServers: import("./mcp/mcp-client").MCPServerConfig[] =
        champConfig.get<import("./mcp/mcp-client").MCPServerConfig[]>(
          "mcp.servers",
        ) ?? [];
      const { servers: updatedServers, wasUpdate } = upsertMcpServer(
        [...existingServers],
        serverConfig,
      );
      await champConfig.update(
        "mcp.servers",
        updatedServers,
        vscode.ConfigurationTarget.Global,
      );
      void vscode.window.showInformationMessage(
        wasUpdate
          ? `Champ: MCP server '${entry.name}' updated. Reconnecting…`
          : `Champ: MCP server '${entry.name}' installed. Connecting…`,
      );
    } else {
      // Write to .champ/config.yaml (atomic write)
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage(
          "Champ: open a workspace to install MCP servers locally.",
        );
        return;
      }
      const configPath = path.join(workspaceRoot, ".champ", "config.yaml");
      let rawConfig = "";
      try {
        rawConfig = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(vscode.Uri.file(configPath)),
        );
      } catch {
        rawConfig = "provider: ollama\n";
      }

      const yamlLib = require("js-yaml") as typeof import("js-yaml");
      const doc = (yamlLib.load(rawConfig) as Record<string, unknown>) ?? {};
      if (!doc.mcp) doc.mcp = { servers: [] };
      const mcpSection = doc.mcp as { servers: unknown[] };
      if (!Array.isArray(mcpSection.servers)) mcpSection.servers = [];

      const typedServers = mcpSection.servers as import("./mcp/mcp-client").MCPServerConfig[];
      const { servers: updatedServers, wasUpdate } = upsertMcpServer(
        typedServers,
        serverConfig,
      );
      mcpSection.servers = updatedServers;

      // Atomic write: write to temp path then rename
      const tmpPath = configPath + ".tmp";
      const newContent = yamlLib.dump(doc);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(tmpPath),
        new TextEncoder().encode(newContent),
      );
      // Node fs rename for atomic replacement
      const nodeFsPromises = require("fs/promises") as typeof import("fs/promises");
      await nodeFsPromises.rename(tmpPath, configPath);

      void vscode.window.showInformationMessage(
        wasUpdate
          ? `Champ: MCP server '${entry.name}' updated. Reconnecting…`
          : `Champ: MCP server '${entry.name}' installed. Connecting…`,
      );
    }

    // Step 6: Hot-reload MCP connections
    await vscode.commands.executeCommand("champ.reloadMcpServers");
  } catch (err) {
    void vscode.window.showErrorMessage(
      "Champ: Failed to save MCP server configuration.",
    );
    console.error("[Champ] browseMcpServers write error:", err);
  }
}),
```

- [ ] Add this `registerCommand` call to `context.subscriptions` (wrap in `context.subscriptions.push(...)` or ensure it is within an existing push block as the others are).

---

## Task 7: Add `triggerAutoIndex` module-level function in `extension.ts`

- [ ] Add the following module-level async function **before** the `activate()` export in `src/extension.ts`:

```typescript
/**
 * Probe embedding provider reachability and, if available, trigger
 * IndexingService.initialize() with status bar progress indicators.
 * Called from activate() immediately after IndexingService construction.
 * Never throws — all errors are caught and logged.
 */
async function triggerAutoIndex(
  indexingServiceInstance: IndexingService,
  config: import("./config/config-loader").ChampConfig,
  context: vscode.ExtensionContext,
  statusBar: vscode.StatusBarItem,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  // Guard: workspace must be open
  if (!vscode.workspace.workspaceFolders?.length) return;

  const { probeEmbeddingProvider } = await import("./indexing/embedding-probe");
  const probeResult = await probeEmbeddingProvider(
    config,
    (name) => context.secrets.get(name),
  );

  if (!probeResult.available) {
    if (probeResult.reason === "ollama-unreachable") {
      const baseUrl =
        config.indexing?.baseUrl ?? "http://localhost:11434";
      outputChannel.appendLine(
        `[Indexing] Ollama not reachable at ${baseUrl} — skipping auto-index.`,
      );
    } else if (probeResult.reason === "model-not-found") {
      const model = config.indexing?.embeddingModel ?? "(unknown)";
      outputChannel.appendLine(
        `[Indexing] Embedding model '${model}' not in Ollama model list. Skipping auto-index.`,
      );
      statusBar.text = "$(warning) Champ: embedding model not found";
      statusBar.tooltip = `Model '${model}' not found in Ollama. Run: ollama pull ${model}`;
    }
    // openai-key-absent: silent
    return;
  }

  // Embedding provider is reachable — start indexing
  statusBar.text = "$(loading~spin) Champ: Indexing…";
  statusBar.tooltip = "Champ is indexing the workspace for semantic search";

  try {
    const stats = await indexingServiceInstance.initialize();
    if (stats) {
      statusBar.text = "$(database) Champ: Index ready";
      statusBar.tooltip = `${stats.filesIndexed} files indexed with ${stats.embeddingModel}`;
      outputChannel.appendLine(
        `[Indexing] Auto-index complete: ${stats.chunksIndexed} chunks from ${stats.filesIndexed} files (${stats.embeddingModel})`,
      );
    }
  } catch (err) {
    outputChannel.appendLine(
      `[Indexing] Auto-index error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

- [ ] Call `triggerAutoIndex` inside `activate()`, after `indexingService` is constructed and after `cachedYamlConfig` is available. Find the block where `indexingService` is first assigned in `activate()` (around line 205 in the `smartRouter.onChange` callback) and also add an **eager** trigger **before** the callback, in the main body of `activate()`, like this:

```typescript
// After IndexingService construction in activate():
if (cachedYamlConfig?.indexing?.enabled) {
  void triggerAutoIndex(
    indexingService!,
    cachedYamlConfig,
    context,
    statusBarItem,   // the existing statusBarItem created in activate()
    outputChannel,   // the existing Champ output channel
  );
}
```

The exact insertion point: find where `indexingService` is first instantiated inside `activate()` (not inside the `smartRouter.onChange` callback), or instantiate it there if it's only created inside the callback. The eager trigger runs once at startup; the existing `smartRouter.onChange` path continues to handle model-discovery-triggered re-indexing.

---

## Task 8: Compile check and test run

- [ ] Run TypeScript compile check:
  ```bash
  npx tsc --noEmit 2>&1 | head -40
  ```
  Expected: zero errors.

- [ ] Run full test suite:
  ```bash
  npx vitest run
  ```
  Expected: all existing tests still pass plus the 17 new tests (12 marketplace + 5 probe).

---

## Task 9: Version bump and package

- [ ] Bump version:
  ```bash
  npm version patch --no-git-tag-version
  ```

- [ ] Rebuild extension:
  ```bash
  npm run compile
  ```

- [ ] Package VSIX:
  ```bash
  npx vsce package --no-dependencies
  ```
  Expected: `champ-*.vsix` produced with no errors.

---

## Task 10: Commit

```bash
git add \
  src/marketplace/mcp-marketplace-client.ts \
  src/marketplace/__tests__/mcp-marketplace-client.test.ts \
  src/indexing/embedding-probe.ts \
  src/indexing/__tests__/embedding-probe.test.ts \
  marketplace/mcp-manifest.json \
  src/extension.ts \
  package.json

git commit -m "feat: MCP server marketplace (champ.browseMcpServers) + auto-indexing trigger on activation"
```

---

## Key Decisions

1. **Manifest URL** uses the same `hellodk/champ` GitHub raw URL pattern as `TeamMarketplaceClient`. The 4 manifest entries use `anthropics` as author per the spec; the spec names `sqlite`, `filesystem`, `postgres`, and `brave-search`.

2. **Duplicate-name handling** is extracted into `upsertMcpServer()` — a pure function — so it can be unit-tested without VS Code APIs.

3. **`probeEmbeddingProvider`** is extracted to `src/indexing/embedding-probe.ts` instead of living inline in `extension.ts`, making it importable in tests with a mock `getSecret` function.

4. **Atomic write for `.champ/config.yaml`** uses `write-to-tmp + Node fs.rename`, matching the spec's requirement for corruption-free updates. VS Code's `workspace.fs.rename` is not used because it may not be available for local files in all contexts; `require("fs/promises").rename` is the safer choice.

5. **`indexingService` construction location**: if `indexingService` is currently only constructed inside `smartRouter.onChange`, you must also construct it eagerly in the main body of `activate()` (or immediately after `cachedYamlConfig` is set) so `triggerAutoIndex` has an instance to call. The `smartRouter.onChange` path re-creates it whenever the router discovers new models — both paths are needed.
