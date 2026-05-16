# Spec: MCP Marketplace + Auto Indexing

**Date**: 2026-05-16
**Sprint**: 1

---

## Goal

Add a browsable MCP server marketplace accessible from the command palette and trigger workspace auto-indexing on extension activation whenever an embedding provider is reachable, without waiting for SmartRouter to discover one during a chat request.

---

## Architecture

The MCP marketplace lives at `marketplace/mcp-manifest.json` in the repository root and is fetched at runtime by a new `McpMarketplaceClient` class. The manifest format extends `MarketplaceEntry` (from `src/marketplace/team-marketplace-client.ts`) with MCP-specific transport fields — it is a static JSON file describing how to configure each server, not a package installer. Install writes a typed `MCPServerConfig` block (matching `src/mcp/mcp-client.ts` line 20) either to VS Code `settings.json` under `champ.mcp.servers` (global) or to `.champ/config.yaml` under `mcp.servers` (workspace), then hot-reloads all MCP connections. Auto-indexing is triggered directly in `activate()` in `src/extension.ts` after the `IndexingService` is constructed: when `config.indexing.enabled` is `true` and the embedding provider is reachable (checked by a lightweight ping), `indexingService.initialize()` is called immediately rather than waiting for SmartRouter to encounter an embedding-capable model during a chat request.

---

## MCP Manifest Format

### TypeScript Interface

```typescript
// src/marketplace/mcp-marketplace-client.ts

export interface McpMarketplaceEntry {
  /** Unique server name. Must be a valid identifier (no spaces). */
  name: string;
  /** One-sentence description shown in the QuickPick. */
  description: string;
  /** Author or organization name. */
  author: string;
  /**
   * URL to the server's install instructions or YAML config snippet
   * (NOT the server binary). This is a documentation/config manifest URL.
   * Example: "https://raw.githubusercontent.com/org/repo/main/servers/sqlite.md"
   */
  url: string;
  /** Transport protocol the server uses. */
  transport: "stdio" | "sse";
  /**
   * Shell command to launch the server process.
   * Required when transport === "stdio".
   * Omitted when transport === "sse".
   */
  command?: string;
  /** Arguments passed to the command. May include $VAR placeholders. */
  args?: string[];
  /**
   * Environment variables the server requires.
   * Keys are variable names; values are human-readable descriptions.
   * The actual values are NOT stored here — the user provides them.
   * Example: { "OPENAI_API_KEY": "Your OpenAI API key" }
   */
  env?: Record<string, string>;
  /**
   * Base URL for SSE transport servers.
   * Required when transport === "sse".
   * Omitted when transport === "stdio".
   */
  baseUrl?: string;
  /** Categorization tags for future filtering. E.g. ["database", "local"]. */
  tags: string[];
}
```

### JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "McpMarketplaceManifest",
  "type": "array",
  "items": {
    "type": "object",
    "required": ["name", "description", "author", "url", "transport", "tags"],
    "properties": {
      "name":        { "type": "string", "pattern": "^[a-zA-Z0-9_-]+$" },
      "description": { "type": "string" },
      "author":      { "type": "string" },
      "url":         { "type": "string", "format": "uri" },
      "transport":   { "type": "string", "enum": ["stdio", "sse"] },
      "command":     { "type": "string" },
      "args":        { "type": "array", "items": { "type": "string" } },
      "env":         { "type": "object", "additionalProperties": { "type": "string" } },
      "baseUrl":     { "type": "string", "format": "uri" },
      "tags":        { "type": "array", "items": { "type": "string" } }
    },
    "if":   { "properties": { "transport": { "const": "sse" } }, "required": ["transport"] },
    "then": { "required": ["baseUrl"] },
    "else": { "required": ["command"] }
  }
}
```

### Example Entry

```json
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
}
```

---

## Install Flow

### Step-by-step

1. **User invokes command**: `champ.browseMcpServers` from the command palette.

2. **Fetch manifest**: `McpMarketplaceClient.fetchManifest()` sends a `fetch()` request to `MCP_MANIFEST_URL` (`https://raw.githubusercontent.com/hellodk/champ/master/marketplace/mcp-manifest.json`). If the network call fails or returns non-2xx, show a VS Code warning notification: `"Champ: Could not fetch MCP marketplace — check your network connection."` The QuickPick opens with zero items and a `placeHolder` of `"No servers available (network error)"`. The flow ends here.

3. **Show QuickPick**: Open `vscode.window.showQuickPick()` with each `McpMarketplaceEntry` rendered as:
   - `label`: `entry.name`
   - `description`: `entry.transport` (e.g. `"stdio"`)
   - `detail`: `entry.description`

4. **User selects a server**: If the user cancels (returns `undefined`), the flow ends silently.

5. **Choose install target**: Open a second QuickPick:
   ```
   Items:
     { label: "Global (VS Code settings.json)",  description: "Available in all workspaces" }
     { label: "Workspace (.champ/config.yaml)",   description: "Local to this workspace only" }
   ```
   If the user cancels, the flow ends silently.

6. **Prompt for env values**: For each key in `entry.env`, call `vscode.window.showInputBox({ prompt: \`${key}: ${entry.env[key]}\`, ignoreFocusOut: true })`. If the user cancels any input, abort the entire install silently (no partial state written).

7. **Build the `MCPServerConfig` object**:
   ```typescript
   const config: MCPServerConfig = {
     name: entry.name,
     transport: entry.transport,
     ...(entry.transport === "stdio"
       ? { command: entry.command!, args: entry.args ?? [] }
       : { url: entry.baseUrl! }),
     ...(resolvedEnv && Object.keys(resolvedEnv).length > 0
       ? { env: resolvedEnv }
       : {}),
   };
   ```
   Where `resolvedEnv` is the object of `{ [key]: userProvidedValue }` collected in step 6.

8. **Write config**:

   **Global path** — read `vscode.workspace.getConfiguration("champ")`, update `champ.mcp.servers` array:
   - If an entry with the same `name` already exists, replace it (update in place).
   - Otherwise, append the new entry.
   - Call `config.update("mcp.servers", updatedArray, vscode.ConfigurationTarget.Global)`.

   Exact JSON shape written into VS Code `settings.json`:
   ```json
   {
     "champ.mcp.servers": [
       {
         "name": "sqlite",
         "transport": "stdio",
         "command": "uvx",
         "args": ["mcp-server-sqlite", "--db-path", "/home/user/data.db"],
         "env": { "SQLITE_DB_PATH": "/home/user/data.db" }
       }
     ]
   }
   ```

   **Workspace path** — read `.champ/config.yaml` (or start from empty object if absent). Update the `mcp.servers` array using the same duplicate-name logic (replace if same name exists, otherwise append). Write the file back.

   Exact YAML shape written to `.champ/config.yaml`:
   ```yaml
   mcp:
     servers:
       - name: sqlite
         transport: stdio
         command: uvx
         args:
           - mcp-server-sqlite
           - --db-path
           - /home/user/data.db
         env:
           SQLITE_DB_PATH: /home/user/data.db
   ```

   If the write fails (disk full, permissions), show: `"Champ: Failed to save MCP server configuration."` No partial state remains (the file is written atomically — write to temp file, then rename).

9. **Hot-reload**: After a successful write, execute `vscode.commands.executeCommand("champ.reloadMcpServers")` (already exists). This disconnects all current MCP clients and reconnects using the updated config. Show an information notification: `"Champ: MCP server '${entry.name}' installed. Connecting…"`

### Duplicate Name Handling

When writing the config, if an entry with the same `name` already exists in the target array:
- Replace the existing entry entirely with the new `MCPServerConfig`.
- Do not append a duplicate.
- The information notification says `"Champ: MCP server '${entry.name}' updated. Reconnecting…"` instead.

---

## Auto-Indexing Trigger

### Conditions Required (ALL must be true)

1. `config.indexing?.enabled === true` (read from the loaded `ChampConfig`)
2. An embedding provider is reachable (see provider-specific checks below)
3. A workspace folder is open (`vscode.workspace.workspaceFolders` is non-empty)

### Embedding Provider Reachability Checks

**Ollama**: Send `GET {baseUrl}/api/tags` where `baseUrl` defaults to `http://localhost:11434` (same default as `IndexingService._initialize()`). If the response is HTTP 200, Ollama is reachable. If the response body JSON contains a `models` array that does not include the configured `config.indexing.embeddingModel`, do not proceed — show the status bar message `"Champ: embedding model not found"` (see Status Bar section). The ping must resolve within 3 seconds; use `AbortSignal.timeout(3000)`.

**OpenAI**: No HTTP ping. The provider is considered reachable if `context.secrets.get("champ.openaiApiKey")` resolves to a non-empty string. If the key is absent, the auto-index trigger does not fire.

### Trigger Location in `activate()`

```typescript
// After IndexingService is constructed, before returning from activate():
if (config.indexing?.enabled) {
  void triggerAutoIndex(indexingService, config, context, statusBarItem, outputChannel);
}
```

`triggerAutoIndex` is a module-level async function in `src/extension.ts` that performs the reachability check and calls `indexingService.initialize()`.

### Status Bar During Indexing

While `indexingService.initialize()` is running:
- `statusBarItem.text = "$(loading~spin) Champ: Indexing…"`
- `statusBarItem.tooltip = "Champ is indexing the workspace for semantic search"`

When `initialize()` resolves with a non-null `IndexingStats`:
- `statusBarItem.text = "$(database) Champ: Index ready"`
- `statusBarItem.tooltip = \`${stats.filesIndexed} files indexed with ${stats.embeddingModel}\``

### Embedding Model Not Found

If the Ollama `/api/tags` response is 200 but the model is absent from the `models` array:
- Do not call `indexingService.initialize()`.
- Set `statusBarItem.text = "$(warning) Champ: embedding model not found"`.
- `statusBarItem.tooltip = \`Model '${config.indexing.embeddingModel}' not found in Ollama. Run: ollama pull ${config.indexing.embeddingModel}\``.
- Log to the Champ output channel: `[Indexing] Embedding model '${model}' not in Ollama model list. Skipping auto-index.`

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Network failure fetching MCP manifest | `vscode.window.showWarningMessage(...)`, QuickPick opens empty with error placeholder, flow terminates |
| JSON parse error in manifest response | Same as network failure |
| User cancels QuickPick or target picker | Silent no-op, no state written |
| User cancels env var input box | Abort entire install, no state written |
| Config write failure (global settings.json) | `vscode.window.showErrorMessage("Champ: Failed to save MCP server configuration.")`, no partial state |
| Config write failure (workspace .champ/config.yaml) | Same error message, atomic write (temp + rename) prevents corruption |
| Auto-index: Ollama not reachable (connection refused, timeout) | Silent — do not call `initialize()`, log to output channel: `[Indexing] Ollama not reachable at ${baseUrl} — skipping auto-index.` |
| Auto-index: OpenAI key absent | Silent — do not call `initialize()`, no log |
| `indexingService.initialize()` throws internally | Already handled by `IndexingService._initialize()` which returns `null` on error; `triggerAutoIndex` catches any uncaught rejection and logs to output channel |

---

## Testing

### Unit Tests (new file: `src/test/mcp-marketplace-client.test.ts`)

1. `McpMarketplaceClient.fetchManifest()` returns parsed array on 200 response with valid JSON.
2. `McpMarketplaceClient.fetchManifest()` returns empty array on non-200 response.
3. `McpMarketplaceClient.fetchManifest()` returns empty array on network error (fetch throws).
4. `McpMarketplaceClient.fetchManifest()` returns empty array when response JSON is not an array.
5. `buildMcpServerConfig()` (helper) builds correct `MCPServerConfig` for stdio entry with env.
6. `buildMcpServerConfig()` builds correct `MCPServerConfig` for sse entry.
7. Duplicate-name replacement: given existing array with `name: "sqlite"`, inserting new entry with same name replaces, not appends.
8. `isOllamaReachable()` returns `true` when fetch resolves 200.
9. `isOllamaReachable()` returns `false` when fetch rejects.
10. `isOllamaReachable()` returns `false` on 500 response.
11. `isEmbeddingModelAvailable()` returns `false` when model name absent from Ollama `/api/tags` response.
12. `isEmbeddingModelAvailable()` returns `true` when model name present.

---

## Files

| File | Status | Change |
|---|---|---|
| `src/marketplace/mcp-marketplace-client.ts` | New | `McpMarketplaceEntry` interface, `McpMarketplaceClient` class with `fetchManifest()`, `isOllamaReachable()`, `isEmbeddingModelAvailable()`, `buildMcpServerConfig()` helpers |
| `src/extension.ts` | Modified | Register `champ.browseMcpServers` command; add `triggerAutoIndex()` call in `activate()` |
| `package.json` | Modified | Add `champ.browseMcpServers` to `contributes.commands` with title `"Champ: Browse MCP Servers"` |
| `marketplace/mcp-manifest.json` | New | 4+ `McpMarketplaceEntry` objects: `sqlite`, `filesystem`, `postgres`, `brave-search` |

### `marketplace/mcp-manifest.json` — Minimum 4 Entries

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
      "SQLITE_DB_PATH": "Absolute path to the SQLite database file"
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
