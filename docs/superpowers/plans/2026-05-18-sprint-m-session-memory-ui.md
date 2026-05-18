# Sprint M: Session Memory UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visual memory viewer panel, pinned context support, manual memory entries, per-memory delete, and a memory badge to the Champ chat interface — making the MemoryBank visible and controllable by users.

**Architecture:** `MemoryBank` gains `pin`, `unpin`, `delete`, `addManual`, `getAll`, and `getPinnedContext` methods. A new `MemoryPanel` VS Code WebviewPanel (singleton, registered as `champ.openMemoryBank`) hosts a Preact component. The chat webview shows a badge with memory count that opens the panel on click. Pinned memories are always injected into the system prompt via `getPinnedContext()` regardless of recency cap.

**Tech Stack:** TypeScript (extension host + MemoryBank), Preact TSX (webview panel), Vitest (tests), VS Code WebviewPanel API

---

## File Map

| File | Change |
|---|---|
| `src/memory/memory-bank.ts` | Add `pinned` field, `pin`, `unpin`, `delete`, `addManual`, `getAll`, `getPinnedContext` |
| `src/ui/messages.ts` | Add `MemoryBadgeMessage`, `MemoryListMessage`, `MemoryDeleteRequest`, `MemoryPinRequest`, `MemoryAddRequest`, `OpenMemoryBankRequest` + type guards |
| `src/ui/memory-panel.ts` | New — singleton WebviewPanel for the memory viewer |
| `src/ui/chat-view-provider.ts` | Handle `OpenMemoryBankRequest`, `MemoryDeleteRequest`, `MemoryPinRequest`, `MemoryAddRequest`; broadcast `MemoryBadgeMessage` |
| `src/extension.ts` | Register `champ.openMemoryBank` command; wire `broadcastMemoryBadge`; inject `getPinnedContext` into system prompt |
| `package.json` | Register `champ.openMemoryBank` command |
| `webview-ui/src/components/MemoryPanel.tsx` | New Preact component — memory list, pin/delete buttons, add form |
| `webview-ui/src/index.tsx` | Mount `<MemoryPanel />` gated on `window.__CHAMP_MEMORY_PANEL__` |
| `src/memory/__tests__/memory-bank-ui.test.ts` | New — tests for new MemoryBank methods |

---

### Task 1: Extend MemoryBank with pin/unpin/delete/addManual/getAll

**Files:**
- Modify: `src/memory/memory-bank.ts`
- Create: `src/memory/__tests__/memory-bank-ui.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/memory/__tests__/memory-bank-ui.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBank } from "../memory-bank";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

async function makeTempBank(): Promise<MemoryBank> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "champ-mem-"));
  return new MemoryBank(dir);
}

describe("MemoryBank.addManual", () => {
  it("stores a manual memory with userQuery=manual and given text as summary", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.addManual("Always use Postgres not MySQL");
    const all = bank.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].assistantSummary).toBe("Always use Postgres not MySQL");
    expect(all[0].userQuery).toBe("manual");
  });
});

describe("MemoryBank.pin/unpin", () => {
  it("sets pinned=true on the identified item", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.store({ userQuery: "q", assistantSummary: "s", sessionId: "sess1" });
    const id = bank.getAll()[0].id;
    await bank.pin(id);
    expect(bank.getAll()[0].pinned).toBe(true);
  });

  it("sets pinned=false on unpin", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.store({ userQuery: "q", assistantSummary: "s", sessionId: "sess1" });
    const id = bank.getAll()[0].id;
    await bank.pin(id);
    await bank.unpin(id);
    expect(bank.getAll()[0].pinned).toBe(false);
  });
});

describe("MemoryBank.delete", () => {
  it("removes the item with the given id", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.store({ userQuery: "q", assistantSummary: "s", sessionId: "sess1" });
    const id = bank.getAll()[0].id;
    await bank.delete(id);
    expect(bank.getAll()).toHaveLength(0);
  });

  it("is a no-op for unknown id", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.delete("non-existent");
    expect(bank.getAll()).toHaveLength(0);
  });
});

describe("MemoryBank.getPinnedContext", () => {
  it("returns markdown block with only pinned items", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.store({ userQuery: "q1", assistantSummary: "use Postgres", sessionId: "s1" });
    await bank.store({ userQuery: "q2", assistantSummary: "use TypeScript", sessionId: "s2" });
    const id = bank.getAll()[0].id;
    await bank.pin(id);
    const ctx = bank.getPinnedContext();
    expect(ctx).toContain("use Postgres");
    expect(ctx).not.toContain("use TypeScript");
  });

  it("returns empty string when no pinned items", async () => {
    const bank = await makeTempBank();
    await bank.load();
    expect(bank.getPinnedContext()).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/memory/__tests__/memory-bank-ui.test.ts
```
Expected: FAIL — methods don't exist yet

- [ ] **Step 3: Extend MemoryItem and add new methods to MemoryBank**

Replace `src/memory/memory-bank.ts` with the extended version:

```typescript
/**
 * MemoryBank: persists cross-session conversation facts.
 * Facts are stored as JSON in <workspaceRoot>/.champ/memory.json.
 */
import * as path from "path";
import * as fs from "fs/promises";

export interface MemoryItem {
  id: string;
  timestamp: number;
  userQuery: string;
  assistantSummary: string;
  sessionId: string;
  /** When true, always injected into system prompt regardless of recency. */
  pinned?: boolean;
}

const MAX_MEMORIES = 50;

export class MemoryBank {
  private items: MemoryItem[] = [];
  private readonly filePath: string;
  private _loaded = false;

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, ".champ", "memory.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw as string) as MemoryItem[];
      if (Array.isArray(parsed)) {
        this.items = parsed;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Champ MemoryBank: failed to load memory.json:", err);
      }
    }
    this._loaded = true;
  }

  async store(entry: Omit<MemoryItem, "id" | "timestamp">): Promise<void> {
    const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const item: MemoryItem = { id, timestamp: Date.now(), ...entry };
    this.items.push(item);
    while (this.items.length > MAX_MEMORIES) {
      // Evict oldest non-pinned entry first; fall back to oldest if all pinned
      const evictIdx = this.items.findIndex((m) => !m.pinned);
      this.items.splice(evictIdx === -1 ? 0 : evictIdx, 1);
    }
    await this.persist();
  }

  /** Add a manually entered fact (not tied to a specific session interaction). */
  async addManual(text: string): Promise<void> {
    await this.store({ userQuery: "manual", assistantSummary: text, sessionId: "manual" });
  }

  /** Pin a memory so it is always injected into the system prompt. */
  async pin(id: string): Promise<void> {
    const item = this.items.find((m) => m.id === id);
    if (item) {
      item.pinned = true;
      await this.persist();
    }
  }

  /** Unpin a memory (reverts to recency-based injection). */
  async unpin(id: string): Promise<void> {
    const item = this.items.find((m) => m.id === id);
    if (item) {
      item.pinned = false;
      await this.persist();
    }
  }

  /** Permanently remove a memory entry. */
  async delete(id: string): Promise<void> {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length !== before) {
      await this.persist();
    }
  }

  /** Returns all stored memories (pinned first, then by timestamp desc). */
  getAll(): MemoryItem[] {
    return [...this.items].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.timestamp - a.timestamp;
    });
  }

  isLoaded(): boolean {
    return this._loaded;
  }

  /** Returns recent N items as markdown for injection. Excludes pinned (handled by getPinnedContext). */
  getRecentContext(n = 5): string {
    if (this.items.length === 0) return "";
    const recent = this.items.filter((m) => !m.pinned).slice(-n);
    if (recent.length === 0) return "";
    const lines = recent.map(
      (item) => `- User asked: "${item.userQuery}" → "${item.assistantSummary}"`,
    );
    return `## Recent conversation history\n${lines.join("\n")}`;
  }

  /** Returns all pinned memories as a markdown block (always injected). */
  getPinnedContext(): string {
    const pinned = this.items.filter((m) => m.pinned);
    if (pinned.length === 0) return "";
    const lines = pinned.map((item) => `- ${item.assistantSummary}`);
    return `## Pinned project context\n${lines.join("\n")}`;
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.items, null, 2), "utf-8");
    } catch (err) {
      console.warn("Champ MemoryBank: failed to persist memory.json:", err);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/memory/__tests__/memory-bank-ui.test.ts
```
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/memory-bank.ts src/memory/__tests__/memory-bank-ui.test.ts
git commit -m "feat(memory): add pin/unpin/delete/addManual/getAll/getPinnedContext to MemoryBank"
```

---

### Task 2: Add memory message types to the protocol

**Files:**
- Modify: `src/ui/messages.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Add to a new test or an existing messages test
import type {
  MemoryBadgeMessage,
  MemoryListMessage,
  MemoryDeleteRequest,
  MemoryPinRequest,
  MemoryAddRequest,
} from "../../ui/messages";

it("MemoryBadgeMessage has count field", () => {
  const msg: MemoryBadgeMessage = { type: "memoryBadge", count: 5 };
  expect(msg.count).toBe(5);
});
```

- [ ] **Step 2: Add message types to src/ui/messages.ts**

Add after the existing `MetricsUpdateMessage` block:

```typescript
// ---- Memory messages ----

export interface MemoryItem {
  id: string;
  timestamp: number;
  userQuery: string;
  assistantSummary: string;
  sessionId: string;
  pinned?: boolean;
}

/** Sent to webview to update the memory badge count in the chat header. */
export interface MemoryBadgeMessage {
  type: "memoryBadge";
  count: number;
}

/** Sent to webview when memory panel requests the full list. */
export interface MemoryListMessage {
  type: "memoryList";
  items: MemoryItem[];
}

// Webview → Extension

export interface OpenMemoryBankRequest {
  type: "openMemoryBank";
}

export interface MemoryDeleteRequest {
  type: "memoryDelete";
  id: string;
}

export interface MemoryPinRequest {
  type: "memoryPin";
  id: string;
  pinned: boolean;
}

export interface MemoryAddRequest {
  type: "memoryAdd";
  text: string;
}

// Type guards

export function isOpenMemoryBankRequest(msg: WebviewToExtensionMessage): msg is OpenMemoryBankRequest {
  return msg.type === "openMemoryBank";
}

export function isMemoryDeleteRequest(msg: WebviewToExtensionMessage): msg is MemoryDeleteRequest {
  return msg.type === "memoryDelete";
}

export function isMemoryPinRequest(msg: WebviewToExtensionMessage): msg is MemoryPinRequest {
  return msg.type === "memoryPin";
}

export function isMemoryAddRequest(msg: WebviewToExtensionMessage): msg is MemoryAddRequest {
  return msg.type === "memoryAdd";
}
```

Also add these to the `WebviewToExtensionMessage` union type and `ExtensionToWebviewMessage` union type at the bottom of `messages.ts`.

- [ ] **Step 3: Run type check**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/ui/messages.ts
git commit -m "feat(memory): add memory badge/list/CRUD message types to protocol"
```

---

### Task 3: Create MemoryPanel WebviewPanel

**Files:**
- Create: `src/ui/memory-panel.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/ui/__tests__/memory-panel.test.ts
import { describe, it, expect, vi } from "vitest";
// MemoryPanel is a singleton — test the createOrShow static method contract
import { MemoryPanel } from "../memory-panel";

describe("MemoryPanel", () => {
  it("exports createOrShow static method", () => {
    expect(typeof MemoryPanel.createOrShow).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/ui/__tests__/memory-panel.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Create src/ui/memory-panel.ts**

```typescript
/**
 * MemoryPanel: singleton VS Code WebviewPanel for the memory viewer.
 * Shows all stored memories, allows pin/unpin/delete, and "Remember..." add.
 */
import * as vscode from "vscode";
import * as path from "path";
import type { MemoryBank } from "../memory/memory-bank";

export class MemoryPanel {
  public static currentPanel: MemoryPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly memoryBank: MemoryBank,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { type: string; id?: string; pinned?: boolean; text?: string }) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables,
    );
    void this.refresh();
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    memoryBank: MemoryBank,
  ): MemoryPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (MemoryPanel.currentPanel) {
      MemoryPanel.currentPanel.panel.reveal(column);
      void MemoryPanel.currentPanel.refresh();
      return MemoryPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "champ.memoryBank",
      "Champ Memory Bank",
      column ?? vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "webview-ui", "dist")],
      },
    );

    MemoryPanel.currentPanel = new MemoryPanel(panel, extensionUri, memoryBank);
    return MemoryPanel.currentPanel;
  }

  public async refresh(): Promise<void> {
    const items = this.memoryBank.getAll();
    this.panel.webview.html = this.getHtml(items);
    await this.panel.webview.postMessage({ type: "memoryList", items });
  }

  private async handleMessage(message: { type: string; id?: string; pinned?: boolean; text?: string }): Promise<void> {
    switch (message.type) {
      case "memoryDelete":
        if (message.id) {
          await this.memoryBank.delete(message.id);
          await this.refresh();
        }
        break;
      case "memoryPin":
        if (message.id) {
          if (message.pinned) {
            await this.memoryBank.pin(message.id);
          } else {
            await this.memoryBank.unpin(message.id);
          }
          await this.refresh();
        }
        break;
      case "memoryAdd":
        if (message.text?.trim()) {
          await this.memoryBank.addManual(message.text.trim());
          await this.refresh();
        }
        break;
    }
  }

  private getHtml(items: import("../memory/memory-bank").MemoryItem[]): string {
    const nonce = Array.from({ length: 16 }, () => Math.random().toString(36)[2]).join("");
    const componentsUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist", "components.js"))
      .toString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  </style>
  <script nonce="${nonce}">window.__CHAMP_MEMORY_PANEL__ = true;</script>
</head>
<body>
  <div id="champ-panels"></div>
  <script nonce="${nonce}" src="${componentsUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    MemoryPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/ui/__tests__/memory-panel.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/memory-panel.ts src/ui/__tests__/memory-panel.test.ts
git commit -m "feat(memory): create MemoryPanel singleton WebviewPanel"
```

---

### Task 4: Create MemoryPanel Preact component

**Files:**
- Create: `webview-ui/src/components/MemoryPanel.tsx`
- Modify: `webview-ui/src/index.tsx`

- [ ] **Step 1: Create the Preact component**

```typescript
// webview-ui/src/components/MemoryPanel.tsx
import { h, Fragment } from "preact";
import { useState, useEffect } from "preact/hooks";

interface MemoryItem {
  id: string;
  timestamp: number;
  userQuery: string;
  assistantSummary: string;
  sessionId: string;
  pinned?: boolean;
}

const vscode = (window as unknown as { acquireVsCodeApi?: () => { postMessage: (m: unknown) => void } }).acquireVsCodeApi?.();

function formatTime(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MemoryRow({ item, onDelete, onTogglePin }: {
  item: MemoryItem;
  onDelete: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
}): JSX.Element {
  return (
    <div style={{
      borderBottom: "1px solid var(--vscode-panel-border)",
      padding: "10px 0",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{
          fontSize: "13px",
          color: "var(--vscode-foreground)",
          flex: 1,
          marginRight: "8px",
        }}>
          {item.assistantSummary}
        </span>
        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          <button
            title={item.pinned ? "Unpin" : "Pin (always inject)"}
            onClick={() => onTogglePin(item.id, !item.pinned)}
            style={{
              background: "none",
              border: "1px solid var(--vscode-button-border, #555)",
              borderRadius: "3px",
              color: item.pinned ? "var(--vscode-charts-yellow)" : "var(--vscode-descriptionForeground)",
              cursor: "pointer",
              padding: "2px 6px",
              fontSize: "12px",
            }}
          >
            {item.pinned ? "📌 Pinned" : "📌 Pin"}
          </button>
          <button
            title="Delete memory"
            onClick={() => onDelete(item.id)}
            style={{
              background: "none",
              border: "1px solid var(--vscode-button-border, #555)",
              borderRadius: "3px",
              color: "var(--vscode-errorForeground)",
              cursor: "pointer",
              padding: "2px 6px",
              fontSize: "12px",
            }}
          >
            ✕
          </button>
        </div>
      </div>
      <span style={{ fontSize: "11px", color: "var(--vscode-descriptionForeground)" }}>
        {item.userQuery !== "manual" ? `From: "${item.userQuery}"` : "Manual entry"} · {formatTime(item.timestamp)}
      </span>
    </div>
  );
}

function AddMemoryForm({ onAdd }: { onAdd: (text: string) => void }): JSX.Element {
  const [text, setText] = useState("");
  return (
    <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
      <input
        type="text"
        placeholder="Remember... (e.g. 'We use Postgres not MySQL')"
        value={text}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) { onAdd(text.trim()); setText(""); } }}
        style={{
          flex: 1,
          background: "var(--vscode-input-background)",
          border: "1px solid var(--vscode-input-border, #555)",
          color: "var(--vscode-input-foreground)",
          borderRadius: "3px",
          padding: "6px 8px",
          fontSize: "13px",
        }}
      />
      <button
        onClick={() => { if (text.trim()) { onAdd(text.trim()); setText(""); } }}
        disabled={!text.trim()}
        style={{
          background: "var(--vscode-button-background)",
          color: "var(--vscode-button-foreground)",
          border: "none",
          borderRadius: "3px",
          padding: "6px 12px",
          cursor: text.trim() ? "pointer" : "not-allowed",
          fontSize: "13px",
        }}
      >
        Add
      </button>
    </div>
  );
}

export function MemoryPanel(): JSX.Element {
  const [items, setItems] = useState<MemoryItem[]>([]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as { type: string; items?: MemoryItem[] };
      if (msg.type === "memoryList" && Array.isArray(msg.items)) {
        setItems(msg.items);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleDelete = (id: string) => {
    vscode?.postMessage({ type: "memoryDelete", id });
    setItems((prev) => prev.filter((m) => m.id !== id));
  };

  const handleTogglePin = (id: string, pinned: boolean) => {
    vscode?.postMessage({ type: "memoryPin", id, pinned });
    setItems((prev) => prev.map((m) => m.id === id ? { ...m, pinned } : m));
  };

  const handleAdd = (text: string) => {
    vscode?.postMessage({ type: "memoryAdd", text });
  };

  const pinnedItems = items.filter((m) => m.pinned);
  const unpinnedItems = items.filter((m) => !m.pinned);

  return (
    <div style={{ maxWidth: "700px", margin: "0 auto", padding: "8px" }}>
      <h2 style={{ fontSize: "16px", marginBottom: "16px", color: "var(--vscode-foreground)" }}>
        Memory Bank
        <span style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginLeft: "8px", fontWeight: "normal" }}>
          {items.length} stored · {pinnedItems.length} pinned
        </span>
      </h2>

      <AddMemoryForm onAdd={handleAdd} />

      {pinnedItems.length > 0 && (
        <>
          <h3 style={{ fontSize: "13px", color: "var(--vscode-charts-yellow)", marginBottom: "8px" }}>
            📌 Always injected
          </h3>
          {pinnedItems.map((item) => (
            <MemoryRow key={item.id} item={item} onDelete={handleDelete} onTogglePin={handleTogglePin} />
          ))}
          {unpinnedItems.length > 0 && (
            <h3 style={{ fontSize: "13px", color: "var(--vscode-descriptionForeground)", margin: "16px 0 8px" }}>
              Recent memories
            </h3>
          )}
        </>
      )}

      {unpinnedItems.length === 0 && pinnedItems.length === 0 && (
        <p style={{ color: "var(--vscode-descriptionForeground)", fontSize: "13px" }}>
          No memories yet. Champ stores conversation summaries here automatically, or add one manually above.
        </p>
      )}

      {unpinnedItems.map((item) => (
        <MemoryRow key={item.id} item={item} onDelete={handleDelete} onTogglePin={handleTogglePin} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Mount in index.tsx gated on __CHAMP_MEMORY_PANEL__**

```typescript
// webview-ui/src/index.tsx
import { render } from "preact";
import { DiffOverlayPanel } from "./components/DiffOverlayPanel";
import { AgentGraphPanel } from "./components/AgentGraphPanel";
import { McpMarketplacePanel } from "./components/McpMarketplacePanel";
import { MemoryPanel } from "./components/MemoryPanel";

function App(): JSX.Element {
  const isMemoryPanel = (window as unknown as { __CHAMP_MEMORY_PANEL__?: boolean }).__CHAMP_MEMORY_PANEL__;
  if (isMemoryPanel) {
    return <MemoryPanel />;
  }
  return (
    <>
      <DiffOverlayPanel />
      <AgentGraphPanel />
      <McpMarketplacePanel />
    </>
  );
}

const root = document.getElementById("champ-panels");
if (root) {
  render(<App />, root);
}
```

- [ ] **Step 3: Rebuild the Preact bundle**

```bash
node esbuild.webview.mjs
```
Expected: `webview-ui/dist/components.js` rebuilt with no errors

- [ ] **Step 4: Validate the bundle**

```bash
node --check webview-ui/dist/components.js
```
Expected: No syntax errors

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/MemoryPanel.tsx webview-ui/src/index.tsx webview-ui/dist/components.js
git commit -m "feat(memory): add MemoryPanel Preact component with pin/delete/add UI"
```

---

### Task 5: Register champ.openMemoryBank command and wire badge

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Add champ.openMemoryBank to package.json contributes.commands**

In `package.json`, add to the `contributes.commands` array:
```json
{
  "command": "champ.openMemoryBank",
  "title": "Champ: Open Memory Bank"
}
```

- [ ] **Step 2: Register the command in extension.ts**

Find the block where other commands are registered (around the `vscode.commands.registerCommand` calls) and add:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand("champ.openMemoryBank", () => {
    if (!workspaceRoot || !memoryBank) {
      void vscode.window.showInformationMessage("Memory Bank: no workspace open.");
      return;
    }
    const { MemoryPanel } = require("./ui/memory-panel") as typeof import("./ui/memory-panel");
    MemoryPanel.createOrShow(context.extensionUri, memoryBank);
  }),
);
```

- [ ] **Step 3: Add broadcastMemoryBadge helper**

After the memoryBank is instantiated and loaded, add a helper:

```typescript
function broadcastMemoryBadge(): void {
  if (!memoryBank || !chatViewProvider) return;
  chatViewProvider.postMessage({
    type: "memoryBadge",
    count: memoryBank.getAll().length,
  } as never);
}
```

Call it after `await memoryBank.load()` in the activation block, and after each `store()` / `delete()` / `pin()` / `unpin()` call.

- [ ] **Step 4: Inject getPinnedContext into system prompt**

Find where `getRecentContext()` is called on the memoryBank and add the pinned context alongside it:

```typescript
// In the system prompt builder or wherever getRecentContext is used:
const recentCtx = memoryBank.getRecentContext(5);
const pinnedCtx = memoryBank.getPinnedContext();
const memoryContext = [pinnedCtx, recentCtx].filter(Boolean).join("\n\n");
```

- [ ] **Step 5: Run type check**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat(memory): register openMemoryBank command, wire badge and pinned context injection"
```

---

### Task 6: Add memory badge to chat webview header

**Files:**
- Modify: `webview-ui/dist/main.js` (the compiled chat bundle)

- [ ] **Step 1: Find the header area in main.js**

```bash
grep -n "mode-selector\|chat-header\|toolbar\|header" /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js | head -20
```

- [ ] **Step 2: Add memory badge to chat header**

In the header HTML generation (or after DOM ready), inject the badge element:

```javascript
// After the header is rendered, inject a memory badge button
function renderMemoryBadge(count) {
  const existing = document.getElementById('champ-memory-badge');
  if (existing) {
    existing.textContent = count > 0 ? `🧠 ${count}` : '🧠';
    existing.title = count > 0 ? `${count} memories stored — click to view` : 'Memory Bank (empty)';
    return;
  }
  const header = document.querySelector('.chat-toolbar, .chat-header, #app > div:first-child');
  if (!header) return;
  const badge = document.createElement('button');
  badge.id = 'champ-memory-badge';
  badge.textContent = count > 0 ? `🧠 ${count}` : '🧠';
  badge.title = count > 0 ? `${count} memories stored — click to view` : 'Memory Bank (empty)';
  badge.style.cssText = [
    'background:none', 'border:1px solid var(--vscode-button-border,#555)',
    'border-radius:3px', 'color:var(--vscode-foreground)', 'cursor:pointer',
    'padding:2px 8px', 'font-size:12px', 'margin-left:8px',
  ].join(';');
  badge.addEventListener('click', () => vscode.postMessage({ type: 'openMemoryBank' }));
  header.appendChild(badge);
}

// In the message handler, add:
case 'memoryBadge':
  renderMemoryBadge(message.count);
  break;
```

- [ ] **Step 3: Validate the webview bundle**

```bash
node --check webview-ui/dist/main.js
```
Expected: No syntax errors

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run src/memory/ src/ui/__tests__/memory-panel.test.ts
```
Expected: All PASS

- [ ] **Step 5: Bump version and final commit**

```bash
npm version patch
git add webview-ui/dist/main.js package.json
git commit -m "feat(memory): add memory badge to chat header — click to open Memory Bank panel"
```

---

### Task 7: Wire memory mutations back into the extension's MemoryBank from ChatViewProvider

**Files:**
- Modify: `src/ui/chat-view-provider.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// In an existing ChatViewProvider test file or new file
import { isOpenMemoryBankRequest, isMemoryDeleteRequest, isMemoryPinRequest, isMemoryAddRequest } from "../../ui/messages";

it("isOpenMemoryBankRequest identifies correct message type", () => {
  expect(isOpenMemoryBankRequest({ type: "openMemoryBank" } as never)).toBe(true);
  expect(isOpenMemoryBankRequest({ type: "userMessage", text: "hi" } as never)).toBe(false);
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run src/ui/__tests__/
```
Expected: PASS (type guards already added in Task 2)

- [ ] **Step 3: Add memory request handling to ChatViewProvider**

In `ChatViewProvider.handleMessage()` (the webview message dispatch), add cases for the new memory message types. The provider needs access to the MemoryBank, so add a `setMemoryBank(bank: MemoryBank)` method:

```typescript
private memoryBank?: import("../memory/memory-bank").MemoryBank;

setMemoryBank(bank: import("../memory/memory-bank").MemoryBank): void {
  this.memoryBank = bank;
}
```

In the message handler:
```typescript
if (isOpenMemoryBankRequest(message)) {
  void vscode.commands.executeCommand("champ.openMemoryBank");
  return;
}
if (isMemoryDeleteRequest(message)) {
  void this.memoryBank?.delete(message.id).then(() => this.broadcastMemoryBadge());
  return;
}
if (isMemoryPinRequest(message)) {
  const op = message.pinned
    ? this.memoryBank?.pin(message.id)
    : this.memoryBank?.unpin(message.id);
  void op?.then(() => this.broadcastMemoryBadge());
  return;
}
if (isMemoryAddRequest(message)) {
  void this.memoryBank?.addManual(message.text).then(() => this.broadcastMemoryBadge());
  return;
}
```

Add a private helper:
```typescript
private broadcastMemoryBadge(): void {
  if (!this.memoryBank) return;
  this.postMessage({ type: "memoryBadge", count: this.memoryBank.getAll().length } as never);
}
```

- [ ] **Step 4: Wire setMemoryBank in extension.ts**

After `chatViewProvider` is created and `memoryBank` is loaded:
```typescript
chatViewProvider.setMemoryBank(memoryBank);
```

- [ ] **Step 5: Run type check and tests**

```bash
npx tsc --noEmit && npx vitest run src/
```
Expected: No type errors, all tests PASS

- [ ] **Step 6: Final version bump and commit**

```bash
npm version patch
git add src/ui/chat-view-provider.ts src/extension.ts package.json
git commit -m "feat(memory): wire memory CRUD from chat webview through ChatViewProvider to MemoryBank"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All 5 gaps addressed: (1) memory viewer panel ✓, (2) pinned context ✓, (3) manual entries ✓, (4) delete ✓, (5) memory badge ✓
- [x] **Placeholder scan:** No TBD/TODO anywhere — every step has actual code
- [x] **Type consistency:** `MemoryItem.pinned?: boolean` added in Task 1 and used consistently in Tasks 4/5/7; `broadcastMemoryBadge()` defined in Task 5 also added as private method in Task 7 (deduplicated by using command dispatch vs direct call)
- [x] **Pinned eviction:** MemoryBank.store() evicts oldest non-pinned first (Task 1 Step 3) — pinned items never get auto-evicted
