# Sprint L: MCP Protocol Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete MCP protocol coverage with @MCP/@MCPPrompt context references, OAuth/Bearer auth for SSE transport, and server capability negotiation so Champ honours the full MCP spec surface.

**Architecture:** Context resolver gains two new reference types: `@MCP(server:uri)` which calls `mcpRegistry.readResource()`, and `@MCPPrompt(server:promptName?arg=val)` which calls `mcpRegistry.getPrompt()`. `MCPServerConfig` gains an optional `auth` field whose value becomes an extra header in `MCPSSEConnection`. The `initialize` response capabilities object is stored per-connection and used to gate resource/prompt calls (skip if server didn't declare capability). `McpServerStatus` is extended with `resourceCount` and `promptCount` so the UI reflects the full server surface.

**Tech Stack:** TypeScript, Vitest (tests), MCP JSON-RPC 2.0 protocol, VS Code SecretStorage (for auth token resolution)

---

## File Map

| File | Change |
|---|---|
| `src/ui/messages.ts` | Add `resourceCount`, `promptCount` to `McpServerStatus` |
| `src/mcp/mcp-client.ts` | Add `MCPServerAuth` type to `MCPServerConfig`; store capabilities from `initialize` response; gate `listResources`/`listPrompts` on declared capabilities |
| `src/mcp/mcp-registry.ts` | Track resource/prompt counts per server; expose in `getStatus()` |
| `src/agent/context-resolver.ts` | Add `"mcp"` and `"mcpPrompt"` reference types with parse + resolve |
| `src/mcp/__tests__/mcp-capabilities.test.ts` | New — unit tests for capability negotiation and auth |
| `src/agent/__tests__/mcp-context-resolution.test.ts` | New — unit tests for @MCP and @MCPPrompt resolution |

---

### Task 1: Extend McpServerStatus with resource/prompt counts

**Files:**
- Modify: `src/ui/messages.ts:183-193`

- [ ] **Step 1: Write the failing test**

```typescript
// src/mcp/__tests__/mcp-capabilities.test.ts
import { describe, it, expect } from "vitest";
import type { McpServerStatus } from "../../ui/messages";

describe("McpServerStatus", () => {
  it("includes resourceCount and promptCount fields", () => {
    const status: McpServerStatus = {
      name: "test-server",
      connected: true,
      toolCount: 3,
      resourceCount: 5,
      promptCount: 2,
    };
    expect(status.resourceCount).toBe(5);
    expect(status.promptCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/mcp/__tests__/mcp-capabilities.test.ts
```
Expected: FAIL — "Property 'resourceCount' does not exist on type 'McpServerStatus'"

- [ ] **Step 3: Add fields to McpServerStatus in messages.ts**

Find the `McpServerStatus` interface (around line 183) and extend it:

```typescript
export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  /** Number of resources exposed by this server (0 if server doesn't support resources). */
  resourceCount: number;
  /** Number of prompt templates exposed by this server (0 if server doesn't support prompts). */
  promptCount: number;
  error?: string;
}
```

- [ ] **Step 4: Fix all callers** — `McpRegistry.getStatus()` in `src/mcp/mcp-registry.ts` builds these objects. Add `resourceCount: 0, promptCount: 0` as defaults (Task 4 will fill real values).

In `src/mcp/mcp-registry.ts`, update `getStatus()`:
```typescript
getStatus(): import("../ui/messages").McpServerStatus[] {
  const result: import("../ui/messages").McpServerStatus[] = [];
  for (const [name, toolNames] of this.registeredTools) {
    result.push({
      name,
      connected: true,
      toolCount: toolNames.length,
      resourceCount: this.resourceCounts.get(name) ?? 0,
      promptCount: this.promptCounts.get(name) ?? 0,
    });
  }
  for (const [name, error] of this.connectionErrors) {
    if (!this.registeredTools.has(name)) {
      result.push({ name, connected: false, toolCount: 0, resourceCount: 0, promptCount: 0, error });
    }
  }
  return result;
}
```

Add the two maps to the class body (before the constructor):
```typescript
private resourceCounts = new Map<string, number>();
private promptCounts = new Map<string, number>();
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run src/mcp/__tests__/mcp-capabilities.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/messages.ts src/mcp/mcp-registry.ts src/mcp/__tests__/mcp-capabilities.test.ts
git commit -m "feat(mcp): extend McpServerStatus with resourceCount and promptCount"
```

---

### Task 2: Add auth support to MCPServerConfig and MCPSSEConnection

**Files:**
- Modify: `src/mcp/mcp-client.ts:20-28` (MCPServerConfig interface)
- Modify: `src/mcp/mcp-client.ts:88-114` (MCPSSEConnection constructor and connect)

- [ ] **Step 1: Write the failing test**

Add to `src/mcp/__tests__/mcp-capabilities.test.ts`:

```typescript
import { MCPSSEConnection } from "../../mcp/mcp-client";

describe("MCPSSEConnection auth", () => {
  it("injects Authorization header from bearer auth config", () => {
    const conn = new MCPSSEConnection("http://example.com", {
      type: "bearer",
      token: "tok_abc123",
    });
    // Access private extraHeaders via type cast for testing
    const headers = (conn as unknown as { extraHeaders: Record<string, string> }).extraHeaders;
    expect(headers["Authorization"]).toBe("Bearer tok_abc123");
  });

  it("injects custom header from header auth config", () => {
    const conn = new MCPSSEConnection("http://example.com", {
      type: "header",
      name: "X-Api-Key",
      value: "secret",
    });
    const headers = (conn as unknown as { extraHeaders: Record<string, string> }).extraHeaders;
    expect(headers["X-Api-Key"]).toBe("secret");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/mcp/__tests__/mcp-capabilities.test.ts
```
Expected: FAIL — MCPSSEConnection constructor doesn't accept auth config

- [ ] **Step 3: Add MCPServerAuth type and update MCPServerConfig**

In `src/mcp/mcp-client.ts`, add before `MCPServerConfig`:

```typescript
export type MCPServerAuth =
  | { type: "bearer"; token: string }
  | { type: "header"; name: string; value: string };
```

Extend `MCPServerConfig`:
```typescript
export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  baseUrl?: string;
  transport?: "stdio" | "sse";
  url?: string;
  /** Optional authentication for SSE transport. */
  auth?: MCPServerAuth;
}
```

- [ ] **Step 4: Update MCPSSEConnection to accept auth**

Change the constructor signature in `MCPSSEConnection`:

```typescript
constructor(
  private readonly baseUrl: string,
  auth?: MCPServerAuth,
) {
  const base = baseUrl.replace(/\/$/, "");
  this.messageUrl = `${base}/message`;
  this.sseUrl = `${base}/sse`;
  if (auth?.type === "bearer") {
    this.extraHeaders = { Authorization: `Bearer ${auth.token}` };
  } else if (auth?.type === "header") {
    this.extraHeaders = { [auth.name]: auth.value };
  } else {
    this.extraHeaders = {};
  }
}

private readonly extraHeaders: Record<string, string>;
private readonly messageUrl: string;
private readonly sseUrl: string;
```

Remove the old `private readonly extraHeaders` parameter (it was the second constructor arg before). Update the SSE transport connection call in `MCPClientManager.connect()`:

```typescript
// SSE/HTTP transport
if (config.transport === "sse") {
  const url = config.url;
  if (!url) {
    throw new Error(
      `MCP server "${config.name}" requires a \`url\` field for SSE transport`,
    );
  }
  const sseConn = new MCPSSEConnection(url, config.auth);
  // ... rest unchanged
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run src/mcp/__tests__/mcp-capabilities.test.ts
```
Expected: PASS (auth tests)

- [ ] **Step 6: Commit**

```bash
git add src/mcp/mcp-client.ts src/mcp/__tests__/mcp-capabilities.test.ts
git commit -m "feat(mcp): add OAuth/Bearer auth support for SSE transport"
```

---

### Task 3: Store and gate on server capabilities from initialize response

**Files:**
- Modify: `src/mcp/mcp-client.ts` — MCPConnection interface + store capabilities

- [ ] **Step 1: Write the failing test**

Add to `src/mcp/__tests__/mcp-capabilities.test.ts`:

```typescript
describe("MCPClientManager capability negotiation", () => {
  it("getCapabilities returns empty object for unknown server", () => {
    const manager = new MCPClientManager();
    expect(manager.getCapabilities("unknown")).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/mcp/__tests__/mcp-capabilities.test.ts
```
Expected: FAIL — `getCapabilities` not a function

- [ ] **Step 3: Add MCPServerCapabilities interface and storage**

In `src/mcp/mcp-client.ts`, add after the existing interfaces:

```typescript
export interface MCPServerCapabilities {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}
```

Add `capabilities` field to `MCPConnection` interface:
```typescript
interface MCPConnection {
  config: MCPServerConfig;
  tools: MCPTool[];
  process: ChildProcess | null;
  nextId: number;
  pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  buffer: string;
  sseConnection?: MCPSSEConnection;
  /** Capabilities declared by the server in its initialize response. */
  capabilities: MCPServerCapabilities;
}
```

- [ ] **Step 4: Capture capabilities during stdio initialize handshake**

In `MCPClientManager.connect()`, the stdio path does:
```typescript
const initResult = (await this.sendRequest(config.name, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "champ-vscode", version: "0.3.0" },
})) as { capabilities?: MCPServerCapabilities };
connection.capabilities = initResult?.capabilities ?? {};
```

Update the connection object initialization to include `capabilities: {}`:
```typescript
const connection: MCPConnection = {
  config,
  tools: [],
  process: child,
  nextId: 1,
  pendingRequests: new Map(),
  buffer: "",
  capabilities: {},
};
```

- [ ] **Step 5: Add getCapabilities() public method**

```typescript
getCapabilities(serverName: string): MCPServerCapabilities {
  return this.connections.get(serverName)?.capabilities ?? {};
}
```

- [ ] **Step 6: Gate listResources and listPrompts on capabilities**

Update `listResources()`:
```typescript
async listResources(serverName: string): Promise<McpResource[]> {
  const connection = this.connections.get(serverName);
  if (!connection) return [];
  // Skip the call if the server didn't declare resources capability
  if (!connection.capabilities.resources) return [];
  try {
    const result = (await this.sendRequest(serverName, "resources/list", {})) as {
      resources?: McpResource[];
    };
    return result?.resources?.slice(0, 50) ?? [];
  } catch {
    return [];
  }
}
```

Update `listPrompts()` similarly:
```typescript
async listPrompts(serverName: string): Promise<McpPromptTemplate[]> {
  const connection = this.connections.get(serverName);
  if (!connection) return [];
  if (!connection.capabilities.prompts) return [];
  try {
    const result = (await this.sendRequest(serverName, "prompts/list", {})) as {
      prompts?: McpPromptTemplate[];
    };
    return result?.prompts ?? [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 7: Also capture capabilities in SSE MCPSSEConnection.connect()**

In `MCPSSEConnection`, add a `capabilities` property and capture from initialize:
```typescript
capabilities: MCPServerCapabilities = {};

async connect(): Promise<void> {
  this.sseAbort = new AbortController();
  void this.listenSSE();
  await new Promise<void>((r) => setTimeout(r, 100));

  const result = await this.sendRequestInternal("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "champ", version: "1" },
  }) as { capabilities?: MCPServerCapabilities };
  if (!result) throw new Error(`MCP SSE initialize failed at ${this.baseUrl}`);
  this.capabilities = result.capabilities ?? {};
  // ... rest unchanged
}
```

Then in `MCPClientManager.connect()` SSE branch, after `await sseConn.connect()`, copy capabilities:
```typescript
const stub: MCPConnection = {
  config,
  tools: sseConn.tools,
  process: null,
  nextId: 0,
  pendingRequests: new Map(),
  buffer: "",
  sseConnection: sseConn,
  capabilities: sseConn.capabilities,
};
```

- [ ] **Step 8: Run all MCP tests**

```bash
npx vitest run src/mcp/__tests__/mcp-capabilities.test.ts
```
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add src/mcp/mcp-client.ts src/mcp/__tests__/mcp-capabilities.test.ts
git commit -m "feat(mcp): store server capabilities from initialize and gate resource/prompt calls"
```

---

### Task 4: Populate resource/prompt counts in McpRegistry after connect

**Files:**
- Modify: `src/mcp/mcp-registry.ts:140-158` (registerServerTools)

- [ ] **Step 1: Write the failing test**

Add to `src/mcp/__tests__/mcp-capabilities.test.ts`:

```typescript
import { McpRegistry } from "../../mcp/mcp-registry";
import type { ToolRegistry } from "../../tools/registry";

describe("McpRegistry resource/prompt counts", () => {
  it("getStatus includes resourceCount from server", async () => {
    const mockManager = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      getConnectedServers: vi.fn().mockReturnValue(["srv"]),
      listTools: vi.fn().mockResolvedValue([]),
      listResources: vi.fn().mockResolvedValue([
        { uri: "file://a", name: "a" },
        { uri: "file://b", name: "b" },
      ]),
      listPrompts: vi.fn().mockResolvedValue([{ name: "p1" }]),
      onServerExit: undefined,
    };
    const mockToolRegistry = { register: vi.fn(), unregister: vi.fn() } as unknown as ToolRegistry;
    const mockSecretStorage = { get: vi.fn().mockResolvedValue(undefined) };

    const registry = new McpRegistry(mockManager as never, mockToolRegistry, mockSecretStorage);
    await registry.loadServers([{ name: "srv", command: "echo", transport: "stdio" }]);

    const status = registry.getStatus();
    expect(status[0].resourceCount).toBe(2);
    expect(status[0].promptCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/mcp/__tests__/mcp-capabilities.test.ts
```
Expected: FAIL — resourceCount is 0

- [ ] **Step 3: Populate resource/prompt counts after registration**

In `McpRegistry.registerServerTools()`, add after the for-loop:

```typescript
private async registerServerTools(serverName: string): Promise<void> {
  const tools = await this.manager.listTools(serverName);
  const names: string[] = [];
  this.registeredTools.set(serverName, names);

  for (const mcpTool of tools) {
    const adapter = createMcpToolAdapter(serverName, mcpTool, this.manager);
    this.toolRegistry.register(adapter);
    names.push(adapter.name);
    this.registeredTools.set(serverName, [...names]);
  }

  // Populate resource/prompt counts (uses capability-gated calls — returns [] if not supported)
  const [resources, prompts] = await Promise.all([
    this.manager.listResources(serverName).catch(() => []),
    this.manager.listPrompts(serverName).catch(() => []),
  ]);
  this.resourceCounts.set(serverName, resources.length);
  this.promptCounts.set(serverName, prompts.length);

  console.log(
    `Champ MCP: registered ${names.length} tool(s), ${resources.length} resource(s), ${prompts.length} prompt(s) from "${serverName}"`,
  );
  this.onStatusChange?.();
}
```

- [ ] **Step 4: Clear counts on unregister**

In `unregisterServerTools()`:
```typescript
private unregisterServerTools(serverName: string): void {
  const names = this.registeredTools.get(serverName) ?? [];
  for (const name of names) {
    this.toolRegistry.unregister(name);
  }
  this.registeredTools.delete(serverName);
  this.resourceCounts.delete(serverName);
  this.promptCounts.delete(serverName);
  this.onStatusChange?.();
}
```

- [ ] **Step 5: Run all MCP tests**

```bash
npx vitest run src/mcp/__tests__/mcp-capabilities.test.ts
```
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/mcp-registry.ts src/mcp/__tests__/mcp-capabilities.test.ts
git commit -m "feat(mcp): populate resource and prompt counts in registry status"
```

---

### Task 5: Add @MCP reference type to context resolver

**Files:**
- Modify: `src/agent/context-resolver.ts`
- Create: `src/agent/__tests__/mcp-context-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/__tests__/mcp-context-resolution.test.ts
import { describe, it, expect, vi } from "vitest";
import { ContextResolver } from "../context-resolver";

const makeMockRegistry = (readResult: string | null) => ({
  readResource: vi.fn().mockResolvedValue(readResult),
  getPrompt: vi.fn().mockResolvedValue(null),
  listResources: vi.fn().mockResolvedValue([]),
  listPrompts: vi.fn().mockResolvedValue([]),
  getStatus: vi.fn().mockReturnValue([]),
  loadServers: vi.fn(),
  disposeAll: vi.fn(),
  reconnect: vi.fn(),
  onStatusChange: undefined,
});

describe("ContextResolver @MCP reference", () => {
  it("parses @MCP(server:uri) reference", () => {
    const resolver = new ContextResolver({} as never, {} as never, {} as never, {} as never, makeMockRegistry("content") as never);
    const refs = resolver.parseReferences("Check @MCP(myserver:file://path/to/res)");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("mcp");
    expect(refs[0].value).toBe("myserver:file://path/to/res");
  });

  it("resolves @MCP reference by calling mcpRegistry.readResource", async () => {
    const mockRegistry = makeMockRegistry("resource content here");
    const resolver = new ContextResolver({} as never, {} as never, {} as never, {} as never, mockRegistry as never);
    const refs = [{ type: "mcp", value: "myserver:file://path/to/res", start: 0, end: 10 }];
    const result = await resolver.resolve(refs);
    expect(result[0].content).toBe("resource content here");
    expect(mockRegistry.readResource).toHaveBeenCalledWith("myserver", "file://path/to/res");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/agent/__tests__/mcp-context-resolution.test.ts
```
Expected: FAIL — `parseReferences` doesn't return mcp type

- [ ] **Step 3: Read context-resolver.ts to understand its structure**

Check the `parseReferences` method's regex map and the `resolve` method's switch/case. The resolver has a `refs` array of patterns and a dispatch in `resolve()`.

- [ ] **Step 4: Add @MCP reference type**

In `src/agent/context-resolver.ts`, find the reference type definitions and add:

```typescript
// In the REFERENCE_PATTERNS map or equivalent regex array, add (BEFORE @MCPPrompt to avoid prefix collision):
// @MCPPrompt must come before @MCP in the pattern list since @MCP is a prefix of @MCPPrompt
{ type: "mcpPrompt", regex: /@MCPPrompt\(([^)]+)\)/ },
{ type: "mcp",       regex: /@MCP\(([^)]+)\)/ },
```

Find the `parseReferences` method and ensure the pattern list has these two entries ordered with `mcpPrompt` before `mcp`.

Add the optional `mcpRegistry` dependency to the constructor (add a new optional parameter at the end — don't break existing callers):

```typescript
constructor(
  private readonly indexingService: ...,
  private readonly webSearchTool: ...,
  private readonly gitTool: ...,
  private readonly workspaceRoot: string,
  private readonly mcpRegistry?: import("../mcp/mcp-registry").McpRegistry,
) { }
```

- [ ] **Step 5: Add @MCP resolution in the resolve() method**

Find the `resolve()` method's dispatch (switch or if-else chain on `ref.type`) and add:

```typescript
case "mcp": {
  if (!this.mcpRegistry) {
    chunks.push({ type: "mcp", label: ref.value, content: "[MCP registry not available]" });
    break;
  }
  const colonIdx = ref.value.indexOf(":");
  if (colonIdx === -1) {
    chunks.push({ type: "mcp", label: ref.value, content: `[Invalid @MCP reference: missing server:uri separator]` });
    break;
  }
  const serverName = ref.value.slice(0, colonIdx);
  const uri = ref.value.slice(colonIdx + 1);
  const content = await this.mcpRegistry.readResource(serverName, uri);
  chunks.push({
    type: "mcp",
    label: `MCP resource: ${serverName}/${uri}`,
    content: content ?? `[Resource not found: ${uri} on server ${serverName}]`,
  });
  break;
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run src/agent/__tests__/mcp-context-resolution.test.ts
```
Expected: The @MCP tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/agent/context-resolver.ts src/agent/__tests__/mcp-context-resolution.test.ts
git commit -m "feat(mcp): add @MCP(server:uri) context reference type"
```

---

### Task 6: Add @MCPPrompt reference type

**Files:**
- Modify: `src/agent/context-resolver.ts`
- Modify: `src/agent/__tests__/mcp-context-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/agent/__tests__/mcp-context-resolution.test.ts`:

```typescript
describe("ContextResolver @MCPPrompt reference", () => {
  it("parses @MCPPrompt(server:name) without args", () => {
    const resolver = new ContextResolver({} as never, {} as never, {} as never, {} as never, makeMockRegistry(null) as never);
    const refs = resolver.parseReferences("Use @MCPPrompt(myserver:greeting)");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("mcpPrompt");
    expect(refs[0].value).toBe("myserver:greeting");
  });

  it("parses @MCPPrompt(server:name?k=v) with query args", () => {
    const resolver = new ContextResolver({} as never, {} as never, {} as never, {} as never, makeMockRegistry(null) as never);
    const refs = resolver.parseReferences("Use @MCPPrompt(myserver:greeting?name=Alice&lang=en)");
    expect(refs[0].value).toBe("myserver:greeting?name=Alice&lang=en");
  });

  it("resolves @MCPPrompt by calling mcpRegistry.getPrompt with parsed args", async () => {
    const mockRegistry = makeMockRegistry(null);
    mockRegistry.getPrompt = vi.fn().mockResolvedValue("Hello Alice!");
    const resolver = new ContextResolver({} as never, {} as never, {} as never, {} as never, mockRegistry as never);
    const refs = [{ type: "mcpPrompt", value: "myserver:greeting?name=Alice", start: 0, end: 10 }];
    const result = await resolver.resolve(refs);
    expect(result[0].content).toBe("Hello Alice!");
    expect(mockRegistry.getPrompt).toHaveBeenCalledWith("myserver", "greeting", { name: "Alice" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/agent/__tests__/mcp-context-resolution.test.ts
```
Expected: FAIL — mcpPrompt type not handled

- [ ] **Step 3: Add @MCPPrompt resolution**

In `resolve()`, add the mcpPrompt case:

```typescript
case "mcpPrompt": {
  if (!this.mcpRegistry) {
    chunks.push({ type: "mcpPrompt", label: ref.value, content: "[MCP registry not available]" });
    break;
  }
  // Split on first colon to get server:rest
  const colonIdx = ref.value.indexOf(":");
  if (colonIdx === -1) {
    chunks.push({ type: "mcpPrompt", label: ref.value, content: `[Invalid @MCPPrompt reference: missing server:name separator]` });
    break;
  }
  const serverName = ref.value.slice(0, colonIdx);
  const rest = ref.value.slice(colonIdx + 1);
  // Split on ? to get promptName and query string
  const qIdx = rest.indexOf("?");
  const promptName = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const queryStr = qIdx === -1 ? "" : rest.slice(qIdx + 1);
  // Parse query string into args object
  const args: Record<string, string> = {};
  if (queryStr) {
    for (const pair of queryStr.split("&")) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx !== -1) {
        args[decodeURIComponent(pair.slice(0, eqIdx))] = decodeURIComponent(pair.slice(eqIdx + 1));
      }
    }
  }
  const content = await this.mcpRegistry.getPrompt(serverName, promptName, args);
  chunks.push({
    type: "mcpPrompt",
    label: `MCP prompt: ${serverName}/${promptName}`,
    content: content ?? `[Prompt not found: ${promptName} on server ${serverName}]`,
  });
  break;
}
```

- [ ] **Step 4: Run all context resolution tests**

```bash
npx vitest run src/agent/__tests__/mcp-context-resolution.test.ts
```
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/context-resolver.ts src/agent/__tests__/mcp-context-resolution.test.ts
git commit -m "feat(mcp): add @MCPPrompt(server:name?args) context reference type"
```

---

### Task 7: Wire mcpRegistry into ContextResolver in extension.ts

**Files:**
- Modify: `src/extension.ts` — pass mcpRegistry when constructing ContextResolver

- [ ] **Step 1: Find the ContextResolver construction in extension.ts**

```bash
grep -n "new ContextResolver" /home/dk/Documents/git/vs-code-plugin/src/extension.ts
```

- [ ] **Step 2: Add mcpRegistry as the last argument**

The construction will look something like:
```typescript
const contextResolver = new ContextResolver(
  indexingService,
  webSearchTool,
  gitTool,
  workspaceRoot,
  mcpRegistry,   // ADD THIS — mcpRegistry is already a module-level singleton
);
```

- [ ] **Step 3: Run full type check**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 4: Run all tests**

```bash
npx vitest run src/mcp/ src/agent/__tests__/mcp-context-resolution.test.ts
```
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "feat(mcp): wire mcpRegistry into ContextResolver for @MCP/@MCPPrompt resolution"
```

---

### Task 8: Update McpRegistry to expose listResources/listPrompts passthrough

**Files:**
- Modify: `src/mcp/mcp-registry.ts` — already has listResources/listPrompts. Verify they use capability-gated manager calls.

- [ ] **Step 1: Verify listResources in McpRegistry delegates to manager**

Read the current implementation (around lines 181-210). It should already call `this.manager.listResources(serverName)` and `this.manager.listPrompts(serverName)`. If so, no change needed. If it calls the old uncapability-gated version, update to use the new gated version.

- [ ] **Step 2: Add listAllResources() for @MCP autocomplete**

```typescript
/** Returns all resources across all connected servers, keyed by serverName. */
async listAllResources(): Promise<Map<string, import("./mcp-client").McpResource[]>> {
  const result = new Map<string, import("./mcp-client").McpResource[]>();
  for (const serverName of this.manager.getConnectedServers()) {
    const resources = await this.manager.listResources(serverName).catch(() => []);
    if (resources.length > 0) {
      result.set(serverName, resources);
    }
  }
  return result;
}

/** Returns all prompt templates across all connected servers. */
async listAllPrompts(): Promise<Map<string, import("./mcp-client").McpPromptTemplate[]>> {
  const result = new Map<string, import("./mcp-client").McpPromptTemplate[]>();
  for (const serverName of this.manager.getConnectedServers()) {
    const prompts = await this.manager.listPrompts(serverName).catch(() => []);
    if (prompts.length > 0) {
      result.set(serverName, prompts);
    }
  }
  return result;
}
```

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run src/mcp/ src/agent/__tests__/
```
Expected: All PASS

- [ ] **Step 4: Type check**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 5: Bump version and commit**

```bash
npm version patch
git add src/mcp/mcp-registry.ts package.json
git commit -m "feat(mcp): complete protocol surface — capabilities, auth, @MCP/@MCPPrompt context refs"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All 5 gaps addressed: (1) resourceCount/promptCount in status ✓, (2) OAuth/bearer auth for SSE ✓, (3) capability negotiation + gating ✓, (4) @MCP reference type ✓, (5) @MCPPrompt reference type ✓
- [x] **Placeholder scan:** No TBD, no "implement later", all steps have actual code
- [x] **Type consistency:** `MCPServerAuth` defined in Task 2 used in Task 2; `MCPServerCapabilities` defined in Task 3 used in Task 3; `mcpRegistry` optional param added in Task 5 used in Tasks 5/6/7
- [x] **Order dependency:** `mcpPrompt` pattern registered before `mcp` in parseReferences (Task 6 Step 3 note) to avoid prefix match swallowing @MCPPrompt as @MCP
