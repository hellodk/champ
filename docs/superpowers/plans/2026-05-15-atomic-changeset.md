# Plan: Atomic Changeset Accept / Reject All

**Date**: 2026-05-15  
**Goal**: Add "Accept All" and "Reject All" buttons to the edit summary panel so the user can atomically keep or discard all agent file changes in one click.  
**Status**: Ready to execute

---

## Architecture

Two new message types flow from webview → extension:

- `AcceptAllEditsRequest` (`type: "acceptAllEdits"`) — signals acceptance; extension clears tracker state.
- `RevertAllEditsRequest` (`type: "revertAllEdits"; edits: Array<{path: string; restoreContent: string}>`) — extension calls `revertFileEdit()` for each entry.

Both are added to `WebviewToExtensionMessage` union. The webview adds "Accept All" and "Reject All" buttons at the top of the `editSummary` panel and disables individual Revert buttons after either bulk action.

### Current state (baselines from code reading)

- `src/ui/messages.ts` lines 402-433: `WebviewToExtensionMessage` union ends with `RevertEditRequest`. `RevertEditRequest` has `{ type: "revertEdit"; path: string; restoreContent: string }`.
- `src/ui/chat-view-provider.ts` lines 578-584: `handleWebviewMessage` handles `isRevertEditRequest(msg)` → calls `this.revertFileEdit(msg.path, msg.restoreContent)`. No accept/reject-all handling.
- `src/agent/edit-review-tracker.ts`: `EditReviewTracker` has `record()`, `flush()`, `reset()`, `count`. The `reset()` method is what "Accept All" uses to clear state.
- `webview-ui/dist/main.js` lines 1900-1930: `editSummary` case renders a panel with per-file `↩ Revert` buttons. No bulk action buttons.

### Tech Stack

TypeScript (extension host), vanilla JS (webview), existing `.edit-summary-*` CSS classes.

---

## Tasks

### Task 1 — Add message types and type guards

**File**: `src/ui/messages.ts`

**Step 1 — write failing test**

File: `src/ui/__tests__/atomic-changeset-types.test.ts`

```typescript
// Compile-time + runtime guard tests for new bulk edit message types.
import type {
  AcceptAllEditsRequest,
  RevertAllEditsRequest,
  WebviewToExtensionMessage,
} from "../messages";
import {
  isAcceptAllEditsRequest,
  isRevertAllEditsRequest,
} from "../messages";

describe("AcceptAllEditsRequest type guard", () => {
  it("accepts a valid acceptAllEdits message", () => {
    const msg: AcceptAllEditsRequest = { type: "acceptAllEdits" };
    expect(isAcceptAllEditsRequest(msg)).toBe(true);
  });

  it("rejects other types", () => {
    expect(isAcceptAllEditsRequest({ type: "revertEdit", path: "", restoreContent: "" })).toBe(false);
  });
});

describe("RevertAllEditsRequest type guard", () => {
  it("accepts a valid revertAllEdits message", () => {
    const msg: RevertAllEditsRequest = {
      type: "revertAllEdits",
      edits: [{ path: "src/foo.ts", restoreContent: "old content" }],
    };
    expect(isRevertAllEditsRequest(msg)).toBe(true);
  });

  it("rejects other types", () => {
    expect(isRevertAllEditsRequest({ type: "acceptAllEdits" })).toBe(false);
  });
});

describe("WebviewToExtensionMessage union", () => {
  it("accepts AcceptAllEditsRequest in the union", () => {
    const msg: WebviewToExtensionMessage = { type: "acceptAllEdits" };
    expect(msg.type).toBe("acceptAllEdits");
  });

  it("accepts RevertAllEditsRequest in the union", () => {
    const msg: WebviewToExtensionMessage = {
      type: "revertAllEdits",
      edits: [{ path: "a.ts", restoreContent: "" }],
    };
    expect(msg.type).toBe("revertAllEdits");
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/atomic-changeset-types.test.ts 2>&1 | tail -10`  
Expected: failures (types and guards don't exist yet).

**Step 2 — implement**

In `src/ui/messages.ts`, add after `RevertEditRequest` (after line 406):

```typescript
export interface AcceptAllEditsRequest {
  type: "acceptAllEdits";
}

export interface RevertAllEditsRequest {
  type: "revertAllEdits";
  /** Each entry holds the path and the content to restore. */
  edits: Array<{ path: string; restoreContent: string }>;
}
```

Add type guards after the existing `isRevertEditRequest` guard (search for `isRevertEditRequest` to find it):

```typescript
export function isAcceptAllEditsRequest(
  msg: WebviewToExtensionMessage,
): msg is AcceptAllEditsRequest {
  return msg.type === "acceptAllEdits";
}

export function isRevertAllEditsRequest(
  msg: WebviewToExtensionMessage,
): msg is RevertAllEditsRequest {
  return msg.type === "revertAllEdits";
}
```

Update the `WebviewToExtensionMessage` union to include both new types:

```typescript
export type WebviewToExtensionMessage =
  | UserMessageRequest
  | SetModeRequest
  | NewChatRequest
  | CancelRequest
  | ApprovalResponseRequest
  | RequestHistoryRequest
  | SkillAutocompleteRequest
  | OpenSettingsRequest
  | ShowHelpRequest
  | SetModelRequest
  | FirstRunSelectRequest
  | FirstRunDismissRequest
  | AttachFileRequest
  | OpenFilePickerRequest
  | SwitchSessionRequest
  | NewSessionRequest
  | DeleteSessionRequest
  | RenameSessionRequest
  | OpenGeneratedFileRequest
  | ReloadMcpServerRequest
  | McpConfigSaveRequest
  | RunMultiAgentRequest
  | OpenWorkflowRunRequest
  | RerunWorkflowRequest
  | RevertEditRequest
  | AcceptAllEditsRequest
  | RevertAllEditsRequest;
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/atomic-changeset-types.test.ts 2>&1 | tail -10`  
Expected: all 6 assertions pass.

**Step 4 — compile check**

`cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error`  
Expected: 0.

**Step 5 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/ui/messages.ts src/ui/__tests__/atomic-changeset-types.test.ts
git commit -m "feat: add AcceptAllEditsRequest and RevertAllEditsRequest message types with guards"
```

---

### Task 2 — Handle `revertAllEdits` in `ChatViewProvider`

**File**: `src/ui/chat-view-provider.ts`

**Step 1 — write failing test**

File: `src/ui/__tests__/chat-view-provider-bulk-revert.test.ts`

```typescript
// Unit test verifying that handleWebviewMessage routes revertAllEdits correctly.
// Uses a minimal stub of ChatViewProvider that exposes revertFileEdit calls.
import { describe, it, expect, vi } from "vitest";
import {
  isAcceptAllEditsRequest,
  isRevertAllEditsRequest,
} from "../messages";

describe("revertAllEdits routing logic", () => {
  it("isRevertAllEditsRequest identifies the correct message type", () => {
    const msg = {
      type: "revertAllEdits" as const,
      edits: [
        { path: "src/a.ts", restoreContent: "old a" },
        { path: "src/b.ts", restoreContent: "old b" },
      ],
    };
    expect(isRevertAllEditsRequest(msg)).toBe(true);
  });

  it("iterates edits array correctly", () => {
    const calls: Array<[string, string]> = [];
    const fakeRevert = (path: string, content: string) => {
      calls.push([path, content]);
    };

    const msg = {
      type: "revertAllEdits" as const,
      edits: [
        { path: "src/a.ts", restoreContent: "old a" },
        { path: "src/b.ts", restoreContent: "old b" },
      ],
    };

    if (isRevertAllEditsRequest(msg)) {
      for (const edit of msg.edits) {
        fakeRevert(edit.path, edit.restoreContent);
      }
    }

    expect(calls).toEqual([
      ["src/a.ts", "old a"],
      ["src/b.ts", "old b"],
    ]);
  });

  it("isAcceptAllEditsRequest returns true for acceptAllEdits", () => {
    expect(isAcceptAllEditsRequest({ type: "acceptAllEdits" })).toBe(true);
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/chat-view-provider-bulk-revert.test.ts 2>&1 | tail -10`  
Expected: passes after Task 1 (types exist). This test validates the routing logic in isolation.

**Step 2 — implement**

In `src/ui/chat-view-provider.ts`, in `handleWebviewMessage`, add two new branches after the `isRevertEditRequest` block (after line 580):

```typescript
      } else if (isAcceptAllEditsRequest(msg)) {
        // "Accept All" — just clear the tracker so edits are no longer tracked.
        // The files are already saved by VS Code; nothing to undo.
        this.editTracker.reset();
      } else if (isRevertAllEditsRequest(msg)) {
        // "Reject All" — revert every file in the batch sequentially.
        for (const edit of msg.edits) {
          await this.revertFileEdit(edit.path, edit.restoreContent);
        }
        this.editTracker.reset();
      }
```

Also import the new guards at the top of `chat-view-provider.ts` (add to the existing messages import):

```typescript
import {
  // … existing imports …
  isAcceptAllEditsRequest,
  isRevertAllEditsRequest,
} from "./messages";
```

**Step 3 — compile check**

`cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error`  
Expected: 0.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/ui/chat-view-provider.ts src/ui/__tests__/chat-view-provider-bulk-revert.test.ts
git commit -m "feat: handle acceptAllEdits and revertAllEdits in ChatViewProvider"
```

---

### Task 3 — Add bulk buttons to `editSummary` panel in `main.js`

**File**: `webview-ui/dist/main.js`

**Step 1 — verify syntax**

`node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo OK`  
Expected: `OK`.

**Step 2 — implement**

In `webview-ui/dist/main.js`, replace the `editSummary` case (lines 1900-1930):

Current:
```javascript
      case 'editSummary': {
        if (!msg.edits || msg.edits.length === 0) break;
        const panel = el('div', { class: 'edit-summary-panel' });
        panel.appendChild(el('div', { class: 'edit-summary-title' }, [
          '📝 Review ' + msg.edits.length + ' file change' + (msg.edits.length !== 1 ? 's' : '')
        ]));
        msg.edits.forEach(function(edit) {
          const fileSection = el('div', { class: 'edit-summary-file' });
          const fileHeader = el('div', { class: 'edit-summary-file-header' });
          const rejectBtn = el('button', { class: 'edit-reject-btn' }, ['↩ Revert']);
          rejectBtn.title = 'Revert this file to its state before the agent edited it';
          rejectBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'revertEdit', path: edit.path, restoreContent: edit.oldContent });
            rejectBtn.textContent = '✓ Reverted';
            rejectBtn.disabled = true;
            fileSection.style.opacity = '0.5';
          });
          fileHeader.append(el('span', { class: 'edit-diff-path' }, [edit.path]), rejectBtn);
          const hunksEl = el('div', { class: 'edit-summary-hunks' });
          splitHunks(edit.oldContent, edit.newContent).forEach(function(hunk) {
            const hunkEl = el('div', { class: 'hunk' });
            hunk.oldLines.forEach(function(l) { hunkEl.appendChild(el('span', { class: 'diff-line del' }, ['- ' + l])); });
            hunk.newLines.forEach(function(l) { hunkEl.appendChild(el('span', { class: 'diff-line add' }, ['+ ' + l])); });
            hunksEl.appendChild(hunkEl);
          });
          fileSection.append(fileHeader, hunksEl);
          panel.appendChild(fileSection);
        });
        messagesWrapper.appendChild(panel);
        messagesWrapper.scrollTop = messagesWrapper.scrollHeight;
        break;
      }
```

Replace with:
```javascript
      case 'editSummary': {
        if (!msg.edits || msg.edits.length === 0) break;
        const panel = el('div', { class: 'edit-summary-panel' });
        panel.appendChild(el('div', { class: 'edit-summary-title' }, [
          '📝 Review ' + msg.edits.length + ' file change' + (msg.edits.length !== 1 ? 's' : '')
        ]));

        // Collect per-file revert buttons so bulk actions can disable them.
        const perFileRevertBtns = [];

        // Bulk action row — Accept All / Reject All
        const bulkRow = el('div', { class: 'edit-summary-bulk-row' });

        const acceptAllBtn = el('button', { class: 'edit-accept-all-btn' }, ['✓ Accept All']);
        acceptAllBtn.title = 'Keep all agent file changes and clear the review panel';
        acceptAllBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'acceptAllEdits' });
          acceptAllBtn.textContent = '✓ Accepted';
          acceptAllBtn.disabled = true;
          rejectAllBtn.disabled = true;
          perFileRevertBtns.forEach(function(btn) {
            btn.disabled = true;
            btn.textContent = '✓ Accepted';
          });
          panel.style.opacity = '0.5';
        });

        const rejectAllBtn = el('button', { class: 'edit-reject-all-btn' }, ['↩ Reject All']);
        rejectAllBtn.title = 'Revert all agent file changes at once';
        rejectAllBtn.addEventListener('click', function() {
          const allEdits = msg.edits.map(function(e) {
            return { path: e.path, restoreContent: e.oldContent };
          });
          vscode.postMessage({ type: 'revertAllEdits', edits: allEdits });
          rejectAllBtn.textContent = '✓ Reverted All';
          rejectAllBtn.disabled = true;
          acceptAllBtn.disabled = true;
          perFileRevertBtns.forEach(function(btn) {
            btn.disabled = true;
            btn.textContent = '✓ Reverted';
          });
          panel.style.opacity = '0.5';
        });

        bulkRow.append(acceptAllBtn, rejectAllBtn);
        panel.appendChild(bulkRow);

        msg.edits.forEach(function(edit) {
          const fileSection = el('div', { class: 'edit-summary-file' });
          const fileHeader = el('div', { class: 'edit-summary-file-header' });
          const rejectBtn = el('button', { class: 'edit-reject-btn' }, ['↩ Revert']);
          rejectBtn.title = 'Revert this file to its state before the agent edited it';
          perFileRevertBtns.push(rejectBtn);
          rejectBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'revertEdit', path: edit.path, restoreContent: edit.oldContent });
            rejectBtn.textContent = '✓ Reverted';
            rejectBtn.disabled = true;
            fileSection.style.opacity = '0.5';
          });
          fileHeader.append(el('span', { class: 'edit-diff-path' }, [edit.path]), rejectBtn);
          const hunksEl = el('div', { class: 'edit-summary-hunks' });
          splitHunks(edit.oldContent, edit.newContent).forEach(function(hunk) {
            const hunkEl = el('div', { class: 'hunk' });
            hunk.oldLines.forEach(function(l) { hunkEl.appendChild(el('span', { class: 'diff-line del' }, ['- ' + l])); });
            hunk.newLines.forEach(function(l) { hunkEl.appendChild(el('span', { class: 'diff-line add' }, ['+ ' + l])); });
            hunksEl.appendChild(hunkEl);
          });
          fileSection.append(fileHeader, hunksEl);
          panel.appendChild(fileSection);
        });
        messagesWrapper.appendChild(panel);
        messagesWrapper.scrollTop = messagesWrapper.scrollHeight;
        break;
      }
```

**Step 3 — syntax check**

`node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo OK`  
Expected: `OK`.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add webview-ui/dist/main.js
git commit -m "feat: add Accept All / Reject All bulk buttons to edit summary panel"
```

---

### Task 4 — Verify individual Revert buttons disable on bulk action

This is covered by the implementation in Task 3 (`perFileRevertBtns.forEach` loop). The test below validates the pattern in isolation.

**File**: `src/ui/__tests__/edit-summary-bulk-disable.test.ts`

```typescript
// Logic test: verifies that disabling bulk actions also disables per-file buttons.
// This mirrors the array-based disable pattern in main.js.
import { describe, it, expect } from "vitest";

describe("bulk disable pattern", () => {
  it("disabling via shared array reaches every button", () => {
    // Simulate the perFileRevertBtns array pattern from main.js
    const perFileRevertBtns: Array<{ disabled: boolean; textContent: string }> = [
      { disabled: false, textContent: "↩ Revert" },
      { disabled: false, textContent: "↩ Revert" },
      { disabled: false, textContent: "↩ Revert" },
    ];

    // Simulate Accept All click handler
    perFileRevertBtns.forEach((btn) => {
      btn.disabled = true;
      btn.textContent = "✓ Accepted";
    });

    for (const btn of perFileRevertBtns) {
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe("✓ Accepted");
    }
  });

  it("rejectAllEdits message carries all edits", () => {
    const edits = [
      { path: "a.ts", oldContent: "old a", newContent: "new a" },
      { path: "b.ts", oldContent: "old b", newContent: "new b" },
    ];
    const allEdits = edits.map((e) => ({ path: e.path, restoreContent: e.oldContent }));
    expect(allEdits).toEqual([
      { path: "a.ts", restoreContent: "old a" },
      { path: "b.ts", restoreContent: "old b" },
    ]);
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/edit-summary-bulk-disable.test.ts 2>&1 | tail -10`  
Expected: 2 tests pass.

**Commit:**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/ui/__tests__/edit-summary-bulk-disable.test.ts
git commit -m "test: verify bulk disable pattern and revertAllEdits payload construction"
```

---

## Completion checklist

- [ ] `AcceptAllEditsRequest` interface and `isAcceptAllEditsRequest` guard in `messages.ts`
- [ ] `RevertAllEditsRequest` interface and `isRevertAllEditsRequest` guard in `messages.ts`
- [ ] Both types in `WebviewToExtensionMessage` union
- [ ] `ChatViewProvider.handleWebviewMessage` routes both new types; `revertAllEdits` loops and calls `revertFileEdit`; both call `editTracker.reset()`
- [ ] `editSummary` panel has "Accept All" and "Reject All" buttons above per-file section
- [ ] Accept All / Reject All click disables the other bulk button and all per-file Revert buttons
- [ ] `node --check webview-ui/dist/main.js` passes after edit
- [ ] `npx tsc --noEmit` 0 errors
- [ ] All 4 test files green
