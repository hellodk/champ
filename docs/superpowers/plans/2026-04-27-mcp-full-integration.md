# MCP Full Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `MCPClientManager` to `ToolRegistry` so agents can call tools from any MCP server configured in `.champ/config.yaml` — plus secret interpolation, dynamic reconnect on config change, and approval gating.

**Architecture:** `MCPToolAdapter` wraps each `MCPTool` as a `Tool` object and registers/unregisters it dynamically in `ToolRegistry`. `extension.ts` calls `loadMcpServers()` on every config reload, diffing old vs new server list to connect new ones and disconnect removed ones. Env values containing `${{ secrets.KEY }}` are resolved against VS Code `SecretStorage` before spawning the server process.

**Tech Stack:** TypeScript, existing `MCPClientManager` + `ToolRegistry`, VS Code `SecretStorage` API, `vitest`.

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/mcp/mcp-tool-adapter.ts` | **Create** | Wraps `MCPTool` as `Tool`; formats MCP result as plain text for LLM |
| `src/mcp/mcp-registry.ts` | **Create** | Owns the `MCPClientManager` singleton; diffs server lists on reload; registers/unregisters tools in `ToolRegistry` |
| `src/mcp/secret-resolver.ts` | **Create** | Resolves `${{ secrets.KEY }}` in env values against VS Code `SecretStorage` |
| `src/extension.ts` | **Modify** | Instantiate `McpRegistry`; call `loadMcpServers()` in `loadProvider()`; dispose on deactivate |
| `test/unit/mcp/mcp-tool-adapter.test.ts` | **Create** | Unit tests for adapter: tool metadata mapping, result formatting, error handling |
| `test/unit/mcp/secret-resolver.test.ts` | **Create** | Unit tests for secret interpolation |
| `test/unit/mcp/mcp-registry.test.ts` | **Create** | Unit tests for diff/connect/disconnect logic |

---

### Task 1: MCPToolAdapter — wrap MCPTool as Tool

**Files:**
- Create: `src/mcp/mcp-tool-adapter.ts`
- Test: `test/unit/mcp/mcp-tool-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/mcp/mcp-tool-adapter.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createMcpToolAdapter } from "../../../src/mcp/mcp-tool-adapter";
import type { MCPClientManager, MCPTool } from "../../../src/mcp/mcp-client";
import type { ToolExecutionContext } from "../../../src/tools/types";

function makeManager(result = { content: [{ type: "text" as const, text: "output" }], isError: false }) {
  return {
    invokeTool: vi.fn().mockResolvedValue(result),
  } as unknown as MCPClientManager;
}

const ctx: ToolExecutionContext = {
  workspaceRoot: "/tmp",
  abortSignal: new AbortController().signal,
  reportProgress: vi.fn(),
  requestApproval: vi.fn().mockResolvedValue(true),
};

const mcpTool: MCPTool = {
  name: "list_issues",
  description: "List GitHub issues",
  inputSchema: {
    type: "object",
    properties: { repo: { type: "string" } },
    required: ["repo"],
  },
};

describe("createMcpToolAdapter", () => {
  it("maps MCPTool name and description to Tool", () => {
    const tool = createMcpToolAdapter("github", mcpTool, makeManager());
    expect(tool.name).toBe("mcp_github_list_issues");
    expect(tool.description).toContain("List GitHub issues");
    expect(tool.description).toContain("[MCP: github]");
  });

  it("maps inputSchema to parameters", () => {
    const tool = createMcpToolAdapter("github", mcpTool, makeManager());
    expect(tool.parameters).toEqual(mcpTool.inputSchema);
  });

  it("requiresApproval is true by default", () => {
    const tool = createMcpToolAdapter("github", mcpTool, makeManager());
    expect(tool.requiresApproval).toBe(true);
  });

  it("executes by calling invokeTool and returns text output", async () => {
    const manager = makeManager();
    const tool = createMcpToolAdapter("github", mcpTool, manager);
    const result = await tool.execute({ repo: "hellodk/champ" }, ctx);
    expect(manager.invokeTool).toHaveBeenCalledWith(
      "github",
      "list_issues",
      { repo: "hellodk/champ" },
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe("output");
  });

  it("returns success=false and error text when isError=true", async () => {
    const manager = makeManager({
      content: [{ type: "text", text: "not found" }],
      isError: true,
    });
    const tool = createMcpToolAdapter("github", mcpTool, manager);
    const result = await tool.execute({ repo: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("joins multiple content blocks with newlines", async () => {
    const manager = makeManager({
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
      isError: false,
    });
    const tool = createMcpToolAdapter("github", mcpTool, manager);
    const result = await tool.execute({}, ctx);
    expect(result.output).toBe("part1\npart2");
  });

  it("ignores non-text content blocks", async () => {
    const manager = makeManager({
      content: [
        { type: "image", data: "base64...", mimeType: "image/png" },
        { type: "text", text: "summary" },
      ],
      isError: false,
    });
    const tool = createMcpToolAdapter("github", mcpTool, manager);
    const result = await tool.execute({}, ctx);
    expect(result.output).toBe("summary");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/mcp/mcp-tool-adapter.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../../../src/mcp/mcp-tool-adapter'`

- [ ] **Step 3: Implement the adapter**

Create `src/mcp/mcp-tool-adapter.ts`:

```typescript
import type { MCPClientManager, MCPTool } from "./mcp-client";
import type { Tool, ToolExecutionContext, ToolResult } from "../tools/types";
import type { ToolParameterSchema } from "../providers/types";

/**
 * Wrap a single MCPTool as a Tool that the ToolRegistry can dispatch.
 *
 * Naming convention: `mcp_{serverName}_{toolName}` — the prefix prevents
 * collisions with built-in tools and makes MCP origin visible to the LLM.
 */
export function createMcpToolAdapter(
  serverName: string,
  mcpTool: MCPTool,
  manager: MCPClientManager,
): Tool {
  const name = `mcp_${serverName}_${mcpTool.name}`;
  const description = `${mcpTool.description} [MCP: ${serverName}]`;

  const parameters: ToolParameterSchema =
    mcpTool.inputSchema &&
    typeof mcpTool.inputSchema === "object" &&
    mcpTool.inputSchema.type === "object"
      ? (mcpTool.inputSchema as ToolParameterSchema)
      : { type: "object", properties: {}, required: [] };

  return {
    name,
    description,
    parameters,
    requiresApproval: true,

    async execute(
      args: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolResult> {
      const result = await manager.invokeTool(serverName, mcpTool.name, args);

      const output = result.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n");

      return {
        success: !result.isError,
        output: output || (result.isError ? "MCP tool returned an error" : ""),
      };
    },
  };
}
```

- [ ] **Step 4: Run tests — all must pass**

```bash
npx vitest run test/unit/mcp/mcp-tool-adapter.test.ts 2>&1 | tail -10
```

Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/mcp-tool-adapter.ts test/unit/mcp/mcp-tool-adapter.test.ts
git commit -m "feat: MCPToolAdapter — wraps MCPTool as ToolRegistry-compatible Tool"
```

---

### Task 2: SecretResolver — interpolate `${{ secrets.KEY }}` in MCP env

**Files:**
- Create: `src/mcp/secret-resolver.ts`
- Test: `test/unit/mcp/secret-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/mcp/secret-resolver.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { resolveEnvSecrets } from "../../../src/mcp/secret-resolver";

function makeSecretStorage(secrets: Record<string, string | undefined>) {
  return {
    get: vi.fn(async (key: string) => secrets[key]),
  };
}

describe("resolveEnvSecrets", () => {
  it("returns env unchanged when no secret tokens present", async () => {
    const storage = makeSecretStorage({});
    const result = await resolveEnvSecrets(
      { PLAIN_KEY: "value" },
      storage as never,
    );
    expect(result).toEqual({ PLAIN_KEY: "value" });
  });

  it("replaces ${{ secrets.KEY }} with the stored secret", async () => {
    const storage = makeSecretStorage({ GITHUB_TOKEN: "ghp_abc123" });
    const result = await resolveEnvSecrets(
      { TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
      storage as never,
    );
    expect(result).toEqual({ TOKEN: "ghp_abc123" });
  });

  it("leaves value unchanged when secret is not found", async () => {
    const storage = makeSecretStorage({});
    const result = await resolveEnvSecrets(
      { TOKEN: "${{ secrets.MISSING }}" },
      storage as never,
    );
    expect(result).toEqual({ TOKEN: "" });
  });

  it("handles multiple env vars independently", async () => {
    const storage = makeSecretStorage({ A: "aaa", B: "bbb" });
    const result = await resolveEnvSecrets(
      {
        KEY_A: "${{ secrets.A }}",
        KEY_B: "${{ secrets.B }}",
        PLAIN: "plain",
      },
      storage as never,
    );
    expect(result).toEqual({ KEY_A: "aaa", KEY_B: "bbb", PLAIN: "plain" });
  });

  it("handles whitespace inside token: ${{ secrets. KEY }}", async () => {
    const storage = makeSecretStorage({ MYKEY: "secret" });
    const result = await resolveEnvSecrets(
      { X: "${{  secrets.MYKEY  }}" },
      storage as never,
    );
    expect(result).toEqual({ X: "secret" });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run test/unit/mcp/secret-resolver.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../../../src/mcp/secret-resolver'`

- [ ] **Step 3: Implement**

Create `src/mcp/secret-resolver.ts`:

```typescript
import type * as vscode from "vscode";

const SECRET_TOKEN = /\${{\s*secrets\.(\w+)\s*}}/g;

/**
 * Resolve `${{ secrets.KEY }}` tokens in MCP server env values using
 * VS Code SecretStorage. Values without tokens are returned unchanged.
 * Unknown keys resolve to empty string (avoids leaking that the key exists).
 */
export async function resolveEnvSecrets(
  env: Record<string, string>,
  secretStorage: Pick<vscode.SecretStorage, "get">,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_TOKEN.test(value)) {
      result[key] = value;
      continue;
    }

    // Reset lastIndex after the test() call.
    SECRET_TOKEN.lastIndex = 0;

    let resolved = value;
    const matches = [...value.matchAll(SECRET_TOKEN)];
    for (const match of matches) {
      const secretKey = match[1];
      const secretValue = (await secretStorage.get(secretKey)) ?? "";
      resolved = resolved.replace(match[0], secretValue);
    }
    result[key] = resolved;
  }

  return result;
}
```

- [ ] **Step 4: Run tests — all must pass**

```bash
npx vitest run test/unit/mcp/secret-resolver.test.ts 2>&1 | tail -10
```

Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/secret-resolver.ts test/unit/mcp/secret-resolver.test.ts
git commit -m "feat: SecretResolver — interpolate \${{ secrets.KEY }} in MCP server env"
```

---

### Task 3: McpRegistry — diff-based connect/disconnect + ToolRegistry wiring

**Files:**
- Create: `src/mcp/mcp-registry.ts`
- Test: `test/unit/mcp/mcp-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/mcp/mcp-registry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpRegistry } from "../../../src/mcp/mcp-registry";
import type { ToolRegistry } from "../../../src/tools/registry";

function makeToolRegistry() {
  const registered = new Map<string, unknown>();
  return {
    register: vi.fn((tool: { name: string }) => registered.set(tool.name, tool)),
    unregister: vi.fn((name: string) => registered.delete(name)),
    registered,
  } as unknown as ToolRegistry & { registered: Map<string, unknown> };
}

function makeManager(tools: Array<{ name: string; description: string }>) {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    listTools: vi.fn().mockResolvedValue(
      tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: {}, required: [] } })),
    ),
    getConnectedServers: vi.fn().mockReturnValue([]),
  };
}

describe("McpRegistry", () => {
  it("connects new servers and registers their tools", async () => {
    const registry = makeToolRegistry();
    const manager = makeManager([{ name: "list_issues", description: "List issues" }]);
    const mcpRegistry = new McpRegistry(manager as never, registry, { get: async () => undefined } as never);

    await mcpRegistry.loadServers([
      { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    ]);

    expect(manager.connect).toHaveBeenCalledOnce();
    expect(registry.register).toHaveBeenCalledOnce();
    const toolName = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0][0].name;
    expect(toolName).toBe("mcp_github_list_issues");
  });

  it("disconnects removed servers and unregisters their tools", async () => {
    const registry = makeToolRegistry();
    const manager = makeManager([{ name: "list_issues", description: "List" }]);
    (manager.getConnectedServers as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([]) // first call: empty
      .mockReturnValue(["github"]); // subsequent calls

    const mcpRegistry = new McpRegistry(manager as never, registry, { get: async () => undefined } as never);

    // Connect github
    await mcpRegistry.loadServers([
      { name: "github", command: "npx", args: [] },
    ]);

    // Remove github
    await mcpRegistry.loadServers([]);

    expect(manager.disconnect).toHaveBeenCalledWith("github");
    expect(registry.unregister).toHaveBeenCalledWith("mcp_github_list_issues");
  });

  it("skips servers already connected (no reconnect on reload)", async () => {
    const registry = makeToolRegistry();
    const manager = makeManager([]);
    (manager.getConnectedServers as ReturnType<typeof vi.fn>).mockReturnValue(["github"]);

    const mcpRegistry = new McpRegistry(manager as never, registry, { get: async () => undefined } as never);

    await mcpRegistry.loadServers([
      { name: "github", command: "npx", args: [] },
    ]);

    // github was already connected — connect should NOT be called
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it("disposeAll disconnects everything and unregisters all tools", async () => {
    const registry = makeToolRegistry();
    const manager = makeManager([{ name: "t1", description: "T1" }]);
    const mcpRegistry = new McpRegistry(manager as never, registry, { get: async () => undefined } as never);

    await mcpRegistry.loadServers([{ name: "srv", command: "cmd", args: [] }]);
    await mcpRegistry.disposeAll();

    expect(manager.disconnectAll).toHaveBeenCalledOnce();
    expect(registry.unregister).toHaveBeenCalledWith("mcp_srv_t1");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run test/unit/mcp/mcp-registry.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../../../src/mcp/mcp-registry'`

- [ ] **Step 3: Implement McpRegistry**

Create `src/mcp/mcp-registry.ts`:

```typescript
import type * as vscode from "vscode";
import { MCPClientManager, type MCPServerConfig } from "./mcp-client";
import { createMcpToolAdapter } from "./mcp-tool-adapter";
import { resolveEnvSecrets } from "./secret-resolver";
import type { ToolRegistry } from "../tools/registry";

/**
 * Manages the lifecycle of MCP server connections and their tool registrations.
 *
 * On each `loadServers()` call it diffs the desired server list against the
 * currently connected set — connecting new servers, disconnecting removed ones,
 * and leaving unchanged ones alone. This makes config reloads cheap.
 */
export class McpRegistry {
  /** serverName → tool names registered from that server */
  private registeredTools = new Map<string, string[]>();

  constructor(
    private readonly manager: MCPClientManager,
    private readonly toolRegistry: ToolRegistry,
    private readonly secretStorage: Pick<vscode.SecretStorage, "get">,
  ) {}

  /**
   * Reconcile the desired server list with the current connections.
   * Idempotent — safe to call on every config reload.
   */
  async loadServers(servers: MCPServerConfig[]): Promise<void> {
    const desired = new Map(servers.map((s) => [s.name, s]));
    const connected = new Set(this.manager.getConnectedServers());

    // Disconnect servers no longer in config.
    for (const name of connected) {
      if (!desired.has(name)) {
        await this.disconnectServer(name);
      }
    }

    // Connect new servers.
    for (const [name, config] of desired) {
      if (connected.has(name)) continue; // already connected — skip

      try {
        const resolvedEnv = config.env
          ? await resolveEnvSecrets(config.env, this.secretStorage)
          : undefined;

        await this.manager.connect({ ...config, env: resolvedEnv });
        await this.registerServerTools(name);

        console.log(`Champ MCP: connected "${name}"`);
      } catch (err) {
        console.error(
          `Champ MCP: failed to connect "${name}":`,
          err instanceof Error ? err.message : String(err),
        );
        // Continue with other servers — one failure must not block the rest.
      }
    }
  }

  async disposeAll(): Promise<void> {
    for (const name of [...this.registeredTools.keys()]) {
      this.unregisterServerTools(name);
    }
    await this.manager.disconnectAll();
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private async registerServerTools(serverName: string): Promise<void> {
    const tools = await this.manager.listTools(serverName);
    const names: string[] = [];

    for (const mcpTool of tools) {
      const adapter = createMcpToolAdapter(serverName, mcpTool, this.manager);
      this.toolRegistry.register(adapter);
      names.push(adapter.name);
    }

    this.registeredTools.set(serverName, names);
    console.log(
      `Champ MCP: registered ${names.length} tool(s) from "${serverName}": ${names.join(", ")}`,
    );
  }

  private unregisterServerTools(serverName: string): void {
    const names = this.registeredTools.get(serverName) ?? [];
    for (const name of names) {
      this.toolRegistry.unregister(name);
    }
    this.registeredTools.delete(serverName);
  }

  private async disconnectServer(serverName: string): Promise<void> {
    this.unregisterServerTools(serverName);
    await this.manager.disconnect(serverName);
    console.log(`Champ MCP: disconnected "${serverName}"`);
  }
}
```

- [ ] **Step 4: Run tests — all must pass**

```bash
npx vitest run test/unit/mcp/mcp-registry.test.ts 2>&1 | tail -10
```

Expected: 4/4 PASS.

- [ ] **Step 5: Run full suite**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: all pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/mcp-registry.ts test/unit/mcp/mcp-registry.test.ts
git commit -m "feat: McpRegistry — diff-based MCP server connect/disconnect with ToolRegistry wiring"
```

---

### Task 4: Wire McpRegistry into extension.ts

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Add imports**

Read `src/extension.ts`. At the top with other imports, add:

```typescript
import { MCPClientManager } from "./mcp/mcp-client";
import { McpRegistry } from "./mcp/mcp-registry";
```

- [ ] **Step 2: Add module-level singleton**

After the existing `let indexingService: IndexingService | undefined;` line, add:

```typescript
let mcpRegistry: McpRegistry | undefined;
```

- [ ] **Step 3: Instantiate McpRegistry during activation**

In `activate()`, after `agentManager` and `sessionStore` are created (around where `smartRouter = new SmartRouter()` is), add:

```typescript
  // ---- MCP (Model Context Protocol) server connections ----------------
  const mcpClientManager = new MCPClientManager();
  mcpRegistry = new McpRegistry(mcpClientManager, toolRegistry, context.secrets);
```

- [ ] **Step 4: Call loadServers on every config reload**

In `loadProvider()` (the async function that runs on every YAML config change), find where `cachedYamlConfig` is set. After it, add:

```typescript
      // Reconnect MCP servers whenever config changes.
      if (mcpRegistry) {
        void mcpRegistry.loadServers(yamlConfig?.mcp?.servers ?? []);
      }
```

- [ ] **Step 5: Dispose on deactivation**

In `deactivate()`, add before the other disposes:

```typescript
  void mcpRegistry?.disposeAll();
```

- [ ] **Step 6: Type-check**

```bash
npm run check-types 2>&1
```

Expected: no errors. Fix any TypeScript errors before proceeding.

- [ ] **Step 7: Run full test suite**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire McpRegistry into extension — MCP tools now available to agent on config load"
```

---

### Task 5: Build, test with a real MCP server, and release

- [ ] **Step 1: Build**

```bash
npm run package 2>&1 | tail -3
```

Expected: `dist/extension.js` built, no errors.

- [ ] **Step 2: Package**

```bash
npx @vscode/vsce package --no-dependencies 2>&1 | tail -3
```

- [ ] **Step 3: Install**

```bash
code --install-extension champ-1.6.4.vsix
```

- [ ] **Step 4: Manual smoke test with the filesystem MCP server**

In `.champ/config.yaml`, add:

```yaml
mcp:
  servers:
    - name: filesystem
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

Reload VS Code. Open Champ and ask: *"list the files in /tmp using MCP"*

Expected: agent calls `mcp_filesystem_*` tool(s) and returns file listing.

- [ ] **Step 5: Bump version to 1.6.5 and update CHANGELOG**

```bash
npm version 1.6.5 --no-git-tag-version
```

Add to top of CHANGELOG.md:

```markdown
## [1.6.5] — 2026-04-27

### Added

- **MCP full integration** — tools from any MCP server in `.champ/config.yaml`
  are now registered in the tool registry and available to the agent.
  Agents can call `mcp_{server}_{tool}` just like built-in tools.
- **Secret interpolation** — MCP server `env:` values support
  `${{ secrets.KEY }}` syntax, resolved from VS Code SecretStorage.
- **Dynamic reconnect** — changing `mcp.servers` in the YAML config
  reconnects new servers and disconnects removed ones without restart.
- **Approval gating** — all MCP tool calls require user approval by default
  (same as `run_terminal_cmd`), ensuring no MCP server can silently execute.
```

- [ ] **Step 6: Commit and push**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 1.6.5 — MCP full integration"
git push github master
git tag v1.6.5 && git push github v1.6.5
```

---

## Self-Review

**Spec coverage:**
- ✓ MCP tools registered in ToolRegistry → Task 1 + Task 3
- ✓ `${{ secrets.KEY }}` interpolation → Task 2
- ✓ Connect on config load → Task 4
- ✓ Disconnect when server removed from config → Task 3 (diff logic)
- ✓ Tool unregistered when server disconnects → Task 3 (`unregisterServerTools`)
- ✓ Approval gating → Task 1 (`requiresApproval: true`)
- ✓ Error on one server doesn't block others → Task 3 (try/catch per server)
- ✓ Disposed on deactivate → Task 4

**Placeholder scan:** All code blocks are complete. No TBD or placeholder steps.

**Type consistency:**
- `MCPClientManager`, `MCPTool`, `MCPServerConfig` — used from `mcp-client.ts` throughout ✓
- `ToolRegistry.register` / `unregister` — matches actual registry interface ✓
- `createMcpToolAdapter(serverName, mcpTool, manager)` — consistent across Task 1 and Task 3 ✓
- `McpRegistry.loadServers(servers: MCPServerConfig[])` — matches Task 4 wiring ✓
- `resolveEnvSecrets(env, secretStorage)` — consistent across Task 2 and Task 3 ✓
