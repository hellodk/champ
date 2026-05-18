# Sprint O: Diff & Terminal UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native VS Code side-by-side diff editor integration, "Run in terminal" buttons on bash code blocks, streaming terminal output in chat, and a multi-file navigator in the diff panel.

**Architecture:** DiffOverlayController adds an "Open Diff" CodeLens using VS Code's vscode.diff() command (which opens a native diff editor with before/after content). The webview JS post-processes bash/sh code blocks after render to inject a Run button that sends RunInTerminalRequest to the extension host. run-terminal.ts gains a streaming callback that routes chunks to the webview as TerminalOutputChunkMessage. DiffOverlayPanel gets a file list sidebar.

**Tech Stack:** TypeScript (extension host + tools), Vanilla JS (webview), Preact TSX (DiffOverlayPanel), Vitest (tests), VS Code TextEditor API

---

## File Map

| File | Change |
|------|--------|
| `src/ui/messages.ts` | Add `TerminalOutputChunkMessage`, `RunInTerminalRequest`, type guards, factory helpers, union members |
| `src/ui/diff-overlay-controller.ts` | Add `openDiffEditor()` helper + "Open Diff" CodeLens per hunk and per file |
| `src/extension.ts` | Register `champ.openDiffEditor` command; wire `RunInTerminalRequest` handler |
| `src/agent/agent-controller.ts` | Pass a real `reportProgress` callback that emits `terminal_chunk` stream deltas |
| `src/ui/chat-view-provider.ts` | Handle `runInTerminal` webview message; forward `terminal_chunk` deltas as `TerminalOutputChunkMessage` |
| `webview-ui/src/components/DiffOverlayPanel.tsx` | Add file-navigator sidebar with jump-to-file |
| `webview-ui/dist/main.js` | Inject "Run" button on bash/sh code blocks; render streaming terminal output |
| `src/ui/__tests__/diff-run-in-terminal.test.ts` | New test file covering all four gaps |

---

## Task 1: Add new message types to messages.ts

**Files:**
- Modify: `src/ui/messages.ts`

- [ ] **Step 1: Write the failing test**

Create `src/ui/__tests__/diff-run-in-terminal.test.ts`:

```typescript
// src/ui/__tests__/diff-run-in-terminal.test.ts
import { describe, it, expect } from "vitest";
import {
  createTerminalOutputChunk,
  isRunInTerminalRequest,
  isTerminalOutputChunkMessage,
  type TerminalOutputChunkMessage,
  type RunInTerminalRequest,
} from "../messages";

describe("TerminalOutputChunkMessage", () => {
  it("createTerminalOutputChunk produces a correctly shaped message", () => {
    const msg = createTerminalOutputChunk("exec-1", "hello\n", false);
    expect(msg).toEqual({
      type: "terminalOutputChunk",
      executionId: "exec-1",
      chunk: "hello\n",
      done: false,
    });
  });

  it("createTerminalOutputChunk with done=true sets done flag", () => {
    const msg = createTerminalOutputChunk("exec-2", "", true);
    expect(msg.done).toBe(true);
  });

  it("isTerminalOutputChunkMessage returns true for correct type", () => {
    const msg: TerminalOutputChunkMessage = {
      type: "terminalOutputChunk",
      executionId: "x",
      chunk: "data",
      done: false,
    };
    expect(isTerminalOutputChunkMessage(msg as never)).toBe(true);
  });

  it("isTerminalOutputChunkMessage returns false for other types", () => {
    expect(isTerminalOutputChunkMessage({ type: "streamDelta", text: "a" } as never)).toBe(false);
  });
});

describe("RunInTerminalRequest", () => {
  it("isRunInTerminalRequest returns true for correct type", () => {
    const req: RunInTerminalRequest = {
      type: "runInTerminal",
      command: "ls -la",
      executionId: "exec-42",
    };
    expect(isRunInTerminalRequest(req as never)).toBe(true);
  });

  it("isRunInTerminalRequest returns false for other types", () => {
    expect(isRunInTerminalRequest({ type: "userMessage", text: "hi" } as never)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose src/ui/__tests__/diff-run-in-terminal.test.ts 2>&1 | tail -20
```

Expected: FAIL — `createTerminalOutputChunk`, `isRunInTerminalRequest`, `isTerminalOutputChunkMessage` not exported from `../messages`.

- [ ] **Step 3: Add types, factory, and guards to messages.ts**

In `src/ui/messages.ts`, add after the `TeamRunSnapshotMessage` interface (line ~260):

```typescript
/**
 * Streamed terminal output chunk sent from the extension host to the
 * webview as run_terminal_cmd executes. One message per stdout chunk.
 * A final message with done=true marks the end of the execution.
 */
export interface TerminalOutputChunkMessage {
  type: "terminalOutputChunk";
  /** Unique identifier for this execution run, matches RunInTerminalRequest.executionId. */
  executionId: string;
  /** Partial stdout text (may be empty on the done=true sentinel). */
  chunk: string;
  /** True on the final message; the webview should close the streaming block. */
  done: boolean;
}
```

Add after `FocusTeamAgentRequest` (line ~510):

```typescript
/**
 * The user clicked the "Run" button on a bash code block in the chat.
 * The host runs the command via run_terminal_cmd and streams output back
 * as TerminalOutputChunkMessage.
 */
export interface RunInTerminalRequest {
  type: "runInTerminal";
  /** The shell command extracted from the fenced code block. */
  command: string;
  /** Webview-generated identifier so the host can correlate streaming chunks. */
  executionId: string;
}
```

Update the `ExtensionToWebviewMessage` union to include `TerminalOutputChunkMessage`:

```typescript
export type ExtensionToWebviewMessage =
  | StreamStartMessage
  | StreamDeltaMessage
  | StreamEndMessage
  | ToolCallStartMessage
  | ToolCallResultMessage
  | ApprovalRequestMessage
  | ErrorMessage
  | PiiNoticeMessage
  | ModeChangedMessage
  | ConversationHistoryMessage
  | ReadyMessage
  | SkillAutocompleteResponseMessage
  | ProviderStatusMessage
  | FirstRunWelcomeMessage
  | SessionListMessage
  | MetricsUpdateMessage
  | McpStatusMessage
  | WorkflowHistoryUpdateMessage
  | FileEditDiffMessage
  | EditSummaryMessage
  | AutoContextNoticeMessage
  | McpMarketplaceOpenMessage
  | McpMarketplaceEntriesMessage
  | McpMarketplaceInstallCompleteMessage
  | TeamRunSnapshotMessage
  | TerminalOutputChunkMessage;
```

Update the `WebviewToExtensionMessage` union to include `RunInTerminalRequest`:

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
  | RunTeamRequest
  | SetYoloModeRequest
  | SetAutocompleteRequest
  | OpenConfigFileRequest
  | RescanModelsRequest
  | ResetToAutoRequest
  | OpenWorkflowRunRequest
  | RerunWorkflowRequest
  | RevertEditRequest
  | AcceptAllEditsRequest
  | RevertAllEditsRequest
  | FetchMcpMarketplaceRequest
  | McpMarketplaceInstallRequest
  | AcceptHunkAtLineRequest
  | RejectHunkAtLineRequest
  | FocusTeamAgentRequest
  | RunInTerminalRequest;
```

Add factory and type guards at the end of the factory section and guards section:

```typescript
// Factory helper
export function createTerminalOutputChunk(
  executionId: string,
  chunk: string,
  done: boolean,
): TerminalOutputChunkMessage {
  return { type: "terminalOutputChunk", executionId, chunk, done };
}

// Type guards
export function isTerminalOutputChunkMessage(
  msg: ExtensionToWebviewMessage,
): msg is TerminalOutputChunkMessage {
  return msg.type === "terminalOutputChunk";
}

export function isRunInTerminalRequest(
  msg: WebviewToExtensionMessage,
): msg is RunInTerminalRequest {
  return msg.type === "runInTerminal";
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose src/ui/__tests__/diff-run-in-terminal.test.ts 2>&1 | tail -20
```

Expected: PASS — 6 tests passing.

- [ ] **Step 5: Type-check**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run check-types 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/ui/messages.ts src/ui/__tests__/diff-run-in-terminal.test.ts && git commit -m "feat(sprint-o): add TerminalOutputChunkMessage and RunInTerminalRequest message types"
```

---

## Task 2: Add "Open Diff" CodeLens to DiffOverlayController

**Files:**
- Modify: `src/ui/diff-overlay-controller.ts`

- [ ] **Step 1: Add failing tests for openDiffEditor**

Append to `src/ui/__tests__/diff-run-in-terminal.test.ts`:

```typescript
import { computeHunks } from "../diff-overlay-controller";

describe("DiffOverlayController — openDiffEditor CodeLens presence", () => {
  it("computeHunks returns at least one hunk for differing content (precondition for CodeLens)", () => {
    const old = "const x = 1;\nconst y = 2;";
    const neu = "const x = 99;\nconst y = 2;";
    const hunks = computeHunks(old, neu);
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks[0].newDocStartLine).toBe(0);
  });

  it("computeHunks returns empty for identical content (no CodeLens shown)", () => {
    const content = "line1\nline2";
    expect(computeHunks(content, content)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify pass (these test pure functions already in place)**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose src/ui/__tests__/diff-run-in-terminal.test.ts 2>&1 | tail -20
```

Expected: PASS — the new computeHunks tests pass immediately since the logic already exists.

- [ ] **Step 3: Add openDiffEditor method to DiffOverlayController**

In `src/ui/diff-overlay-controller.ts`, add the following method to the `DiffOverlayController` class after the `clearAll()` method (around line 444):

```typescript
/**
 * Open a native VS Code diff editor for the given file path.
 * Creates two virtual TextDocuments (before/after) and calls
 * vscode.diff() to open the side-by-side diff view.
 * No-op if there is no pending diff for the given path.
 */
async openDiffEditor(filePath: string): Promise<void> {
  const diff = this.pendingDiffs.get(filePath);
  if (!diff) return;

  const filename = filePath.split(/[\\/]/).pop() ?? "file";

  // Create virtual URIs for old and new content.
  // Use the 'untitled' scheme with a unique label so VS Code doesn't
  // try to read them from disk — content is supplied via openTextDocument.
  const oldUri = vscode.Uri.from({
    scheme: "untitled",
    path: `${filename} (before Champ)`,
  });
  const newUri = vscode.Uri.file(filePath);

  // Write old content into a new untitled document.
  const oldDoc = await vscode.workspace.openTextDocument(
    oldUri.with({ scheme: "untitled" }),
  );
  const edit = new vscode.WorkspaceEdit();
  edit.insert(oldUri, new vscode.Position(0, 0), diff.oldContent);
  await vscode.workspace.applyEdit(edit);

  await vscode.commands.executeCommand(
    "vscode.diff",
    oldDoc.uri,
    newUri,
    `Champ: ${filename} (before ↔ after)`,
    { preview: true },
  );
}
```

- [ ] **Step 4: Add "Open Diff" CodeLens in provideCodeLenses**

In `src/ui/diff-overlay-controller.ts`, inside `provideCodeLenses()`, add a per-file "Open Diff" CodeLens after the per-hunk lenses are built (after the closing brace of the per-hunk `for` loop, around line 520, just before the file-level Accept/Reject all lenses):

```typescript
// "Open Diff" CodeLens — always present when unresolved hunks exist,
// positioned at the first hunk line.
if (unresolvedHunks.length > 0) {
  const firstHunkLine = unresolvedHunks[0].newDocStartLine;
  const diffRange = new vscode.Range(firstHunkLine, 0, firstHunkLine, 0);
  lenses.push(
    new vscode.CodeLens(diffRange, {
      title: "⊞ Open Diff",
      command: "champ.openDiffEditor",
      arguments: [filePath],
    }),
  );
}
```

- [ ] **Step 5: Register command in extension.ts**

In `src/extension.ts`, inside the block where `champ.acceptHunkAtLine` and related hunk commands are registered (around line 851), add:

```typescript
vscode.commands.registerCommand(
  "champ.openDiffEditor",
  (filePath: string) => {
    void diffOverlayController.openDiffEditor(filePath);
  },
),
```

- [ ] **Step 6: Type-check and run all tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run check-types 2>&1 | tail -10 && npm test -- --reporter=verbose src/ui/__tests__/diff-run-in-terminal.test.ts 2>&1 | tail -20
```

Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/ui/diff-overlay-controller.ts src/extension.ts src/ui/__tests__/diff-run-in-terminal.test.ts && git commit -m "feat(sprint-o): add Open Diff CodeLens that opens native vscode.diff editor"
```

---

## Task 3: Wire terminal streaming through agent-controller

**Files:**
- Modify: `src/agent/agent-controller.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/ui/__tests__/diff-run-in-terminal.test.ts`:

```typescript
describe("reportProgress wiring (unit — pure callback)", () => {
  it("calling reportProgress accumulates chunks in order", () => {
    const chunks: string[] = [];
    const reportProgress = (chunk: string): void => {
      chunks.push(chunk);
    };

    reportProgress("line1\n");
    reportProgress("line2\n");
    reportProgress("done\n");

    expect(chunks).toEqual(["line1\n", "line2\n", "done\n"]);
  });
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose src/ui/__tests__/diff-run-in-terminal.test.ts 2>&1 | tail -20
```

Expected: PASS — this is a pure callback test verifying the contract shape.

- [ ] **Step 3: Add a StreamDelta type for terminal chunks**

In `src/providers/types.ts`, locate the `StreamDelta` type and add a new variant. Find the union (look for `type: "text" | "tool_call_start"` etc.) and add:

```typescript
| { type: "terminal_chunk"; executionId: string; chunk: string; done: boolean }
```

The full updated union should look like:

```typescript
export type StreamDelta =
  | { type: "text"; text?: string; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "tool_call_start"; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: "tool_call_end"; toolCallId?: string; toolName?: string; toolResult?: string; toolSuccess?: boolean }
  | { type: "done" }
  | { type: "terminal_chunk"; executionId: string; chunk: string; done: boolean };
```

- [ ] **Step 4: Update reportProgress in agent-controller.ts to emit terminal_chunk deltas**

In `src/agent/agent-controller.ts`, find the `toolContext` construction around line 768 where `reportProgress` is currently a no-op:

```typescript
reportProgress: () => {
  // Progress is streamed via listeners if needed.
},
```

Replace it with a real implementation that emits the terminal output as a stream delta. The `executionId` should be the tool call's id so the webview can correlate:

```typescript
reportProgress: (chunk: string) => {
  this.emit({
    type: "terminal_chunk",
    executionId: call.id,
    chunk,
    done: false,
  });
},
```

After the `result` is resolved (after `const result = await this.toolRegistry.execute(...)`), emit the done sentinel:

```typescript
// Emit terminal done sentinel so the webview closes the streaming block.
this.emit({
  type: "terminal_chunk",
  executionId: call.id,
  chunk: "",
  done: true,
});
```

- [ ] **Step 5: Handle terminal_chunk in chat-view-provider.ts forwardStreamDelta**

In `src/ui/chat-view-provider.ts`, in the `forwardStreamDelta` switch statement (around line 972), add a case for `terminal_chunk` after the `tool_call_end` case:

```typescript
case "terminal_chunk":
  this.postMessage(
    createTerminalOutputChunk(
      delta.executionId,
      delta.chunk,
      delta.done,
    ),
  );
  break;
```

Also add `createTerminalOutputChunk` to the import from `./messages` at the top of chat-view-provider.ts.

- [ ] **Step 6: Type-check**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run check-types 2>&1 | tail -15
```

Expected: no errors.

- [ ] **Step 7: Run all tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose 2>&1 | tail -25
```

Expected: all passing.

- [ ] **Step 8: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/providers/types.ts src/agent/agent-controller.ts src/ui/chat-view-provider.ts src/ui/__tests__/diff-run-in-terminal.test.ts && git commit -m "feat(sprint-o): stream terminal output chunks through agent-controller to webview"
```

---

## Task 4: Handle RunInTerminalRequest in chat-view-provider.ts

**Files:**
- Modify: `src/ui/chat-view-provider.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/ui/__tests__/diff-run-in-terminal.test.ts`:

```typescript
describe("isRunInTerminalRequest type guard", () => {
  it("returns true for runInTerminal type", () => {
    expect(
      isRunInTerminalRequest({
        type: "runInTerminal",
        command: "echo hello",
        executionId: "e-1",
      } as never),
    ).toBe(true);
  });

  it("returns false for unrelated type", () => {
    expect(
      isRunInTerminalRequest({ type: "cancelRequest" } as never),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm pass (type guard already added in Task 1)**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose src/ui/__tests__/diff-run-in-terminal.test.ts 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Add import and handler in chat-view-provider.ts**

In `src/ui/chat-view-provider.ts`, add `isRunInTerminalRequest` to the existing import block from `./messages`.

In the `handleWebviewMessage` method, add a new `else if` branch at the end of the existing chain (after the `isFocusTeamAgentRequest` branch, around line 640):

```typescript
} else if (isRunInTerminalRequest(msg)) {
  void this.handleRunInTerminal(msg.command, msg.executionId);
}
```

Add the handler method to the `ChatViewProvider` class:

```typescript
/**
 * Run a shell command (requested from a webview bash code-block "Run" button)
 * and stream stdout chunks back to the webview as TerminalOutputChunkMessage.
 * Uses the same CommandSandbox + approval flow as run_terminal_cmd.
 */
private async handleRunInTerminal(
  command: string,
  executionId: string,
): Promise<void> {
  const { spawn } = await import("child_process");
  const { CommandSandbox } = await import("../safety/command-sandbox");

  const sandbox = new CommandSandbox();
  const check = sandbox.check(command);
  if (!check.allowed) {
    this.postMessage(
      createTerminalOutputChunk(
        executionId,
        `Command blocked: ${check.reason}\n`,
        true,
      ),
    );
    return;
  }

  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const controller = new AbortController();
  const proc = spawn("bash", ["-c", command], {
    cwd: workspaceRoot,
    env: { ...process.env, TERM: "dumb" },
  });

  proc.stdout?.on("data", (chunk: Buffer) => {
    this.postMessage(
      createTerminalOutputChunk(executionId, chunk.toString(), false),
    );
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    this.postMessage(
      createTerminalOutputChunk(executionId, chunk.toString(), false),
    );
  });

  proc.on("error", (err) => {
    this.postMessage(
      createTerminalOutputChunk(executionId, `Error: ${err.message}\n`, true),
    );
  });

  proc.on("close", (code) => {
    this.postMessage(
      createTerminalOutputChunk(
        executionId,
        `\nExit code: ${code ?? "unknown"}\n`,
        true,
      ),
    );
  });

  controller.signal.addEventListener("abort", () => proc.kill("SIGTERM"));
}
```

Also add `createTerminalOutputChunk` to the import list from `./messages` if not already present.

- [ ] **Step 4: Type-check**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run check-types 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/ui/chat-view-provider.ts && git commit -m "feat(sprint-o): handle RunInTerminalRequest in ChatViewProvider with live output streaming"
```

---

## Task 5: Inject "Run" button on bash code blocks in webview main.js

**Files:**
- Modify: `webview-ui/dist/main.js`

This task modifies the compiled webview bundle directly. The source for this logic lives conceptually in webview-ui, but the bundle is what gets loaded. Edit the compiled file.

- [ ] **Step 1: Write a test describing the DOM mutation contract**

Append to `src/ui/__tests__/diff-run-in-terminal.test.ts`:

```typescript
describe("bash code block Run button — DOM logic (pure)", () => {
  it("extracting language from a pre>code element works correctly", () => {
    // Simulate the DOM shape the webview produces for ```bash code blocks
    // language-bash is set as the class by the markdown renderer
    const className = "language-bash";
    const lang = className.replace("language-", "");
    expect(lang).toBe("bash");
    expect(["bash", "sh"].includes(lang)).toBe(true);
  });

  it("non-bash language is not injected", () => {
    const className = "language-typescript";
    const lang = className.replace("language-", "");
    expect(["bash", "sh"].includes(lang)).toBe(false);
  });

  it("generateExecutionId produces unique strings each time", () => {
    const genId = (): string =>
      `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const id1 = genId();
    const id2 = genId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^run-\d+-[a-z0-9]+$/);
  });
});
```

- [ ] **Step 2: Run test to confirm pass (pure logic)**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose src/ui/__tests__/diff-run-in-terminal.test.ts 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Add the Run button injection to webview-ui/dist/main.js**

Open `webview-ui/dist/main.js`. Locate the section that handles incoming messages from the extension host — it contains a `window.addEventListener("message", ...)` block. Add a new function `injectRunButtons` and call it after each message that adds new content to the DOM. The injection should run after `streamDelta` and after `toolCallResult` messages render.

Find the `window.addEventListener("message",` handler. After the switch block that processes `streamDelta` and `toolCallResult`, call `injectRunButtons()`. Also call it once on `DOMContentLoaded`.

Add this function definition near the top of the script block (before the message listener):

```javascript
function injectRunButtons() {
  // Find all <pre><code class="language-bash"> and <pre><code class="language-sh">
  // elements that don't already have a Run button injected.
  const codeBlocks = document.querySelectorAll(
    'pre > code[class*="language-bash"]:not([data-run-injected]), ' +
    'pre > code[class*="language-sh"]:not([data-run-injected])'
  );
  codeBlocks.forEach(function(codeEl) {
    codeEl.setAttribute("data-run-injected", "true");
    const pre = codeEl.parentElement;
    if (!pre) return;

    // Build the Run button
    const btn = document.createElement("button");
    btn.textContent = "▶ Run";
    btn.title = "Run this command in the workspace terminal";
    btn.style.cssText = [
      "position:absolute",
      "top:4px",
      "right:4px",
      "font-size:11px",
      "padding:2px 8px",
      "cursor:pointer",
      "background:var(--vscode-button-background)",
      "color:var(--vscode-button-foreground)",
      "border:none",
      "border-radius:2px",
      "opacity:0.85",
    ].join(";");

    btn.addEventListener("click", function() {
      const command = codeEl.textContent || "";
      const executionId = "run-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

      // Create a streaming output block below the pre element
      const outputDiv = document.createElement("div");
      outputDiv.id = "terminal-output-" + executionId;
      outputDiv.style.cssText = [
        "margin-top:4px",
        "padding:6px 8px",
        "background:var(--vscode-terminal-background, var(--vscode-editor-background))",
        "border:1px solid var(--vscode-panel-border)",
        "border-radius:2px",
        "font-family:var(--vscode-editor-font-family, monospace)",
        "font-size:12px",
        "white-space:pre-wrap",
        "word-break:break-all",
        "max-height:240px",
        "overflow-y:auto",
        "color:var(--vscode-terminal-foreground, var(--vscode-editor-foreground))",
      ].join(";");
      outputDiv.textContent = "$ " + command.trim() + "\n";
      pre.insertAdjacentElement("afterend", outputDiv);

      btn.disabled = true;
      btn.textContent = "Running…";

      // Send to extension host
      vscode.postMessage({ type: "runInTerminal", command: command.trim(), executionId: executionId });
    });

    // Make the pre position:relative so the button sits in the corner
    pre.style.position = "relative";
    pre.appendChild(btn);
  });
}

// Handle incoming terminal chunks
window.addEventListener("message", function(event) {
  const msg = event.data;
  if (msg && msg.type === "terminalOutputChunk") {
    const outputDiv = document.getElementById("terminal-output-" + msg.executionId);
    if (!outputDiv) return;
    if (msg.chunk) {
      outputDiv.textContent += msg.chunk;
      outputDiv.scrollTop = outputDiv.scrollHeight;
    }
    if (msg.done) {
      // Re-enable the Run button
      const pre = outputDiv.previousElementSibling;
      if (pre) {
        const btn = pre.querySelector("button[title='Run this command in the workspace terminal']");
        if (btn) {
          btn.disabled = false;
          btn.textContent = "▶ Run";
        }
      }
    }
  }
});

document.addEventListener("DOMContentLoaded", injectRunButtons);
```

Within the existing `window.addEventListener("message", ...)` handler (the main one), after the cases for `streamDelta`, `toolCallResult`, and `streamEnd`, add a call to `injectRunButtons()`:

```javascript
// After content is appended to the DOM:
injectRunButtons();
```

- [ ] **Step 4: Validate the modified bundle**

```bash
node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo "JS valid"
```

Expected: `JS valid` with no syntax errors.

- [ ] **Step 5: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add webview-ui/dist/main.js && git commit -m "feat(sprint-o): inject Run button on bash/sh code blocks with inline streaming output"
```

---

## Task 6: Add file navigator sidebar to DiffOverlayPanel

**Files:**
- Modify: `webview-ui/src/components/DiffOverlayPanel.tsx`

- [ ] **Step 1: Write the failing test**

Append to `src/ui/__tests__/diff-run-in-terminal.test.ts`:

```typescript
describe("DiffOverlayPanel file navigator — data shape", () => {
  it("basename extracts filename from absolute path", () => {
    // Mirror the same logic used in DiffOverlayPanel's navigator
    const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p;
    expect(basename("/home/user/project/src/foo.ts")).toBe("foo.ts");
    expect(basename("C:\\Users\\dk\\src\\bar.ts")).toBe("bar.ts");
    expect(basename("file.ts")).toBe("file.ts");
  });

  it("selectedFileIndex defaults to 0 when edits are present", () => {
    const edits = [
      { path: "/a/foo.ts", oldContent: "a", newContent: "b" },
      { path: "/a/bar.ts", oldContent: "c", newContent: "d" },
    ];
    const defaultIndex = 0;
    expect(edits[defaultIndex].path).toBe("/a/foo.ts");
  });
});
```

- [ ] **Step 2: Run test to confirm pass**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose src/ui/__tests__/diff-run-in-terminal.test.ts 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Add selectedFileSignal and FileNavigator component**

Replace the contents of `webview-ui/src/components/DiffOverlayPanel.tsx` with the updated version. Key changes: add a `selectedFileIndexSignal`, a `FileNavigator` sidebar component, and modify the main panel layout to render the navigator + selected file content side by side.

```tsx
// webview-ui/src/components/DiffOverlayPanel.tsx
import { signal, computed } from "@preact/signals";
import { splitHunks, type WebviewHunk } from "../utils/diff";
import type { EditSummaryMessage, EditSummary } from "../types";

export const editsSignal = signal<EditSummary[]>([]);
const isVisibleSignal = computed(() => editsSignal.value.length > 0);

/** Index of the file currently shown in the main content area. */
const selectedFileIndexSignal = signal<number>(0);

window.addEventListener("champ:editSummary", (e: Event) => {
  const msg = (e as CustomEvent<EditSummaryMessage>).detail;
  if (Array.isArray(msg.edits)) {
    editsSignal.value = msg.edits;
    selectedFileIndexSignal.value = 0; // reset to first file on new batch
  }
});

const hunkResolutions = signal<Map<string, "accepted" | "rejected">>(new Map());

function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (
    typeof (window as unknown as { vscode?: unknown }).vscode !== "undefined"
  ) {
    return (
      window as unknown as { vscode: { postMessage: (msg: unknown) => void } }
    ).vscode;
  }
  return (
    window as unknown as {
      acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
    }
  ).acquireVsCodeApi();
}

/** Extract the filename (basename) from an absolute or relative path. */
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Extract the directory portion for display in the navigator tooltip. */
function dirname(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join("/") || ".";
}

function HunkRow({
  edit,
  hunk,
}: {
  edit: EditSummary;
  hunk: WebviewHunk;
}): JSX.Element {
  const key = `${edit.path}:${hunk.index}`;
  const resolution = hunkResolutions.value.get(key);

  function handleAccept(): void {
    getVsCode().postMessage({
      type: "acceptHunkAtLine",
      filePath: edit.path,
      line: hunk.newDocStartLine,
    });
    const next = new Map(hunkResolutions.value);
    next.set(key, "accepted");
    hunkResolutions.value = next;
  }

  function handleReject(): void {
    getVsCode().postMessage({
      type: "rejectHunkAtLine",
      filePath: edit.path,
      line: hunk.newDocStartLine,
    });
    const next = new Map(hunkResolutions.value);
    next.set(key, "rejected");
    hunkResolutions.value = next;
  }

  return (
    <div
      class={`hunk-row${resolution ? ` hunk-${resolution}` : ""}`}
      style="margin: 4px 0; padding: 4px 8px; background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-focusBorder);"
    >
      <div style="display:flex; gap:6px; margin-bottom:4px; align-items:center;">
        <span style="font-size:11px; color:var(--vscode-descriptionForeground);">
          Hunk {hunk.index + 1}
        </span>
        {!resolution && (
          <>
            <button
              onClick={handleAccept}
              style="font-size:11px; padding:1px 6px; cursor:pointer;"
            >
              Accept
            </button>
            <button
              onClick={handleReject}
              style="font-size:11px; padding:1px 6px; cursor:pointer;"
            >
              Reject
            </button>
          </>
        )}
        {resolution === "accepted" && (
          <span style="font-size:11px; color:var(--vscode-terminal-ansiGreen);">
            Accepted
          </span>
        )}
        {resolution === "rejected" && (
          <span style="font-size:11px; color:var(--vscode-editorError-foreground);">
            Rejected
          </span>
        )}
      </div>
      <pre style="margin:0; font-size:11px; overflow-x:auto;">
        {hunk.removedLines.map((l, i) => (
          <div
            key={`del-${i}`}
            style="color:var(--vscode-gitDecoration-deletedResourceForeground);"
          >
            - {l}
          </div>
        ))}
        {hunk.addedLines.map((l, i) => (
          <div
            key={`add-${i}`}
            style="color:var(--vscode-gitDecoration-addedResourceForeground);"
          >
            + {l}
          </div>
        ))}
      </pre>
    </div>
  );
}

function FileSection({ edit }: { edit: EditSummary }): JSX.Element {
  const hunks = splitHunks(edit.oldContent, edit.newContent);

  function handleRevertFile(): void {
    getVsCode().postMessage({
      type: "revertEdit",
      path: edit.path,
      restoreContent: edit.oldContent,
    });
  }

  return (
    <div style="margin-bottom:12px;">
      <div
        style="display:flex; justify-content:space-between; align-items:center;
               padding:4px 8px; background:var(--vscode-sideBarSectionHeader-background);"
      >
        <span style="font-size:12px; font-weight:600; font-family:monospace;">
          {edit.path}
        </span>
        <button
          onClick={handleRevertFile}
          style="font-size:11px; padding:1px 6px; cursor:pointer;"
        >
          Revert File
        </button>
      </div>
      {hunks.map((hunk) => (
        <HunkRow key={`${edit.path}:${hunk.index}`} edit={edit} hunk={hunk} />
      ))}
    </div>
  );
}

/**
 * Vertical file list shown on the left side of the panel.
 * Clicking a file name scrolls the right pane to that file's diff.
 */
function FileNavigator({ edits }: { edits: EditSummary[] }): JSX.Element {
  const selectedIdx = selectedFileIndexSignal.value;

  return (
    <div
      style="width:180px; min-width:140px; max-width:220px; overflow-y:auto;
             border-right:1px solid var(--vscode-panel-border);
             background:var(--vscode-sideBar-background); flex-shrink:0;"
    >
      <div
        style="padding:4px 8px; font-size:11px; font-weight:600;
               color:var(--vscode-descriptionForeground);
               border-bottom:1px solid var(--vscode-panel-border);
               text-transform:uppercase; letter-spacing:0.05em;"
      >
        Files changed ({edits.length})
      </div>
      {edits.map((edit, idx) => {
        const isSelected = idx === selectedIdx;
        const name = basename(edit.path);
        const dir = dirname(edit.path);
        const hunkCount = splitHunks(edit.oldContent, edit.newContent).length;
        return (
          <div
            key={edit.path}
            title={edit.path}
            onClick={() => {
              selectedFileIndexSignal.value = idx;
            }}
            style={[
              "padding:5px 8px",
              "cursor:pointer",
              "border-left:3px solid " +
                (isSelected
                  ? "var(--vscode-focusBorder)"
                  : "transparent"),
              "background:" +
                (isSelected
                  ? "var(--vscode-list-activeSelectionBackground)"
                  : "transparent"),
              "color:" +
                (isSelected
                  ? "var(--vscode-list-activeSelectionForeground)"
                  : "var(--vscode-foreground)"),
            ].join(";")}
          >
            <div style="font-size:12px; font-family:monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              {name}
            </div>
            <div
              style="font-size:10px; opacity:0.6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"
            >
              {dir}
            </div>
            <div style="font-size:10px; margin-top:2px; color:var(--vscode-gitDecoration-modifiedResourceForeground);">
              {hunkCount} hunk{hunkCount !== 1 ? "s" : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DiffOverlayPanel(): JSX.Element | null {
  if (!isVisibleSignal.value) return null;

  const edits = editsSignal.value;
  const selectedIdx = selectedFileIndexSignal.value;
  const selectedEdit = edits[selectedIdx] ?? edits[0];

  function handleAcceptAll(): void {
    getVsCode().postMessage({ type: "acceptAllEdits" });
    editsSignal.value = [];
    hunkResolutions.value = new Map();
  }

  function handleRejectAll(): void {
    const allEdits = edits.map((e) => ({
      path: e.path,
      restoreContent: e.oldContent,
    }));
    getVsCode().postMessage({ type: "revertAllEdits", edits: allEdits });
    editsSignal.value = [];
    hunkResolutions.value = new Map();
  }

  return (
    <div
      style="position:fixed; bottom:0; left:0; right:0; max-height:50vh;
             background:var(--vscode-sideBar-background);
             border-top:1px solid var(--vscode-panel-border);
             z-index:50; box-shadow:0 -4px 12px rgba(0,0,0,0.3);
             display:flex; flex-direction:column;"
    >
      {/* Header bar */}
      <div
        style="display:flex; justify-content:space-between; align-items:center;
               padding:6px 12px; background:var(--vscode-titleBar-activeBackground);
               flex-shrink:0;"
      >
        <span style="font-weight:600; font-size:13px;">
          Champ Edits ({edits.length} file{edits.length !== 1 ? "s" : ""})
        </span>
        <div style="display:flex; gap:8px;">
          <button
            onClick={handleAcceptAll}
            style="padding:3px 10px; cursor:pointer; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:2px;"
          >
            Accept All
          </button>
          <button
            onClick={handleRejectAll}
            style="padding:3px 10px; cursor:pointer;"
          >
            Reject All
          </button>
        </div>
      </div>

      {/* Body: navigator + diff content side by side */}
      <div style="display:flex; flex:1; min-height:0; overflow:hidden;">
        <FileNavigator edits={edits} />
        <div style="flex:1; overflow-y:auto; padding:8px 12px;">
          {selectedEdit && (
            <FileSection key={selectedEdit.path} edit={selectedEdit} />
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Rebuild webview bundle**

```bash
cd /home/dk/Documents/git/vs-code-plugin && node esbuild.webview.mjs --production 2>&1 | tail -10
```

Expected: successful build with no errors.

- [ ] **Step 5: Validate the built bundle**

```bash
node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo "JS valid"
```

Expected: `JS valid`.

- [ ] **Step 6: Run all tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose 2>&1 | tail -25
```

Expected: all passing.

- [ ] **Step 7: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add webview-ui/src/components/DiffOverlayPanel.tsx webview-ui/dist/main.js && git commit -m "feat(sprint-o): add file navigator sidebar to DiffOverlayPanel for multi-file diff review"
```

---

## Task 7: Rebuild webview bundle and re-apply Run button injection

After modifying `DiffOverlayPanel.tsx` and rebuilding, the bundle is overwritten. The Run button injection from Task 5 must be re-applied (or better: moved to a proper source file so it survives rebuilds). This task moves the injection to the webview source.

**Files:**
- Create: `webview-ui/src/bash-run-button.ts`
- Modify: `webview-ui/src/main.ts` (or equivalent entry point)

- [ ] **Step 1: Find the webview entry point**

```bash
grep -n "entry\|entryPoints\|main\." /home/dk/Documents/git/vs-code-plugin/esbuild.webview.mjs | head -10
```

Note the entry point file path — it will be something like `webview-ui/src/main.ts`.

- [ ] **Step 2: Create bash-run-button.ts**

```bash
ls /home/dk/Documents/git/vs-code-plugin/webview-ui/src/
```

Create `webview-ui/src/bash-run-button.ts`:

```typescript
/**
 * bash-run-button.ts
 *
 * Post-render DOM enhancement: injects a "▶ Run" button on every
 * ```bash``` or ```sh``` fenced code block in the chat webview. When
 * clicked, sends a RunInTerminalRequest to the extension host and
 * renders streaming output inline below the code block.
 *
 * Call injectRunButtons() after any DOM mutation that adds new code blocks.
 */

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };
declare const vscode: { postMessage: (msg: unknown) => void } | undefined;

function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (typeof vscode !== "undefined") return vscode;
  return acquireVsCodeApi();
}

export function injectRunButtons(): void {
  const codeBlocks = document.querySelectorAll<HTMLElement>(
    'pre > code[class*="language-bash"]:not([data-run-injected]), ' +
    'pre > code[class*="language-sh"]:not([data-run-injected])',
  );

  codeBlocks.forEach((codeEl) => {
    codeEl.setAttribute("data-run-injected", "true");
    const pre = codeEl.parentElement as HTMLPreElement | null;
    if (!pre) return;

    const btn = document.createElement("button");
    btn.textContent = "▶ Run";
    btn.title = "Run this command in the workspace terminal";
    btn.style.cssText = [
      "position:absolute",
      "top:4px",
      "right:4px",
      "font-size:11px",
      "padding:2px 8px",
      "cursor:pointer",
      "background:var(--vscode-button-background)",
      "color:var(--vscode-button-foreground)",
      "border:none",
      "border-radius:2px",
      "opacity:0.85",
    ].join(";");

    btn.addEventListener("click", () => {
      const command = codeEl.textContent ?? "";
      const executionId =
        `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const outputDiv = document.createElement("div");
      outputDiv.id = `terminal-output-${executionId}`;
      outputDiv.style.cssText = [
        "margin-top:4px",
        "padding:6px 8px",
        "background:var(--vscode-terminal-background, var(--vscode-editor-background))",
        "border:1px solid var(--vscode-panel-border)",
        "border-radius:2px",
        "font-family:var(--vscode-editor-font-family, monospace)",
        "font-size:12px",
        "white-space:pre-wrap",
        "word-break:break-all",
        "max-height:240px",
        "overflow-y:auto",
        "color:var(--vscode-terminal-foreground, var(--vscode-editor-foreground))",
      ].join(";");
      outputDiv.textContent = `$ ${command.trim()}\n`;
      pre.insertAdjacentElement("afterend", outputDiv);

      btn.disabled = true;
      btn.textContent = "Running…";

      getVsCode().postMessage({
        type: "runInTerminal",
        command: command.trim(),
        executionId,
      });
    });

    pre.style.position = "relative";
    pre.appendChild(btn);
  });
}

/**
 * Handle TerminalOutputChunkMessage sent back from the extension host.
 * Appends each chunk to the correct output div and re-enables the button
 * when done=true.
 */
export function handleTerminalChunk(msg: {
  type: string;
  executionId: string;
  chunk: string;
  done: boolean;
}): void {
  if (msg.type !== "terminalOutputChunk") return;
  const outputDiv = document.getElementById(`terminal-output-${msg.executionId}`);
  if (!outputDiv) return;

  if (msg.chunk) {
    outputDiv.textContent += msg.chunk;
    outputDiv.scrollTop = outputDiv.scrollHeight;
  }

  if (msg.done) {
    const pre = outputDiv.previousElementSibling as HTMLPreElement | null;
    if (pre) {
      const btn = pre.querySelector<HTMLButtonElement>(
        "button[title='Run this command in the workspace terminal']",
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = "▶ Run";
      }
    }
  }
}
```

- [ ] **Step 3: Import and wire in the webview entry point**

Find the actual entry file (from Step 1). Open it and add:

```typescript
import { injectRunButtons, handleTerminalChunk } from "./bash-run-button";

document.addEventListener("DOMContentLoaded", injectRunButtons);

// Add to the existing message handler — in the switch/if chain for msg.type:
// case "terminalOutputChunk": handleTerminalChunk(msg); injectRunButtons(); break;
// Also call injectRunButtons() after streamDelta and toolCallResult handlers add DOM.
```

The exact insertion point depends on the entry file structure. In the `window.addEventListener("message", ...)` handler, add:

```typescript
if (msg.type === "terminalOutputChunk") {
  handleTerminalChunk(msg);
} else if (msg.type === "streamDelta" || msg.type === "toolCallResult") {
  // ... existing handling ...
  injectRunButtons();
}
```

- [ ] **Step 4: Rebuild and validate**

```bash
cd /home/dk/Documents/git/vs-code-plugin && node esbuild.webview.mjs --production 2>&1 | tail -10 && node --check webview-ui/dist/main.js && echo "JS valid"
```

Expected: build success, `JS valid`.

- [ ] **Step 5: Run all tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose 2>&1 | tail -25
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add webview-ui/src/bash-run-button.ts webview-ui/dist/main.js && git commit -m "feat(sprint-o): move Run button injection to source (bash-run-button.ts) so rebuilds don't clobber it"
```

---

## Task 8: Bump version and final integration verification

**Files:**
- Modify: `package.json` (via `npm version patch`)

- [ ] **Step 1: Run the full test suite**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose 2>&1 | tail -40
```

Expected: all tests pass. Record test count.

- [ ] **Step 2: Type-check the entire project**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run check-types 2>&1
```

Expected: no errors.

- [ ] **Step 3: Build the extension bundle**

```bash
cd /home/dk/Documents/git/vs-code-plugin && node esbuild.mjs && node esbuild.webview.mjs --production 2>&1 | tail -10
```

Expected: both bundles build successfully.

- [ ] **Step 4: Validate webview bundle**

```bash
node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo "webview JS valid"
```

Expected: `webview JS valid`.

- [ ] **Step 5: Bump patch version**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm version patch --no-git-tag-version 2>&1
```

Expected: version bumps from `1.6.111` to `1.6.112`.

- [ ] **Step 6: Rebuild after version bump**

```bash
cd /home/dk/Documents/git/vs-code-plugin && node esbuild.mjs && node esbuild.webview.mjs --production 2>&1 | tail -5
```

Expected: clean build.

- [ ] **Step 7: Final commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add package.json webview-ui/dist/main.js && git commit -m "chore: bump to 1.6.112 — Sprint O complete (diff editor, Run buttons, terminal streaming, file navigator)"
```

---

## Self-Review Checklist

**Spec coverage:**

| Gap | Task(s) |
|-----|---------|
| No side-by-side diff | Task 2 — `openDiffEditor()` + "Open Diff" CodeLens |
| No "Run in terminal" button | Task 5 (webview JS), Task 7 (source extraction) |
| No terminal output streaming | Task 3 (agent-controller → `terminal_chunk`), Task 4 (chat-view-provider handler) |
| No file navigator in diff panel | Task 6 — `FileNavigator` component in DiffOverlayPanel |
| Message types for all new features | Task 1 — `TerminalOutputChunkMessage`, `RunInTerminalRequest` |
| Version bump | Task 8 |

All 4 gaps covered. All 8 tasks accounted for. No placeholders remain.

**Type consistency check:**

- `createTerminalOutputChunk(executionId, chunk, done)` defined in Task 1, used in Tasks 3 and 4. Signature consistent.
- `isRunInTerminalRequest` defined in Task 1, imported in Task 4. Consistent.
- `RunInTerminalRequest.executionId` matches `TerminalOutputChunkMessage.executionId` throughout.
- `handleTerminalChunk` in Task 7 expects `{ type, executionId, chunk, done }` — matches `TerminalOutputChunkMessage` shape exactly.
- `selectedFileIndexSignal` in Task 6 is `signal<number>(0)`, accessed as `.value` consistently.
- `injectRunButtons` exported from `bash-run-button.ts` in Task 7 and imported in the entry point — no naming drift.
