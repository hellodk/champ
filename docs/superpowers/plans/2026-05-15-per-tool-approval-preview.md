# Plan: Per-Tool Approval Preview

**Date**: 2026-05-15  
**Goal**: Show a readable diff preview (for `edit_file`) or formatted command (for `run_terminal_cmd`) alongside the approval dialog instead of raw JSON args.  
**Status**: Ready to execute

---

## Architecture

Extend `ApprovalRequestMessage` with an optional `preview` field. Each tool that wants a rich preview implements `getPreview(args)`. `ToolRegistry.execute()` calls it before invoking `requestApproval`. The webview `showApprovalDialog()` renders the preview as an inline diff (using existing `.diff-line del/add` CSS classes and `splitHunks`) or a `<pre><code>` block.

### Current state (baselines from code reading)

- `src/tools/types.ts` lines 46-64: `Tool` interface has `name`, `description`, `parameters`, `requiresApproval`, `execute`. No `getPreview`.
- `src/tools/registry.ts` lines 57-67: approval check calls `context.requestApproval(...)` with a raw `JSON.stringify(args, null, 2)` string — no preview object.
- `src/ui/messages.ts` lines 47-51: `ApprovalRequestMessage` has `type`, `id`, `description`. No `preview` field.
- `webview-ui/dist/main.js` lines 1569-1612: `showApprovalDialog(id, description)` builds a `div.approval-desc` from the `description` string only.
- `webview-ui/dist/main.js` lines 1900-1930: `editSummary` case uses `splitHunks(old, new)` and `.diff-line del/add` CSS — reuse these.
- `src/utils/diff-utils.ts` line 16: `splitIntoHunks(oldText, newText): Hunk[]` — each `Hunk` has `oldLines[]` and `newLines[]`.

### Tech Stack

TypeScript (extension host), vanilla JS (webview), existing CSS variables.

---

## Tasks

### Task 1 — Extend type contracts

**Files**: `src/tools/types.ts`, `src/ui/messages.ts`

**Step 1 — write failing test**

File: `src/tools/__tests__/preview-types.test.ts`

```typescript
// Compile-time test: verify the new optional fields exist on the interfaces.
// If types.ts or messages.ts don't have the new fields, tsc will error.
import type { Tool } from "../types";
import type { ApprovalRequestMessage } from "../../ui/messages";

// Tool must accept an optional getPreview method
const _tool: Tool = {
  name: "test",
  description: "test",
  parameters: { type: "object", properties: {} },
  requiresApproval: false,
  getPreview: (args) => ({
    type: "command" as const,
    content: String(args.command),
    label: "Run",
  }),
  async execute() {
    return { success: true, output: "" };
  },
};

// ApprovalRequestMessage must accept preview
const _msg: ApprovalRequestMessage = {
  type: "approvalRequest",
  id: "test-id",
  description: "desc",
  preview: { type: "diff", content: "-old\n+new" },
};

export {};
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep preview-types`  
Expected: type errors (fields don't exist yet).

**Step 2 — implement**

In `src/tools/types.ts`, after the closing brace of the `ToolResult` interface and before the `Tool` interface, add the preview type alias. Then add `getPreview?` to `Tool`:

```typescript
// Insert after line 40 (end of ToolResult interface):

/**
 * Optional rich preview that a tool can produce before approval.
 * The webview renders this instead of (or alongside) raw JSON args.
 */
export interface ToolPreview {
  /** "diff" renders inline red/green lines; "command" renders a <pre><code> block. */
  type: "diff" | "command";
  /** Formatted content: unified-diff lines for "diff", shell command string for "command". */
  content: string;
  /** Short label shown above the preview block. Defaults to tool name if absent. */
  label?: string;
}
```

In `src/tools/types.ts`, add to the `Tool` interface after `requiresApproval`:

```typescript
  /**
   * Optional: return a structured preview of what this tool will do.
   * Called by ToolRegistry before showing the approval dialog so the webview
   * can render a human-readable preview instead of raw JSON args.
   */
  getPreview?(args: Record<string, unknown>): ToolPreview | undefined;
```

In `src/ui/messages.ts`, update `ApprovalRequestMessage`:

```typescript
export interface ApprovalRequestMessage {
  type: "approvalRequest";
  id: string;
  description: string;
  /**
   * Optional structured preview produced by the tool's getPreview() method.
   * The webview renders this instead of the raw description JSON.
   */
  preview?: {
    type: "diff" | "command";
    content: string;
    label?: string;
  };
}
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error`  
Expected: 0 errors.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/tools/types.ts src/ui/messages.ts src/tools/__tests__/preview-types.test.ts
git commit -m "feat: add ToolPreview interface and preview field to ApprovalRequestMessage"
```

---

### Task 2 — Implement `getPreview` in `edit-file.ts`

**File**: `src/tools/edit-file.ts`

**Step 1 — write failing test**

File: `src/tools/__tests__/edit-file-preview.test.ts`

```typescript
import { describe, it, expect } from "vitest";
// Import the tool object directly (not the class — edit-file exports a const)
import { editFileTool } from "../edit-file";

describe("editFileTool.getPreview", () => {
  it("returns a diff preview with type='diff'", () => {
    const preview = editFileTool.getPreview?.({
      path: "src/foo.ts",
      old_content: "const x = 1;\n",
      new_content: "const x = 2;\n",
    });
    expect(preview).toBeDefined();
    expect(preview!.type).toBe("diff");
    expect(preview!.content).toContain("-");
    expect(preview!.content).toContain("+");
  });

  it("returns undefined when old_content === new_content", () => {
    const preview = editFileTool.getPreview?.({
      path: "src/foo.ts",
      old_content: "same\n",
      new_content: "same\n",
    });
    // identical content produces empty hunks → undefined
    expect(preview).toBeUndefined();
  });

  it("limits output to 5 hunks", () => {
    // Build a string with 10 distinct changes separated by equal lines
    const old_lines: string[] = [];
    const new_lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      old_lines.push(`old_${i}`);
      new_lines.push(`new_${i}`);
      // add 5 equal context lines to force separate hunks
      for (let j = 0; j < 5; j++) {
        old_lines.push(`ctx_${i}_${j}`);
        new_lines.push(`ctx_${i}_${j}`);
      }
    }
    const preview = editFileTool.getPreview?.({
      path: "src/foo.ts",
      old_content: old_lines.join("\n"),
      new_content: new_lines.join("\n"),
    });
    expect(preview).toBeDefined();
    // Content should not contain more than 5 hunk markers
    const minusLines = (preview!.content.match(/^-/gm) ?? []).length;
    expect(minusLines).toBeLessThanOrEqual(5);
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/tools/__tests__/edit-file-preview.test.ts 2>&1 | tail -10`  
Expected: test failures (no `getPreview` yet).

**Step 2 — implement**

In `src/tools/edit-file.ts`, add the import for `splitIntoHunks` at the top:

```typescript
import { splitIntoHunks } from "../utils/diff-utils";
import type { ToolPreview } from "./types";
```

Add `getPreview` to the tool object (after `requiresApproval: true,` and before `execute`):

```typescript
  getPreview(args: Record<string, unknown>): ToolPreview | undefined {
    const oldContent = (args.old_content as string) ?? "";
    const newContent = (args.new_content as string) ?? "";
    const filePath = (args.path as string) ?? "file";

    const hunks = splitIntoHunks(oldContent, newContent);
    if (hunks.length === 0) return undefined;

    // Render at most 5 hunks to keep the dialog compact.
    const lines: string[] = [];
    for (const hunk of hunks.slice(0, 5)) {
      for (const l of hunk.oldLines) lines.push(`-${l}`);
      for (const l of hunk.newLines) lines.push(`+${l}`);
      lines.push(""); // blank separator between hunks
    }
    if (hunks.length > 5) {
      lines.push(`… (${hunks.length - 5} more hunk(s) not shown)`);
    }

    return {
      type: "diff",
      content: lines.join("\n"),
      label: `Edit: ${filePath}`,
    };
  },
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/tools/__tests__/edit-file-preview.test.ts 2>&1 | tail -10`  
Expected: all 3 tests pass.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/tools/edit-file.ts src/tools/__tests__/edit-file-preview.test.ts
git commit -m "feat: add getPreview to edit-file tool — returns diff of old vs new content"
```

---

### Task 3 — Implement `getPreview` in `run-terminal.ts`

**File**: `src/tools/run-terminal.ts`

**Step 1 — write failing test**

File: `src/tools/__tests__/run-terminal-preview.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { runTerminalTool } from "../run-terminal";

describe("runTerminalTool.getPreview", () => {
  it("returns a command preview with type='command'", () => {
    const preview = runTerminalTool.getPreview?.({
      command: "npm test",
      timeout: 30000,
    });
    expect(preview).toBeDefined();
    expect(preview!.type).toBe("command");
    expect(preview!.content).toBe("npm test");
    expect(preview!.label).toBe("Run terminal");
  });

  it("returns undefined when command arg is missing", () => {
    const preview = runTerminalTool.getPreview?.({});
    expect(preview).toBeUndefined();
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/tools/__tests__/run-terminal-preview.test.ts 2>&1 | tail -10`  
Expected: failures.

**Step 2 — implement**

Add import at top of `src/tools/run-terminal.ts`:

```typescript
import type { ToolPreview } from "./types";
```

Add `getPreview` to the tool object after `requiresApproval: true,`:

```typescript
  getPreview(args: Record<string, unknown>): ToolPreview | undefined {
    const command = args.command as string | undefined;
    if (!command) return undefined;
    return {
      type: "command",
      content: command,
      label: "Run terminal",
    };
  },
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/tools/__tests__/run-terminal-preview.test.ts 2>&1 | tail -10`  
Expected: 2 tests pass.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/tools/run-terminal.ts src/tools/__tests__/run-terminal-preview.test.ts
git commit -m "feat: add getPreview to run-terminal tool — returns command string preview"
```

---

### Task 4 — Update `ToolRegistry.execute()` to pass preview

**File**: `src/tools/registry.ts`

**Step 1 — write failing test**

File: `src/tools/__tests__/registry-preview.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../registry";
import type { Tool, ToolExecutionContext } from "../types";

describe("ToolRegistry.execute preview passthrough", () => {
  it("passes preview to requestApproval when tool has getPreview", async () => {
    const registry = new ToolRegistry();
    const captured: { description: string; preview?: unknown }[] = [];

    const mockTool: Tool = {
      name: "mock_tool",
      description: "mock",
      parameters: { type: "object", properties: {} },
      requiresApproval: true,
      getPreview: (args) => ({
        type: "command" as const,
        content: String(args.cmd),
        label: "Mock",
      }),
      async execute() {
        return { success: true, output: "ok" };
      },
    };
    registry.register(mockTool);

    const ctx: ToolExecutionContext = {
      workspaceRoot: "/tmp",
      abortSignal: new AbortController().signal,
      reportProgress: () => {},
      requestApproval: async (description, preview) => {
        captured.push({ description, preview });
        return true;
      },
    };

    await registry.execute("mock_tool", { cmd: "ls" }, ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0].preview).toEqual({
      type: "command",
      content: "ls",
      label: "Mock",
    });
  });

  it("passes no preview when tool has no getPreview", async () => {
    const registry = new ToolRegistry();
    const captured: { preview?: unknown }[] = [];

    const mockTool: Tool = {
      name: "simple_tool",
      description: "simple",
      parameters: { type: "object", properties: {} },
      requiresApproval: true,
      async execute() {
        return { success: true, output: "ok" };
      },
    };
    registry.register(mockTool);

    const ctx: ToolExecutionContext = {
      workspaceRoot: "/tmp",
      abortSignal: new AbortController().signal,
      reportProgress: () => {},
      requestApproval: async (description, preview) => {
        captured.push({ preview });
        return true;
      },
    };

    await registry.execute("simple_tool", {}, ctx);
    expect(captured[0].preview).toBeUndefined();
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/tools/__tests__/registry-preview.test.ts 2>&1 | tail -15`  
Expected: type errors + test failures.

**Step 2 — implement**

Update `ToolExecutionContext.requestApproval` in `src/tools/types.ts` to accept an optional second argument:

```typescript
  /** Request user approval for a destructive action. */
  requestApproval: (
    description: string,
    preview?: { type: "diff" | "command"; content: string; label?: string },
  ) => Promise<boolean>;
```

Update `ToolRegistry.execute()` in `src/tools/registry.ts` (lines 57-67):

```typescript
    if (tool.requiresApproval) {
      const preview = tool.getPreview?.(args);
      const approved = await context.requestApproval(
        `Tool "${name}" wants to execute with args: ${JSON.stringify(args, null, 2)}`,
        preview,
      );
      if (!approved) {
        return {
          success: false,
          output: `User denied execution of tool "${name}".`,
        };
      }
    }
```

Update `buildApprovalCallback()` in `src/ui/chat-view-provider.ts` to accept and forward the preview. The current signature at line 592:

```typescript
  private buildApprovalCallback(): (description: string) => Promise<boolean> {
    return (description: string) =>
      new Promise<boolean>((resolve) => {
        const id = `approval_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 9)}`;
        this.pendingApprovals.set(id, resolve);
        this.postMessage({
          type: "approvalRequest",
          id,
          description,
        });
      });
  }
```

Replace with:

```typescript
  private buildApprovalCallback(): (
    description: string,
    preview?: { type: "diff" | "command"; content: string; label?: string },
  ) => Promise<boolean> {
    return (description, preview) =>
      new Promise<boolean>((resolve) => {
        const id = `approval_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 9)}`;
        this.pendingApprovals.set(id, resolve);
        this.postMessage({
          type: "approvalRequest",
          id,
          description,
          ...(preview ? { preview } : {}),
        });
      });
  }
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/tools/__tests__/registry-preview.test.ts 2>&1 | tail -10`  
Expected: 2 tests pass.

**Step 4 — compile check**

`cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error`  
Expected: 0.

**Step 5 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/tools/types.ts src/tools/registry.ts src/ui/chat-view-provider.ts src/tools/__tests__/registry-preview.test.ts
git commit -m "feat: pass tool preview through ToolRegistry and buildApprovalCallback to webview message"
```

---

### Task 5 — Render preview in webview `showApprovalDialog`

**File**: `webview-ui/dist/main.js`

**Step 1 — verify syntax first**

`node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo OK`  
Expected: `OK`.

**Step 2 — implement**

In `webview-ui/dist/main.js`, replace `showApprovalDialog`:

Current (lines 1569-1612):
```javascript
  function showApprovalDialog(id, description) {
    // If session auto-approve is active, approve immediately.
    if (sessionAutoApprove) {
      vscode.postMessage({ type: 'approvalResponse', id, approved: true });
      return;
    }

    const dialog = el('div', { class: 'approval-dialog' });
    const desc = el('div', { class: 'approval-desc' }, [description]);
    const btnRow = el('div', { class: 'approval-btns' });
```

Replace with:
```javascript
  function showApprovalDialog(id, description, preview) {
    // If session auto-approve is active, approve immediately.
    if (sessionAutoApprove) {
      vscode.postMessage({ type: 'approvalResponse', id, approved: true });
      return;
    }

    const dialog = el('div', { class: 'approval-dialog' });
    const desc = el('div', { class: 'approval-desc' }, [description]);

    // Render rich preview when provided by the tool
    if (preview && preview.content) {
      const previewWrap = el('div', { class: 'approval-preview' });
      if (preview.label) {
        previewWrap.appendChild(el('div', { class: 'approval-preview-label' }, [preview.label]));
      }
      if (preview.type === 'diff') {
        const diffEl = el('div', { class: 'approval-preview-diff' });
        preview.content.split('\n').forEach(function(line) {
          if (line.startsWith('-')) {
            diffEl.appendChild(el('span', { class: 'diff-line del' }, [line]));
          } else if (line.startsWith('+')) {
            diffEl.appendChild(el('span', { class: 'diff-line add' }, [line]));
          } else if (line.trim() !== '') {
            diffEl.appendChild(el('span', { class: 'diff-line' }, [line]));
          } else {
            diffEl.appendChild(document.createElement('br'));
          }
        });
        previewWrap.appendChild(diffEl);
      } else if (preview.type === 'command') {
        const codeEl = el('pre', { class: 'approval-preview-cmd' });
        codeEl.appendChild(el('code', {}, [preview.content]));
        previewWrap.appendChild(codeEl);
      }
      dialog.append(desc, previewWrap);
    } else {
      dialog.append(desc);
    }

    const btnRow = el('div', { class: 'approval-btns' });
```

Also update the `approvalRequest` case in the message handler (around line 1770-1771):

Current:
```javascript
      case 'approvalRequest':
        showApprovalDialog(msg.id, msg.description);
```

Replace with:
```javascript
      case 'approvalRequest':
        showApprovalDialog(msg.id, msg.description, msg.preview);
```

**Step 3 — syntax check**

`node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo OK`  
Expected: `OK`.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add webview-ui/dist/main.js
git commit -m "feat: render diff/command preview in approval dialog instead of raw JSON"
```

---

### Task 6 — End-to-end integration test

**File**: `src/tools/__tests__/approval-preview-integration.test.ts`

**Step 1 — write test**

```typescript
import { describe, it, expect } from "vitest";
import { splitIntoHunks } from "../../utils/diff-utils";
import { editFileTool } from "../edit-file";
import { runTerminalTool } from "../run-terminal";

describe("approval preview integration", () => {
  it("editFileTool getPreview produces valid diff lines for splitIntoHunks output", () => {
    const old_content = "function hello() {\n  return 'world';\n}\n";
    const new_content = "function hello() {\n  return 'earth';\n}\n";

    const preview = editFileTool.getPreview?.({ path: "greet.ts", old_content, new_content });
    expect(preview?.type).toBe("diff");

    // Every line must start with -, +, or be empty (separator)
    const lines = (preview?.content ?? "").split("\n").filter(l => l.trim() !== "");
    for (const line of lines) {
      expect(line).toMatch(/^[-+]/);
    }
  });

  it("runTerminalTool getPreview content equals the command verbatim", () => {
    const cmd = "npx jest --coverage --testPathPattern=src/tools";
    const preview = runTerminalTool.getPreview?.({ command: cmd });
    expect(preview?.content).toBe(cmd);
  });

  it("splitIntoHunks returns empty array for identical content (no preview needed)", () => {
    const same = "const x = 1;\n";
    expect(splitIntoHunks(same, same)).toHaveLength(0);
    // editFileTool.getPreview should return undefined in this case
    const preview = editFileTool.getPreview?.({ path: "f.ts", old_content: same, new_content: same });
    expect(preview).toBeUndefined();
  });
});
```

**Step 2 — run**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/tools/__tests__/approval-preview-integration.test.ts 2>&1 | tail -10`  
Expected: 3 tests pass.

**Step 3 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/tools/__tests__/approval-preview-integration.test.ts
git commit -m "test: integration tests for approval preview — diff and command rendering"
```

---

## Completion checklist

- [ ] `ToolPreview` interface in `src/tools/types.ts`
- [ ] `preview?` on `ApprovalRequestMessage` in `src/ui/messages.ts`
- [ ] `getPreview` on `editFileTool` using `splitIntoHunks`
- [ ] `getPreview` on `runTerminalTool` returning command string
- [ ] `ToolRegistry.execute()` calls `getPreview` and passes result to `requestApproval`
- [ ] `buildApprovalCallback` forwards preview in the `approvalRequest` postMessage
- [ ] `showApprovalDialog(id, description, preview)` renders diff or `<pre><code>` block
- [ ] `node --check webview-ui/dist/main.js` passes after edit
- [ ] `npx tsc --noEmit` 0 errors
- [ ] All 6 test files green
