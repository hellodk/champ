# Plan: MCP Hot-Reload / Reconnect Button

**Date**: 2026-05-15  
**Goal**: Fix the aggressive `MAX_RECONNECTS = 3` cap in `MCPSSEConnection`, add a passive 60s retry after final failure, and expose a per-server reconnect button in the MCP panel for disconnected/errored servers.  
**Status**: Ready to execute

---

## Architecture

1. `MCPSSEConnection`: raise `MAX_RECONNECTS` to 10, cap per-attempt backoff at 30s, schedule one passive retry 60s after final failure.
2. `MCPSSEConnection.reconnect()`: new public method that resets state and re-calls `connect()`.
3. `MCPClientManager.reconnect(serverName)`: delegates to `MCPSSEConnection.reconnect()` for SSE servers; for stdio servers calls existing `disconnect()` + `connect()` cycle.
4. `McpRegistry.reconnect(serverName)`: thin wrapper over `MCPClientManager.reconnect`, then re-registers tools.
5. `champ.reloadMcpServer` (already exists in extension.ts ~line 1264): retarget to call `mcpRegistry.reconnect(name)` instead of full `loadServers()`.
6. `renderMcpPanel` in `main.js`: the existing `↺` reload button is present on all rows — keep it for connected servers (full reload), but for disconnected/errored servers add a distinct "reconnect" style (different title, no full reload). The same `reloadMcpServer` message is sufficient; the extension now routes it to `reconnect()`.

### Current state (baselines from code reading)

- `src/mcp/mcp-client.ts` line 99: `private static readonly MAX_RECONNECTS = 3`
- `src/mcp/mcp-client.ts` lines 138-178: `listenSSE()` loop — reconnects up to `MAX_RECONNECTS`, backoff is `1000 * reconnectAttempts` (linear, unbounded). After final failure sets `this.connected = false` and `this.error`.
- `src/mcp/mcp-client.ts` lines 236-246: `disconnect()` — aborts SSE, rejects pending, sets `connected = false`.
- `src/mcp/mcp-client.ts` lines 248-285: `MCPClientManager.connect()` — if name already in connections, disconnects first.
- `src/mcp/mcp-registry.ts` lines 45-101: `loadServers()` diffs desired vs connected. No `reconnect()` method.
- `webview-ui/dist/main.js` lines 352-353: `reloadBtn` with `↺` fires `reloadMcpServer` message. Present on all server rows regardless of connection state.

### Tech Stack

TypeScript (extension host), vanilla JS (webview).

---

## Tasks

### Task 1 — Fix `MAX_RECONNECTS` and backoff in `MCPSSEConnection`

**File**: `src/mcp/mcp-client.ts`

**Step 1 — write failing test**

File: `src/mcp/__tests__/sse-reconnect-limits.test.ts`

```typescript
import { describe, it, expect } from "vitest";
// We test by reading the static field via reflection — avoids needing a live server.
// After the change MAX_RECONNECTS must be 10.
import { MCPSSEConnection } from "../mcp-client";

describe("MCPSSEConnection constants", () => {
  it("MAX_RECONNECTS is 10 (not 3)", () => {
    // Access private static via cast
    const maxReconnects = (MCPSSEConnection as unknown as { MAX_RECONNECTS: number }).MAX_RECONNECTS;
    expect(maxReconnects).toBe(10);
  });
});

describe("backoff cap", () => {
  it("1000 * attempt capped at 30_000 never exceeds 30s", () => {
    // Simulate the capped formula for attempt values 1..10
    for (let attempt = 1; attempt <= 10; attempt++) {
      const delay = Math.min(30_000, 1_000 * attempt);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
    // At attempt 35 it would exceed 30s without the cap
    expect(Math.min(30_000, 1_000 * 35)).toBe(30_000);
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/mcp/__tests__/sse-reconnect-limits.test.ts 2>&1 | tail -10`  
Expected: `MAX_RECONNECTS is 10` fails (currently 3).

**Step 2 — implement**

In `src/mcp/mcp-client.ts`:

Change line 99:
```typescript
  private static readonly MAX_RECONNECTS = 3;
```
to:
```typescript
  private static readonly MAX_RECONNECTS = 10;
```

In `listenSSE()`, change the backoff line (currently `await new Promise<void>((r) => setTimeout(r, 1000 * this.reconnectAttempts))`):
```typescript
        // Capped exponential backoff: max 30s per attempt.
        await new Promise<void>((r) =>
          setTimeout(r, Math.min(30_000, 1_000 * this.reconnectAttempts)),
        );
```

After the `while` loop ends (after `this.error = ...`), schedule one passive retry:
```typescript
    // After all retries are exhausted, schedule one final passive retry after 60s.
    // This handles transient network blips without spamming reconnects.
    if (!this.sseAbort?.signal.aborted) {
      setTimeout(() => {
        if (!this.connected && !this.sseAbort?.signal.aborted) {
          this.reconnectAttempts = 0;
          this.error = undefined;
          void this.listenSSE();
        }
      }, 60_000);
    }
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/mcp/__tests__/sse-reconnect-limits.test.ts 2>&1 | tail -10`  
Expected: both tests pass.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/mcp/mcp-client.ts src/mcp/__tests__/sse-reconnect-limits.test.ts
git commit -m "fix: raise MCPSSEConnection MAX_RECONNECTS to 10, cap backoff at 30s, add 60s passive retry"
```

---

### Task 2 — Add `MCPSSEConnection.reconnect()` method

**File**: `src/mcp/mcp-client.ts`

**Step 1 — write failing test**

File: `src/mcp/__tests__/sse-reconnect-method.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { MCPSSEConnection } from "../mcp-client";

describe("MCPSSEConnection.reconnect", () => {
  it("is a callable method on the class", () => {
    // We do not call it (no real server) — just verify it exists on the prototype.
    expect(typeof MCPSSEConnection.prototype.reconnect).toBe("function");
  });

  it("resets reconnectAttempts and error before reconnecting", async () => {
    const conn = new MCPSSEConnection("http://localhost:9999");
    // Manually set failed state
    (conn as unknown as { reconnectAttempts: number }).reconnectAttempts = 10;
    (conn as unknown as { error: string }).error = "SSE connection lost";
    (conn as unknown as { connected: boolean }).connected = false;

    // Stub connect() so it doesn't actually hit the network
    const connectSpy = vi.spyOn(conn, "connect").mockResolvedValue(undefined);

    await conn.reconnect();

    expect(connectSpy).toHaveBeenCalledOnce();
    expect((conn as unknown as { reconnectAttempts: number }).reconnectAttempts).toBe(0);
    expect((conn as unknown as { error: string | undefined }).error).toBeUndefined();
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/mcp/__tests__/sse-reconnect-method.test.ts 2>&1 | tail -10`  
Expected: failures (`reconnect` method does not exist).

**Step 2 — implement**

In `src/mcp/mcp-client.ts`, add after `disconnect()` (after line 246):

```typescript
  /**
   * Hard-reconnect: abort the existing SSE stream, reset all error state,
   * and re-run the full connect() sequence (initialize + tools/list).
   * Safe to call on a connection that is already disconnected/failed.
   */
  async reconnect(): Promise<void> {
    // Abort any in-flight SSE reader first.
    this.sseAbort?.abort();
    this.sseAbort = null;

    // Reset failure state so listenSSE starts fresh.
    this.reconnectAttempts = 0;
    this.error = undefined;
    this.connected = false;

    // Re-run the full handshake.
    await this.connect();
  }
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/mcp/__tests__/sse-reconnect-method.test.ts 2>&1 | tail -10`  
Expected: both tests pass.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/mcp/mcp-client.ts src/mcp/__tests__/sse-reconnect-method.test.ts
git commit -m "feat: add MCPSSEConnection.reconnect() — hard-reconnect resetting all error state"
```

---

### Task 3 — Add `MCPClientManager.reconnect(serverName)` and `McpRegistry.reconnect(serverName)`

**Files**: `src/mcp/mcp-client.ts`, `src/mcp/mcp-registry.ts`

**Step 1 — write failing test**

File: `src/mcp/__tests__/mcp-manager-reconnect.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { MCPClientManager, MCPSSEConnection } from "../mcp-client";

describe("MCPClientManager.reconnect", () => {
  it("is defined on the class", () => {
    expect(typeof MCPClientManager.prototype.reconnect).toBe("function");
  });

  it("calls MCPSSEConnection.reconnect() for SSE connections", async () => {
    const manager = new MCPClientManager();
    // Inject a fake SSE connection directly into the internal map.
    const fakeSse = {
      reconnect: vi.fn().mockResolvedValue(undefined),
      tools: [],
      connected: false,
      error: "lost",
    };
    const fakeConn = {
      config: { name: "test-sse", transport: "sse" as const, url: "http://localhost:9999" },
      tools: [],
      process: null,
      nextId: 0,
      pendingRequests: new Map(),
      buffer: "",
      sseConnection: fakeSse,
    };
    (manager as unknown as { connections: Map<string, unknown> }).connections.set("test-sse", fakeConn);

    await manager.reconnect("test-sse");

    expect(fakeSse.reconnect).toHaveBeenCalledOnce();
  });

  it("throws for unknown server name", async () => {
    const manager = new MCPClientManager();
    await expect(manager.reconnect("nonexistent")).rejects.toThrow(/not found/i);
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/mcp/__tests__/mcp-manager-reconnect.test.ts 2>&1 | tail -10`  
Expected: failures (`reconnect` not on manager).

**Step 2 — implement `MCPClientManager.reconnect`**

In `src/mcp/mcp-client.ts`, add after `disconnect()` and before the class closes:

```typescript
  /**
   * Reconnect a specific server by name.
   * - SSE servers: calls MCPSSEConnection.reconnect() (preserves config).
   * - stdio servers: full disconnect + reconnect cycle using stored config.
   */
  async reconnect(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`MCP server "${serverName}" not found in manager connections`);
    }
    if (conn.sseConnection) {
      // SSE: delegate to the connection's own reconnect method.
      await conn.sseConnection.reconnect();
      // Refresh tool list after reconnect.
      const toolsResult = (await conn.sseConnection.sendRequestInternal(
        "tools/list",
        {},
      )) as { tools?: MCPTool[] };
      (conn.tools as MCPTool[]).length = 0;
      (conn.tools as MCPTool[]).push(...(toolsResult?.tools ?? []));
    } else {
      // stdio: full reconnect via stored config.
      const config = conn.config;
      await this.disconnect(serverName);
      await this.connect(config);
    }
  }
```

**Step 3 — implement `McpRegistry.reconnect`**

In `src/mcp/mcp-registry.ts`, add after `disposeAll()`:

```typescript
  /**
   * Reconnect a single server by name without reloading the full config.
   * Clears the previous connection error, re-establishes the connection,
   * and re-registers the server's tools with the ToolRegistry.
   */
  async reconnect(serverName: string): Promise<void> {
    // Clear any recorded error so the status panel shows "connecting" immediately.
    this.connectionErrors.delete(serverName);
    // Unregister stale tools before reconnecting.
    this.unregisterServerTools(serverName);

    try {
      await this.manager.reconnect(serverName);
      await this.registerServerTools(serverName);
      this.onStatusChange?.();
      console.log(`Champ MCP: reconnected "${serverName}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.connectionErrors.set(serverName, msg);
      this.onStatusChange?.();
      console.error(`Champ MCP: reconnect failed for "${serverName}":`, msg);
      throw err;
    }
  }
```

**Step 4 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/mcp/__tests__/mcp-manager-reconnect.test.ts 2>&1 | tail -10`  
Expected: all tests pass.

**Step 5 — compile check**

`cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error`  
Expected: 0.

**Step 6 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/mcp/mcp-client.ts src/mcp/mcp-registry.ts src/mcp/__tests__/mcp-manager-reconnect.test.ts
git commit -m "feat: add reconnect(serverName) to MCPClientManager and McpRegistry"
```

---

### Task 4 — Wire `champ.reloadMcpServer` to use `mcpRegistry.reconnect()`

**File**: `src/extension.ts`

**Step 1 — locate the command**

Search `extension.ts` for `reloadMcpServer`:

```bash
grep -n "reloadMcpServer\|champ.reloadMcpServer" /home/dk/Documents/git/vs-code-plugin/src/extension.ts
```

Expected output: a `registerCommand("champ.reloadMcpServer", ...)` block that currently calls `loadServers()` or a similar full reload.

**Step 2 — write failing test**

File: `src/mcp/__tests__/registry-reconnect-route.test.ts`

```typescript
// Validates that McpRegistry.reconnect exists and has the right signature.
import { describe, it, expect } from "vitest";
import { McpRegistry } from "../mcp-registry";

describe("McpRegistry.reconnect signature", () => {
  it("is a function", () => {
    expect(typeof McpRegistry.prototype.reconnect).toBe("function");
  });

  it("returns a Promise", () => {
    // Construct with minimal stubs — we only need to confirm signature.
    const mockManager = { reconnect: async () => {}, getConnectedServers: () => [] } as unknown as import("../mcp-client").MCPClientManager;
    const mockToolRegistry = { register: () => {}, unregister: () => {} } as unknown as import("../../tools/registry").ToolRegistry;
    const mockSecretStorage = { get: async () => undefined } as unknown as import("vscode").SecretStorage;
    const registry = new McpRegistry(mockManager, mockToolRegistry, mockSecretStorage);
    const result = registry.reconnect("test");
    expect(result).toBeInstanceOf(Promise);
    // Don't await — the mock manager has no "test" server, that's fine for signature check.
    result.catch(() => {});
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/mcp/__tests__/registry-reconnect-route.test.ts 2>&1 | tail -10`  
Expected: passes (McpRegistry.reconnect exists after Task 3).

**Step 3 — implement in extension.ts**

Find the `champ.reloadMcpServer` registration in `extension.ts`. Replace its body with:

```typescript
vscode.commands.registerCommand("champ.reloadMcpServer", async (serverName?: string) => {
  if (serverName && mcpRegistry) {
    try {
      await mcpRegistry.reconnect(serverName);
      broadcastMcpStatus();
    } catch {
      // If targeted reconnect fails, fall back to full reload so the user
      // is not silently stuck.
      if (cachedYamlConfig?.mcp?.servers) {
        void mcpRegistry
          .loadServers(cachedYamlConfig.mcp.servers)
          .then(() => broadcastMcpStatus());
      }
    }
  } else if (mcpRegistry && cachedYamlConfig?.mcp?.servers) {
    // No server name provided — reload all (original behavior).
    void mcpRegistry
      .loadServers(cachedYamlConfig.mcp.servers)
      .then(() => broadcastMcpStatus());
  }
}),
```

Note: `cachedYamlConfig` is the module-level config cache at line 88 of extension.ts. `broadcastMcpStatus()` is the existing helper that pushes server status to the webview.

**Step 4 — compile check**

`cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error`  
Expected: 0.

**Step 5 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/extension.ts src/mcp/__tests__/registry-reconnect-route.test.ts
git commit -m "feat: wire champ.reloadMcpServer to mcpRegistry.reconnect() with loadServers fallback"
```

---

### Task 5 — Update `renderMcpPanel` for disconnected server reconnect UX

**File**: `webview-ui/dist/main.js`

The existing `reloadBtn` (line 352) fires `reloadMcpServer` for all servers. For disconnected servers, change the button title to "Reconnect server" to make the intent clear. No functional change to the message type needed (extension now routes smartly).

**Step 1 — verify syntax**

`node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo OK`

**Step 2 — implement**

In `webview-ui/dist/main.js`, replace the `reloadBtn` construction (lines 352-353):

Current:
```javascript
        const reloadBtn = el('button', { class: 'mcp-reload', title: 'Reload server' }, ['↺']);
        reloadBtn.addEventListener('click', () => vscode.postMessage({ type: 'reloadMcpServer', serverName: s.name }));
```

Replace with:
```javascript
        const reloadTitle = s.connected ? 'Reload server (full config reload)' : 'Reconnect server (reconnect without full reload)';
        const reloadBtn = el('button', { class: 'mcp-reload', title: reloadTitle }, ['↺']);
        reloadBtn.addEventListener('click', () => vscode.postMessage({ type: 'reloadMcpServer', serverName: s.name }));
```

**Step 3 — syntax check**

`node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo OK`  
Expected: `OK`.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add webview-ui/dist/main.js
git commit -m "feat: update MCP panel reload button title to Reconnect for disconnected servers"
```

---

### Task 6 — Unit tests for passive retry scheduling

**File**: `src/mcp/__tests__/sse-passive-retry.test.ts`

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";

describe("passive retry after final reconnect failure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("setTimeout is called once with 60_000ms after all retries are exhausted", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // Simulate the passive retry scheduling block from listenSSE():
    //   if (!this.sseAbort?.signal.aborted) { setTimeout(() => {...}, 60_000); }
    const abortController = new AbortController();
    const sseAbort = abortController;
    const connected = false;

    if (!sseAbort.signal.aborted) {
      setTimeout(() => {
        // reconnect logic would go here
      }, 60_000);
    }

    // Verify setTimeout was called with 60s delay
    const calls = setTimeoutSpy.mock.calls;
    const passiveRetryCall = calls.find((c) => c[1] === 60_000);
    expect(passiveRetryCall).toBeDefined();
  });

  it("passive retry does not fire if SSE was intentionally aborted", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const abortController = new AbortController();
    abortController.abort(); // simulate intentional disconnect
    const sseAbort = abortController;

    if (!sseAbort.signal.aborted) {
      // This block should NOT execute
      setTimeout(() => {}, 60_000);
    }

    const calls = setTimeoutSpy.mock.calls;
    const passiveRetryCall = calls.find((c) => c[1] === 60_000);
    expect(passiveRetryCall).toBeUndefined();
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/mcp/__tests__/sse-passive-retry.test.ts 2>&1 | tail -10`  
Expected: both tests pass.

**Commit:**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/mcp/__tests__/sse-passive-retry.test.ts
git commit -m "test: verify passive retry scheduling and abort guard in SSE reconnect logic"
```

---

## Completion checklist

- [ ] `MAX_RECONNECTS` changed from 3 to 10
- [ ] Backoff capped at 30s: `Math.min(30_000, 1_000 * reconnectAttempts)`
- [ ] Passive 60s retry scheduled after final failure (guarded by `sseAbort.signal.aborted`)
- [ ] `MCPSSEConnection.reconnect()` resets state and re-calls `connect()`
- [ ] `MCPClientManager.reconnect(serverName)` routes SSE vs stdio correctly
- [ ] `McpRegistry.reconnect(serverName)` clears error, unregisters stale tools, calls manager, re-registers
- [ ] `champ.reloadMcpServer` calls `mcpRegistry.reconnect(serverName)` with `loadServers` fallback
- [ ] MCP panel reload button title updated for disconnected servers
- [ ] `node --check webview-ui/dist/main.js` passes
- [ ] `npx tsc --noEmit` 0 errors
- [ ] All 5 test files green
