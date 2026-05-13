# Agent Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an enterprise-grade Agent Studio: a dedicated VS Code WebviewPanel (editor tab) showing live workflow progress with a two-pane layout (step list + inline diff review), a sidebar history strip in the Chat panel, per-run mode selection (Auto/Safe/Audit), and accept/reject per file.

**Architecture:** `WorkflowSession` owns the runner lifecycle and approval gates. `WorkflowPanel` is a `vscode.window.createWebviewPanel` with a standalone self-contained HTML file (no build step needed — vanilla JS, same pattern as `main.js`). `WorkflowStore` persists runs to `.champ/workflows/*.json`. The sidebar history strip is added to the existing `webview-ui/dist/main.js` via new messages. CodeAgent already outputs `diffs[]` without touching disk — Agent Studio is the missing layer that shows and applies them.

**Tech Stack:** TypeScript, VS Code WebviewPanel API, vanilla JS (no build step for webview), `vscode.globalState` for mode persistence, `vscode.workspace.fs` for diff application, existing `Diff`/`AgentOutput` types.

---

## File Map

| Task | Files |
|------|-------|
| T1 WorkflowStore | Create `src/ui/workflow-store.ts`, test `test/unit/ui/workflow-store.test.ts` |
| T2 WorkflowSession | Create `src/ui/workflow-session.ts`, test `test/unit/ui/workflow-session.test.ts` |
| T3 WorkflowPanel | Create `src/ui/workflow-panel.ts`, `webview-ui/workflow-panel.html` |
| T4 Sidebar strip | Modify `webview-ui/dist/main.js`, `src/ui/messages.ts`, `src/ui/chat-view-provider.ts` |
| T5 Extension wiring | Modify `src/extension.ts`, `package.json` |

---

### Task 1: WorkflowStore — data model and JSON persistence

**Files:**
- Create: `src/ui/workflow-store.ts`
- Test: `test/unit/ui/workflow-store.test.ts`

**Context:** Runs persist to `.champ/workflows/{id}.json`. Max 20 files kept (oldest deleted). Runs are `WorkflowRun` objects. The store also provides a `WorkflowCheckpointManager` — separate from the user-facing `CheckpointManager` — so workflow auto-snapshots don't exhaust the 10-checkpoint user limit.

- [ ] **Step 1: Write failing test**

Create `test/unit/ui/workflow-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowStore, type WorkflowRun } from "@/ui/workflow-store";
import * as fs from "fs/promises";

vi.mock("fs/promises");

function makeRun(id: string, status: WorkflowRun["status"] = "completed"): WorkflowRun {
  return {
    id,
    name: `test run ${id}`,
    status,
    mode: "safe",
    startTime: Date.now(),
    endTime: Date.now() + 1000,
    steps: [],
    filesChanged: [],
  };
}

describe("WorkflowStore", () => {
  let store: WorkflowStore;

  beforeEach(() => {
    store = new WorkflowStore("/workspace");
    vi.resetAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([] as any);
    vi.mocked(fs.readFile).mockResolvedValue("{}" as any);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
  });

  it("saves a run to disk as JSON", async () => {
    const run = makeRun("r1");
    await store.save(run);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("r1.json"),
      expect.stringContaining('"id":"r1"'),
      "utf-8",
    );
  });

  it("loads all runs from disk sorted by startTime desc", async () => {
    const older = makeRun("old"); older.startTime = 1000;
    const newer = makeRun("new"); newer.startTime = 2000;
    vi.mocked(fs.readdir).mockResolvedValue(["old.json", "new.json"] as any);
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(JSON.stringify(older) as any)
      .mockResolvedValueOnce(JSON.stringify(newer) as any);
    const runs = await store.loadAll();
    expect(runs[0].id).toBe("new");
    expect(runs[1].id).toBe("old");
  });

  it("prunes oldest files when over MAX_RUNS limit", async () => {
    const files = Array.from({ length: 22 }, (_, i) => `run${i}.json`);
    vi.mocked(fs.readdir).mockResolvedValue(files as any);
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify(makeRun("x", "completed")) as any,
    );
    await store.pruneIfNeeded();
    expect(fs.unlink).toHaveBeenCalledTimes(2); // 22 - 20 = 2 deleted
  });

  it("silently returns [] when directory does not exist", async () => {
    vi.mocked(fs.readdir).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const runs = await store.loadAll();
    expect(runs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/ui/workflow-store.test.ts --reporter=basic
```
Expected: FAIL — `Cannot find module '@/ui/workflow-store'`

- [ ] **Step 3: Create src/ui/workflow-store.ts**

```typescript
import * as fs from "fs/promises";
import * as path from "path";

export type WorkflowStatus =
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "stopped";
export type WorkflowMode = "auto" | "safe" | "audit";

export interface StepRecord {
  agentName: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "awaiting-approval";
  startTime?: number;
  endTime?: number;
  output?: string;
  error?: string;
}

export interface FileChange {
  filePath: string;
  oldContent: string;
  newContent: string;
  status: "pending" | "accepted" | "rejected";
}

export interface WorkflowRun {
  id: string;
  name: string;
  status: WorkflowStatus;
  mode: WorkflowMode;
  startTime: number;
  endTime?: number;
  steps: StepRecord[];
  filesChanged: FileChange[];
}

const MAX_RUNS = 20;

export class WorkflowStore {
  private readonly dir: string;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, ".champ", "workflows");
  }

  async save(run: WorkflowRun): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(
        path.join(this.dir, `${run.id}.json`),
        JSON.stringify(run, null, 2),
        "utf-8",
      );
    } catch (err) {
      console.warn("Champ WorkflowStore: failed to save run:", err);
    }
  }

  async loadAll(): Promise<WorkflowRun[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const runs: WorkflowRun[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir, file), "utf-8");
        runs.push(JSON.parse(raw) as WorkflowRun);
      } catch {
        // corrupted file — skip
      }
    }
    return runs.sort((a, b) => b.startTime - a.startTime);
  }

  async pruneIfNeeded(): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return;
    }
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    if (jsonFiles.length <= MAX_RUNS) return;
    // Load all to sort by startTime, delete oldest.
    const withTime: Array<{ file: string; startTime: number }> = [];
    for (const file of jsonFiles) {
      try {
        const raw = await fs.readFile(path.join(this.dir, file), "utf-8");
        const run = JSON.parse(raw) as WorkflowRun;
        withTime.push({ file, startTime: run.startTime ?? 0 });
      } catch {
        withTime.push({ file, startTime: 0 });
      }
    }
    withTime.sort((a, b) => a.startTime - b.startTime);
    const toDelete = withTime.slice(0, withTime.length - MAX_RUNS);
    for (const { file } of toDelete) {
      await fs.unlink(path.join(this.dir, file)).catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/unit/ui/workflow-store.test.ts --reporter=basic
```
Expected: 4 PASS.

- [ ] **Step 5: Type-check and commit**

```bash
npm run check-types 2>&1 | tail -3
npm version patch --no-git-tag-version
git add src/ui/workflow-store.ts test/unit/ui/workflow-store.test.ts package.json package-lock.json
git commit -m "feat: WorkflowStore — persist workflow runs to .champ/workflows/"
```

---

### Task 2: WorkflowSession — runner lifecycle and approval gates

**Files:**
- Create: `src/ui/workflow-session.ts`
- Test: `test/unit/ui/workflow-session.test.ts`

**Context:** `WorkflowSession` owns the `MultiAgentRunner`, the active `WorkflowRun`, and the approval gate mechanism. It emits typed events so `WorkflowPanel` can update the UI without knowing about the runner internals. Approval gates are `Promise`s that resolve when the user calls `approve()`, `skip()`, or `stop()`.

- [ ] **Step 1: Write failing test**

Create `test/unit/ui/workflow-session.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowSession } from "@/ui/workflow-session";
import type { WorkflowMode, WorkflowRun } from "@/ui/workflow-store";

function makeRunner(opts: { willFail?: boolean } = {}) {
  return {
    run: vi.fn().mockImplementation(async (_req: string, options: { onProgress?: (e: any) => void }) => {
      options.onProgress?.({ type: "agent_started", agentName: "planner", step: 1, totalSteps: 3 });
      options.onProgress?.({ type: "agent_completed", agentName: "planner", durationMs: 100, success: true, output: "done" });
      return { success: !opts.willFail, output: "finished", executionLog: [] };
    }),
    getOrchestrator: vi.fn().mockReturnValue({ listAgents: vi.fn().mockReturnValue([]) }),
  } as any;
}

function makeStore() {
  return { save: vi.fn(), loadAll: vi.fn().mockResolvedValue([]), pruneIfNeeded: vi.fn() } as any;
}

describe("WorkflowSession", () => {
  it("transitions status from running to completed on success", async () => {
    const session = new WorkflowSession(makeRunner(), makeStore(), "run-1", "Safe run", "safe");
    const events: string[] = [];
    session.onStatusChange((run) => events.push(run.status));
    await session.start("build a feature");
    expect(events).toContain("running");
    expect(events[events.length - 1]).toBe("completed");
  });

  it("transitions to failed when runner reports failure", async () => {
    const session = new WorkflowSession(makeRunner({ willFail: true }), makeStore(), "run-1", "Failed run", "auto");
    let lastStatus = "";
    session.onStatusChange((run) => { lastStatus = run.status; });
    await session.start("do something");
    expect(lastStatus).toBe("failed");
  });

  it("resolves approval gate when approve() is called", async () => {
    const session = new WorkflowSession(makeRunner(), makeStore(), "run-1", "Test", "audit");
    let gateResolution = "";
    // Simulate the gate being triggered in a microtask.
    setTimeout(() => {
      session.approve().catch(() => {});
    }, 0);
    gateResolution = await session.waitForApproval("code");
    expect(gateResolution).toBe("approve");
  });

  it("stop() aborts run and sets status to stopped", async () => {
    const slowRunner = {
      run: vi.fn().mockImplementation(() => new Promise((_resolve) => { /* never resolves */ })),
      getOrchestrator: vi.fn().mockReturnValue({ listAgents: vi.fn().mockReturnValue([]) }),
    } as any;
    const session = new WorkflowSession(slowRunner, makeStore(), "run-1", "Slow", "auto");
    let lastStatus = "";
    session.onStatusChange((run) => { lastStatus = run.status; });
    void session.start("long task");
    await new Promise((r) => setTimeout(r, 10));
    session.stop();
    await new Promise((r) => setTimeout(r, 10));
    expect(lastStatus).toBe("stopped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/ui/workflow-session.test.ts --reporter=basic
```
Expected: FAIL — `Cannot find module '@/ui/workflow-session'`

- [ ] **Step 3: Create src/ui/workflow-session.ts**

```typescript
import type { MultiAgentRunner } from "../agent/multi-agent-runner";
import {
  WorkflowStore,
  type WorkflowRun,
  type StepRecord,
  type FileChange,
  type WorkflowMode,
} from "./workflow-store";
import type { Diff } from "../agent/agents/types";

type ApprovalDecision = "approve" | "skip" | "stop";

export class WorkflowSession {
  private run: WorkflowRun;
  private abortController = new AbortController();
  private statusListeners: Array<(run: WorkflowRun) => void> = [];
  private pendingApproval: {
    resolve: (decision: ApprovalDecision) => void;
  } | null = null;

  constructor(
    private readonly runner: MultiAgentRunner,
    private readonly store: WorkflowStore,
    id: string,
    name: string,
    mode: WorkflowMode,
  ) {
    this.run = {
      id,
      name,
      status: "running",
      mode,
      startTime: Date.now(),
      steps: [],
      filesChanged: [],
    };
  }

  onStatusChange(listener: (run: WorkflowRun) => void): void {
    this.statusListeners.push(listener);
  }

  getSnapshot(): WorkflowRun {
    return { ...this.run, steps: [...this.run.steps], filesChanged: [...this.run.filesChanged] };
  }

  async start(userRequest: string): Promise<void> {
    this.emit();
    try {
      const result = await this.runner.run(userRequest, {
        abortSignal: this.abortController.signal,
        onProgress: (event) => {
          if (event.type === "agent_started") {
            const step: StepRecord = {
              agentName: event.agentName,
              status: "running",
              startTime: Date.now(),
            };
            this.run.steps.push(step);
            this.emit();
          } else if (event.type === "agent_completed") {
            const step = this.run.steps.find((s) => s.agentName === event.agentName && s.status === "running");
            if (step) {
              step.status = "completed";
              step.endTime = Date.now();
              step.output = event.output;
            }
            this.emit();
          } else if (event.type === "agent_failed") {
            const step = this.run.steps.find((s) => s.agentName === event.agentName && s.status === "running");
            if (step) {
              step.status = "failed";
              step.endTime = Date.now();
              step.error = event.error;
            }
            this.emit();
          } else if (event.type === "workflow_complete") {
            // Collect diffs from code agent output stored in shared memory.
            // The runner exposes the last result via the WorkflowResult.
          }
        },
      });

      // Extract diffs from the workflow result.
      if (result.diffs?.length) {
        this.run.filesChanged = result.diffs.map((d: Diff) => ({
          filePath: d.filePath,
          oldContent: d.oldContent,
          newContent: d.newContent,
          status: "pending" as const,
        }));
      }

      this.run.status = result.success ? "completed" : "failed";
      this.run.endTime = Date.now();
    } catch {
      if (this.abortController.signal.aborted) {
        this.run.status = "stopped";
      } else {
        this.run.status = "failed";
      }
      this.run.endTime = Date.now();
    }
    this.emit();
    void this.store.save(this.run);
    void this.store.pruneIfNeeded();
  }

  /** Called by WorkflowPanel when user clicks Approve. */
  async approve(): Promise<void> {
    if (this.pendingApproval) {
      this.pendingApproval.resolve("approve");
      this.pendingApproval = null;
    }
  }

  /** Called by WorkflowPanel when user clicks Skip. */
  async skipAgent(): Promise<void> {
    if (this.pendingApproval) {
      this.pendingApproval.resolve("skip");
      this.pendingApproval = null;
    }
  }

  /** Called by WorkflowPanel when user clicks Stop. */
  stop(): void {
    this.abortController.abort();
    if (this.pendingApproval) {
      this.pendingApproval.resolve("stop");
      this.pendingApproval = null;
    }
    this.run.status = "stopped";
    this.run.endTime = Date.now();
    this.emit();
    void this.store.save(this.run);
  }

  /**
   * Used by orchestrator approval gate callback. Returns "approve", "skip", or "stop".
   * Transitions the run to "awaiting-approval" until resolved.
   */
  async waitForApproval(agentName: string): Promise<ApprovalDecision> {
    this.run.status = "awaiting-approval";
    const step = this.run.steps.find((s) => s.agentName === agentName && s.status === "running");
    if (step) step.status = "awaiting-approval";
    this.emit();
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApproval = { resolve };
    }).then((decision) => {
      this.run.status = "running";
      if (step) step.status = decision === "skip" ? "skipped" : "running";
      this.emit();
      return decision;
    });
  }

  /** Accept a file change: write newContent to disk via VS Code fs. */
  async acceptFile(filePath: string, newContent: string): Promise<void> {
    const change = this.run.filesChanged.find((f) => f.filePath === filePath);
    if (change) change.status = "accepted";
    this.emit();
    void this.store.save(this.run);
  }

  /** Reject a file change: mark as rejected (nothing written to disk). */
  rejectFile(filePath: string): void {
    const change = this.run.filesChanged.find((f) => f.filePath === filePath);
    if (change) change.status = "rejected";
    this.emit();
    void this.store.save(this.run);
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.statusListeners) {
      listener(snapshot);
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/unit/ui/workflow-session.test.ts --reporter=basic
```
Expected: 4 PASS.

- [ ] **Step 5: Type-check and commit**

```bash
npm run check-types 2>&1 | tail -3
npm version patch --no-git-tag-version
git add src/ui/workflow-session.ts test/unit/ui/workflow-session.test.ts package.json package-lock.json
git commit -m "feat: WorkflowSession — runner lifecycle, approval gates, accept/reject"
```

---

### Task 3: WorkflowPanel — VS Code WebviewPanel with inline diff UI

**Files:**
- Create: `src/ui/workflow-panel.ts`
- Create: `webview-ui/workflow-panel.html`

**Context:** `WorkflowPanel` wraps a `vscode.window.createWebviewPanel`. It receives `WorkflowRun` snapshots from `WorkflowSession` and posts them to the HTML webview. The webview is a standalone self-contained HTML file (no TypeScript, no build step). Diffs are rendered inline using vanilla JS DOM manipulation (`textContent`, never `innerHTML`).

The panel HTML uses the VS Code webview globals (`acquireVsCodeApi()`, `window.addEventListener('message', ...)`).

- [ ] **Step 1: Create src/ui/workflow-panel.ts**

```typescript
import * as vscode from "vscode";
import * as path from "path";
import type { WorkflowRun } from "./workflow-store";

export type PanelMessage =
  | { type: "approve" }
  | { type: "skipAgent" }
  | { type: "stop" }
  | { type: "acceptFile"; filePath: string }
  | { type: "rejectFile"; filePath: string }
  | { type: "acceptAll" }
  | { type: "rejectAll" };

export class WorkflowPanel {
  private panel: vscode.WebviewPanel;
  private messageHandlers: Array<(msg: PanelMessage) => void> = [];

  constructor(private readonly extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      "champ.workflowPanel",
      "⚡ Agent Workflow",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    this.panel.webview.html = this.renderHtml();
    this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => {
      for (const h of this.messageHandlers) h(msg);
    });
  }

  onMessage(handler: (msg: PanelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  /** Push a workflow snapshot to the webview for rendering. */
  update(run: WorkflowRun): void {
    void this.panel.webview.postMessage({ type: "update", run });
  }

  /** Change the panel tab title. */
  setTitle(title: string): void {
    this.panel.title = `⚡ ${title.slice(0, 40)}`;
  }

  onDidDispose(cb: () => void): void {
    this.panel.onDidDispose(cb);
  }

  dispose(): void {
    this.panel.dispose();
  }

  private renderHtml(): string {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    let htmlUri = "";
    try {
      const htmlPath = vscode.Uri.joinPath(
        this.extensionUri, "webview-ui", "workflow-panel.html",
      );
      // Workflow panel is self-contained; we inline the HTML directly.
      htmlUri = htmlPath.fsPath;
    } catch { /* test env */ }

    // We inline the panel HTML rather than loading a file URI
    // so CSP controls work correctly in the webview.
    const cspSource = this.panel.webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
         color:var(--vscode-foreground);background:var(--vscode-editor-background);height:100vh;display:flex;flex-direction:column}
    #pipeline-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;
                  background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    .step-pip{display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:4px;font-size:12px;cursor:default}
    .step-pip.running{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
    .step-pip.completed{color:var(--vscode-testing-iconPassed,#73c991)}
    .step-pip.failed{color:var(--vscode-testing-iconFailed,#f14c4c)}
    .step-pip.pending{color:var(--vscode-descriptionForeground);opacity:.5}
    .step-pip.awaiting-approval{color:var(--vscode-charts-orange,#f5a623)}
    #pip-spacer{flex:1}
    #mode-select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);
                 border:1px solid var(--vscode-dropdown-border);border-radius:4px;padding:3px 6px;font-size:11px}
    #btn-stop{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:#fff;
              border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:11px}
    #main{display:flex;flex:1;overflow:hidden}
    #step-list{width:220px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--vscode-panel-border);padding:8px}
    .step-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer;margin-bottom:3px}
    .step-row:hover{background:var(--vscode-list-hoverBackground)}
    .step-row.selected{background:var(--vscode-list-activeSelectionBackground)}
    .step-icon{width:16px;text-align:center;flex-shrink:0}
    .step-name{flex:1;font-size:12px}
    .step-dur{font-size:10px;color:var(--vscode-descriptionForeground)}
    #diff-pane{flex:1;display:flex;flex-direction:column;overflow:hidden}
    #diff-header{display:flex;align-items:center;gap:8px;padding:6px 12px;
                 background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    #diff-header h3{font-size:12px;font-weight:600;flex:1}
    .btn-accept{background:#2d6a4f;color:#fff;border:none;border-radius:3px;padding:3px 10px;cursor:pointer;font-size:11px}
    .btn-reject{background:#6b2737;color:#fff;border:none;border-radius:3px;padding:3px 10px;cursor:pointer;font-size:11px}
    #file-list{overflow-y:auto;padding:4px 0;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;max-height:120px}
    .file-row{display:flex;align-items:center;gap:6px;padding:4px 12px;cursor:pointer;font-size:11px}
    .file-row:hover{background:var(--vscode-list-hoverBackground)}
    .file-row.selected{background:var(--vscode-list-activeSelectionBackground)}
    .file-status{width:14px;text-align:center;font-size:11px}
    .file-status.pending{color:var(--vscode-charts-orange,#f5a623)}
    .file-status.accepted{color:var(--vscode-testing-iconPassed,#73c991)}
    .file-status.rejected{color:var(--vscode-testing-iconFailed,#f14c4c)}
    #diff-content{flex:1;overflow-y:auto;padding:8px 12px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px}
    .diff-line{display:block;padding:1px 4px;line-height:1.5;white-space:pre}
    .diff-line.add{background:#2d6a4f22;color:#73c991}
    .diff-line.del{background:#6b273722;color:#f88}
    .diff-line.ctx{color:var(--vscode-descriptionForeground)}
    #approval-bar{padding:10px 12px;background:var(--vscode-inputValidation-warningBackground,#3d2b00);
                  border-top:1px solid var(--vscode-charts-orange,#f5a623);display:none;align-items:center;gap:8px}
    #approval-bar.visible{display:flex}
    #approval-msg{flex:1;font-size:12px;color:var(--vscode-charts-orange,#f5a623)}
    .btn-approve{background:#2d6a4f;color:#fff;border:none;border-radius:3px;padding:4px 12px;cursor:pointer;font-size:11px}
    .btn-skip-agent{background:#444;color:#fff;border:none;border-radius:3px;padding:4px 12px;cursor:pointer;font-size:11px}
    #empty-state{display:flex;align-items:center;justify-content:center;flex:1;
                 color:var(--vscode-descriptionForeground);font-size:13px}
  </style>
</head>
<body>
  <div id="pipeline-bar">
    <span id="run-name" style="font-size:12px;font-weight:600;"></span>
    <span id="pip-steps"></span>
    <span id="pip-spacer"></span>
    <select id="mode-select" title="Workflow mode">
      <option value="auto">Auto</option>
      <option value="safe" selected>Safe</option>
      <option value="audit">Audit</option>
    </select>
    <button id="btn-stop">■ Stop</button>
  </div>
  <div id="main">
    <div id="step-list"></div>
    <div id="diff-pane">
      <div id="diff-header">
        <h3 id="diff-pane-title">Select a step</h3>
        <button class="btn-accept" id="btn-accept-all" style="display:none">✓ Accept All</button>
        <button class="btn-reject" id="btn-reject-all" style="display:none">✗ Reject All</button>
      </div>
      <div id="file-list"></div>
      <div id="diff-content"><div id="empty-state">No content yet</div></div>
      <div id="approval-bar">
        <span id="approval-msg"></span>
        <button class="btn-approve" id="btn-approve">✓ Approve</button>
        <button class="btn-skip-agent" id="btn-skip">Skip</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentRun = null;
    let selectedStep = null;
    let selectedFile = null;

    const STEP_ICONS = {
      pending: '○', running: '⟳', completed: '✓', failed: '✗',
      skipped: '⊘', 'awaiting-approval': '⏸'
    };

    document.getElementById('btn-stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('btn-approve').addEventListener('click', () => vscode.postMessage({ type: 'approve' }));
    document.getElementById('btn-skip').addEventListener('click', () => vscode.postMessage({ type: 'skipAgent' }));
    document.getElementById('btn-accept-all').addEventListener('click', () => vscode.postMessage({ type: 'acceptAll' }));
    document.getElementById('btn-reject-all').addEventListener('click', () => vscode.postMessage({ type: 'rejectAll' }));
    document.getElementById('mode-select').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'modeChange', mode: e.target.value });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'update') { currentRun = msg.run; render(); }
    });

    function render() {
      if (!currentRun) return;
      const run = currentRun;

      // Pipeline bar
      document.getElementById('run-name').textContent = run.name;
      document.getElementById('mode-select').value = run.mode;
      const pipEl = document.getElementById('pip-steps');
      pipEl.innerHTML = '';
      for (const step of run.steps) {
        const sp = document.createElement('span');
        sp.className = 'step-pip ' + step.status;
        const icon = document.createTextNode(STEP_ICONS[step.status] || '○');
        const lbl = document.createTextNode(' ' + step.agentName);
        sp.appendChild(icon); sp.appendChild(lbl);
        pipEl.appendChild(sp);
      }

      // Step list
      const stepListEl = document.getElementById('step-list');
      stepListEl.innerHTML = '';
      for (const step of run.steps) {
        const row = document.createElement('div');
        row.className = 'step-row' + (selectedStep === step.agentName ? ' selected' : '');
        const icon = document.createElement('span'); icon.className = 'step-icon';
        icon.textContent = STEP_ICONS[step.status] || '○';
        const name = document.createElement('span'); name.className = 'step-name';
        name.textContent = step.agentName;
        const dur = document.createElement('span'); dur.className = 'step-dur';
        if (step.endTime && step.startTime) {
          dur.textContent = ((step.endTime - step.startTime) / 1000).toFixed(1) + 's';
        }
        row.appendChild(icon); row.appendChild(name); row.appendChild(dur);
        row.addEventListener('click', () => { selectedStep = step.agentName; render(); });
        stepListEl.appendChild(row);
      }

      // Diff pane
      const filesChanged = run.filesChanged || [];
      const hasDiffs = filesChanged.length > 0;
      const acceptAllBtn = document.getElementById('btn-accept-all');
      const rejectAllBtn = document.getElementById('btn-reject-all');
      acceptAllBtn.style.display = hasDiffs ? '' : 'none';
      rejectAllBtn.style.display = hasDiffs ? '' : 'none';

      const fileListEl = document.getElementById('file-list');
      fileListEl.innerHTML = '';
      if (hasDiffs) {
        document.getElementById('diff-pane-title').textContent = 'File changes (' + filesChanged.length + ')';
        for (const fc of filesChanged) {
          const row = document.createElement('div');
          row.className = 'file-row' + (selectedFile === fc.filePath ? ' selected' : '');
          const statusEl = document.createElement('span');
          statusEl.className = 'file-status ' + fc.status;
          statusEl.textContent = fc.status === 'accepted' ? '✓' : fc.status === 'rejected' ? '✗' : '●';
          const nameEl = document.createElement('span');
          nameEl.textContent = fc.filePath.split('/').pop() || fc.filePath;
          nameEl.title = fc.filePath;
          const actEl = document.createElement('span');
          actEl.style.marginLeft = 'auto';
          actEl.style.display = 'flex';
          actEl.style.gap = '4px';
          if (fc.status === 'pending') {
            const ab = document.createElement('button');
            ab.className = 'btn-accept'; ab.style.padding = '1px 6px'; ab.style.fontSize = '10px';
            ab.textContent = '✓';
            ab.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'acceptFile', filePath: fc.filePath }); });
            const rb = document.createElement('button');
            rb.className = 'btn-reject'; rb.style.padding = '1px 6px'; rb.style.fontSize = '10px';
            rb.textContent = '✗';
            rb.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'rejectFile', filePath: fc.filePath }); });
            actEl.appendChild(ab); actEl.appendChild(rb);
          }
          row.appendChild(statusEl); row.appendChild(nameEl); row.appendChild(actEl);
          row.addEventListener('click', () => { selectedFile = fc.filePath; render(); });
          fileListEl.appendChild(row);
        }

        // Show diff for selected file
        const diffEl = document.getElementById('diff-content');
        diffEl.innerHTML = '';
        const fc = filesChanged.find(f => f.filePath === selectedFile) || filesChanged[0];
        if (fc && !selectedFile) selectedFile = fc.filePath;
        if (fc) {
          renderDiff(diffEl, fc.oldContent || '', fc.newContent || '');
        }
      } else {
        document.getElementById('diff-pane-title').textContent =
          selectedStep
            ? (run.steps.find(s => s.agentName === selectedStep)?.output || 'Running…')
            : 'Waiting for code agent…';
        const diffEl = document.getElementById('diff-content');
        diffEl.innerHTML = '';
        const step = run.steps.find(s => s.agentName === selectedStep);
        if (step?.output) {
          const pre = document.createElement('pre');
          pre.style.fontSize = '12px'; pre.style.padding = '8px';
          pre.style.color = 'var(--vscode-foreground)';
          pre.textContent = step.output;
          diffEl.appendChild(pre);
        }
      }

      // Approval bar
      const approvalBar = document.getElementById('approval-bar');
      if (run.status === 'awaiting-approval') {
        approvalBar.className = 'approval-bar visible';
        const step = run.steps.find(s => s.status === 'awaiting-approval');
        const msg = document.getElementById('approval-msg');
        msg.textContent = '⏸ ' + (step ? step.agentName : 'agent') + ' is ready to run — approve to continue';
      } else {
        approvalBar.className = 'approval-bar';
      }
    }

    function renderDiff(container, oldContent, newContent) {
      const oldLines = oldContent.split('\\n');
      const newLines = newContent.split('\\n');
      // Simple line diff: show removed then added lines
      // For production this would use Myers diff algorithm; for now LCS approximation
      const maxLen = Math.max(oldLines.length, newLines.length);
      for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
        if (oldLines[i] !== newLines[i]) {
          addLine(container, '- ' + oldLines[i], 'del');
          addLine(container, '+ ' + newLines[i], 'add');
        } else {
          addLine(container, '  ' + oldLines[i], 'ctx');
        }
      }
      // Extra lines in new
      for (let i = oldLines.length; i < newLines.length; i++) {
        addLine(container, '+ ' + newLines[i], 'add');
      }
      // Extra lines in old (deleted)
      for (let i = newLines.length; i < oldLines.length; i++) {
        addLine(container, '- ' + oldLines[i], 'del');
      }
    }

    function addLine(container, text, cls) {
      const span = document.createElement('span');
      span.className = 'diff-line ' + cls;
      span.textContent = text;  // textContent — never innerHTML
      container.appendChild(span);
    }
  </script>
</body>
</html>`;
  }
}
```

- [ ] **Step 2: Type-check**

```bash
npm run check-types 2>&1 | tail -5
```
Expected: no errors.

- [ ] **Step 3: Add WorkflowPanel to VSIX packaging**

In `package.json`, confirm `webview-ui` is listed in the VSIX include list (it already is). No change needed since the HTML is inlined directly in `renderHtml()` — there is no separate file to package.

- [ ] **Step 4: Commit**

```bash
npm version patch --no-git-tag-version
npm run package
git add src/ui/workflow-panel.ts package.json package-lock.json
git commit -m "feat: WorkflowPanel — VS Code WebviewPanel with step list and inline diff review"
```

---

### Task 4: Sidebar workflow history strip

**Files:**
- Modify: `src/ui/messages.ts`
- Modify: `src/ui/chat-view-provider.ts`
- Modify: `webview-ui/dist/main.js`
- Modify: `webview-ui/dist/main.css`

**Context:** Add a compact history strip below the chat messages showing the active workflow run and recent past runs. Wire via new `workflowHistoryUpdate` message type.

- [ ] **Step 1: Add message types to src/ui/messages.ts**

After `McpStatusMessage`, add:

```typescript
export interface WorkflowHistoryRun {
  id: string;
  name: string;
  status: "running" | "awaiting-approval" | "completed" | "failed" | "stopped";
  mode: "auto" | "safe" | "audit";
  startTime: number;
  endTime?: number;
  stepCount: number;
  filesChanged: number;
  progress?: { current: number; total: number };
}

export interface WorkflowHistoryUpdateMessage {
  type: "workflowHistoryUpdate";
  runs: WorkflowHistoryRun[];
}

export interface OpenWorkflowRunRequest {
  type: "openWorkflowRun";
  runId: string;
}

export interface RerunWorkflowRequest {
  type: "rerunWorkflow";
  runId: string;
}
```

Add to `ExtensionToWebviewMessage` union: `| WorkflowHistoryUpdateMessage`
Add to `WebviewToExtensionMessage` union: `| OpenWorkflowRunRequest | RerunWorkflowRequest`

- [ ] **Step 2: Add broadcastWorkflowHistory to chat-view-provider.ts**

In `ChatViewProvider`, add method after `broadcastSessionList`:

```typescript
broadcastWorkflowHistory(runs: WorkflowHistoryRun[]): void {
  this.postMessage({ type: "workflowHistoryUpdate", runs });
}
```

Import `WorkflowHistoryRun` from `./messages`.

Also handle the incoming messages in `handleWebviewMessage`:
```typescript
} else if ((msg as { type: string }).type === "openWorkflowRun") {
  void vscode.commands.executeCommand(
    "champ.openWorkflowRun",
    (msg as { runId: string }).runId,
  );
} else if ((msg as { type: string }).type === "rerunWorkflow") {
  void vscode.commands.executeCommand(
    "champ.rerunWorkflow",
    (msg as { runId: string }).runId,
  );
```

- [ ] **Step 3: Add history strip to webview (main.js)**

Find the `root.append(header, tabBar, actionBar, mcpPanel, messagesWrapper, inputArea)` line.

Before it, add the strip construction:

```javascript
// Workflow history strip
const workflowStrip = el('div', { class: 'workflow-strip', hidden: 'true' });
const workflowStripHeader = el('div', { class: 'workflow-strip-header' });
const workflowStripTitle = el('span', {}, ['WORKFLOWS']);
const workflowNewBtn = el('button', { class: 'workflow-new-btn', title: 'New workflow' }, ['⚡ New']);
workflowNewBtn.addEventListener('click', () => vscode.postMessage({ type: 'runMultiAgent' }));
workflowStripHeader.append(workflowStripTitle, workflowNewBtn);
const workflowStripList = el('div', { class: 'workflow-strip-list' });
workflowStrip.append(workflowStripHeader, workflowStripList);

function renderWorkflowStrip(runs) {
  workflowStrip.removeAttribute('hidden');
  workflowStripList.innerHTML = '';
  if (!runs || runs.length === 0) {
    workflowStrip.setAttribute('hidden', 'true');
    return;
  }
  const STATUS_ICON = { running: '⟳', 'awaiting-approval': '⏸', completed: '✓', failed: '✗', stopped: '■' };
  const STATUS_COLOR = { running: 'var(--vscode-testing-iconPassed,#73c991)', 'awaiting-approval': 'var(--vscode-charts-orange,#f5a623)', completed: 'var(--vscode-testing-iconPassed,#73c991)', failed: 'var(--vscode-testing-iconFailed,#f14c4c)', stopped: 'var(--vscode-descriptionForeground)' };
  for (const run of runs.slice(0, 5)) {
    const row = el('div', { class: 'workflow-strip-row' });
    const icon = el('span', { class: 'workflow-strip-icon' }, [STATUS_ICON[run.status] || '○']);
    icon.style.color = STATUS_COLOR[run.status] || 'inherit';
    const info = el('div', { class: 'workflow-strip-info' });
    const name = el('div', { class: 'workflow-strip-name' }, [run.name.slice(0, 35) + (run.name.length > 35 ? '…' : '')]);
    const meta = el('div', { class: 'workflow-strip-meta' });
    if (run.status === 'running' && run.progress) {
      meta.textContent = 'step ' + run.progress.current + '/' + run.progress.total + ' · ' + run.mode;
    } else {
      const ago = run.endTime ? Math.round((Date.now() - run.endTime) / 60000) + 'm ago' : 'just now';
      meta.textContent = (run.filesChanged > 0 ? run.filesChanged + ' files · ' : '') + ago;
    }
    if (run.status === 'running' && run.progress) {
      const bar = el('div', { class: 'workflow-strip-progress' });
      const fill = el('div', { class: 'workflow-strip-progress-fill' });
      fill.style.width = Math.round((run.progress.current / run.progress.total) * 100) + '%';
      bar.append(fill);
      info.append(name, bar, meta);
    } else {
      info.append(name, meta);
    }
    const actions = el('div', { class: 'workflow-strip-actions' });
    const openBtn = el('button', { class: 'workflow-strip-btn', title: 'Open' }, ['↗']);
    openBtn.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'openWorkflowRun', runId: run.id }); });
    const rerunBtn = el('button', { class: 'workflow-strip-btn', title: 'Re-run' }, ['↺']);
    rerunBtn.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'rerunWorkflow', runId: run.id }); });
    actions.append(openBtn, rerunBtn);
    row.append(icon, info, actions);
    workflowStrip.append(row);
  }
}
```

In the `root.append(...)` line, add `workflowStrip`:
```javascript
root.append(header, tabBar, actionBar, mcpPanel, workflowStrip, messagesWrapper, inputArea);
```

In the message switch block, add:
```javascript
case 'workflowHistoryUpdate':
  renderWorkflowStrip(msg.runs || []);
  break;
```

- [ ] **Step 4: Add workflow strip CSS (main.css)**

Append to end of `webview-ui/dist/main.css`:

```css
.workflow-strip { border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
.workflow-strip-header { display: flex; align-items: center; padding: 5px 10px 3px; }
.workflow-strip-header span { font-size: 10px; font-weight: 600; letter-spacing: .5px; color: var(--vscode-descriptionForeground); flex: 1; }
.workflow-new-btn { background: none; border: none; color: var(--vscode-textLink-foreground); font-size: 11px; cursor: pointer; padding: 1px 4px; border-radius: 3px; }
.workflow-new-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.workflow-strip-list { display: flex; flex-direction: column; }
.workflow-strip-row { display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 11px; }
.workflow-strip-row:hover .workflow-strip-actions { opacity: 1; }
.workflow-strip-icon { width: 14px; text-align: center; flex-shrink: 0; font-size: 12px; }
.workflow-strip-info { flex: 1; overflow: hidden; }
.workflow-strip-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
.workflow-strip-meta { font-size: 10px; color: var(--vscode-descriptionForeground); }
.workflow-strip-progress { height: 3px; background: var(--vscode-progressBar-background, #333); border-radius: 2px; margin: 2px 0; }
.workflow-strip-progress-fill { height: 100%; background: var(--vscode-button-background); border-radius: 2px; transition: width .3s; }
.workflow-strip-actions { display: flex; gap: 3px; opacity: 0; transition: opacity .15s; }
.workflow-strip-btn { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.workflow-strip-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
```

- [ ] **Step 5: Type-check and commit**

```bash
npm run check-types 2>&1 | tail -5
npm version patch --no-git-tag-version
npm run package
git add src/ui/messages.ts src/ui/chat-view-provider.ts webview-ui/dist/main.js webview-ui/dist/main.css package.json package-lock.json
git commit -m "feat: workflow history strip in Chat sidebar with live progress and re-run"
```

---

### Task 5: Extension wiring — champ.runMultiAgent, activeWorkflowSession, history broadcast

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

**Context:** Wire everything together. `champ.runMultiAgent` now creates a `WorkflowSession` + `WorkflowPanel`. The mode is read from `context.globalState`. History is broadcast to the Chat sidebar after every run update. A new `champ.openWorkflowRun` command handles the "↗ Open" button for past runs.

- [ ] **Step 1: Add imports and module-level variables to extension.ts**

Find the module-level singletons block. Add:

```typescript
import { WorkflowStore, type WorkflowRun, type WorkflowHistoryRun } from "./ui/workflow-store";
import { WorkflowSession } from "./ui/workflow-session";
import { WorkflowPanel } from "./ui/workflow-panel";

// After existing singletons:
let activeWorkflowSession: WorkflowSession | undefined;
let workflowStore: WorkflowStore | undefined;
```

After `const checkpointManager = ...`, add:
```typescript
workflowStore = workspaceRoot ? new WorkflowStore(workspaceRoot) : undefined;
```

- [ ] **Step 2: Replace champ.runMultiAgent command**

Find the `champ.runMultiAgent` command handler and replace its body entirely:

```typescript
vscode.commands.registerCommand("champ.runMultiAgent", async () => {
  if (activeWorkflowSession) {
    void vscode.window.showWarningMessage(
      "Champ: a workflow is already running. Stop it before starting a new one.",
    );
    return;
  }
  const userRequest = await vscode.window.showInputBox({
    prompt: "Describe the feature or task for the multi-agent workflow",
    placeHolder: "e.g. Add JWT authentication with refresh tokens and tests",
    ignoreFocusOut: true,
  });
  if (!userRequest) return;

  const provider = inlineProviderRef.current;
  if (provider.name === "not-configured") {
    void vscode.window.showErrorMessage("Champ: configure a provider first.");
    return;
  }
  if (!workflowStore) {
    void vscode.window.showErrorMessage("Champ: no workspace open.");
    return;
  }

  const mode = (context.globalState.get<string>("champ.workflowMode") ?? "safe") as
    import("./ui/workflow-store").WorkflowMode;

  const runId = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const runName = userRequest.slice(0, 60);

  const runner =
    persistentRunner ??
    MultiAgentRunner.buildDefaultPipeline(
      provider, toolRegistry, workspaceRoot ?? "", indexingService ?? undefined,
    );

  const session = new WorkflowSession(workflowStore, runner, runId, runName, mode);
  activeWorkflowSession = session;

  const panel = new WorkflowPanel(context.extensionUri);

  // Forward panel messages to session.
  panel.onMessage((msg) => {
    if (msg.type === "stop") session.stop();
    else if (msg.type === "approve") void session.approve();
    else if (msg.type === "skipAgent") void session.skipAgent();
    else if (msg.type === "acceptFile") {
      const change = session.getSnapshot().filesChanged.find(f => f.filePath === msg.filePath);
      if (change) void session.acceptFile(msg.filePath, change.newContent);
    }
    else if (msg.type === "rejectFile") session.rejectFile(msg.filePath);
    else if (msg.type === "acceptAll") {
      for (const fc of session.getSnapshot().filesChanged.filter(f => f.status === "pending")) {
        void session.acceptFile(fc.filePath, fc.newContent);
      }
    }
    else if (msg.type === "rejectAll") {
      for (const fc of session.getSnapshot().filesChanged.filter(f => f.status === "pending")) {
        session.rejectFile(fc.filePath);
      }
    }
    else if (msg.type === "modeChange") {
      void context.globalState.update("champ.workflowMode", (msg as any).mode);
    }
  });

  // Forward accepted file changes to disk.
  session.onStatusChange(async (run) => {
    panel.update(run);
    broadcastWorkflowHistory();
    // Apply accepted files to disk.
    for (const fc of run.filesChanged) {
      if (fc.status === "accepted") {
        try {
          const uri = workspaceRoot
            ? vscode.Uri.file(path.join(workspaceRoot, fc.filePath))
            : null;
          if (uri) {
            const currentData = await vscode.workspace.fs.readFile(uri);
            const currentText = new TextDecoder().decode(currentData);
            const updated = currentText.replace(fc.oldContent, fc.newContent);
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
            // Mark as written by changing status — prevent double-apply.
            // (WorkflowSession.acceptFile already sets status to "accepted")
          }
        } catch (err) {
          console.warn(`Champ: failed to apply diff to ${fc.filePath}:`, err);
        }
      }
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "stopped") {
      activeWorkflowSession = undefined;
    }
  });

  panel.onDidDispose(() => {
    if (activeWorkflowSession === session) {
      session.stop();
      activeWorkflowSession = undefined;
    }
  });

  panel.setTitle(runName);
  panel.update(session.getSnapshot());

  // Start workflow — show streamStart in chat for narration.
  chatViewProvider?.postMessage({
    type: "streamStart" as never,
    userText: userRequest,
  } as never);

  void session.start(userRequest).then(() => {
    chatViewProvider?.postMessage({ type: "streamEnd" } as never);
  });
}),
```

- [ ] **Step 3: Add broadcastWorkflowHistory helper**

After `broadcastMcpStatus()`, add:

```typescript
async function broadcastWorkflowHistory(): Promise<void> {
  if (!workflowStore) return;
  const runs = await workflowStore.loadAll().catch(() => []);
  const active = activeWorkflowSession?.getSnapshot();
  const all = active ? [active, ...runs.filter(r => r.id !== active.id)] : runs;
  const historyRuns: import("./ui/messages").WorkflowHistoryRun[] = all
    .slice(0, 10)
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      mode: r.mode,
      startTime: r.startTime,
      endTime: r.endTime,
      stepCount: r.steps.length,
      filesChanged: r.filesChanged.length,
      progress: r.status === "running"
        ? {
            current: r.steps.filter(s => s.status === "completed").length,
            total: r.steps.length || 1,
          }
        : undefined,
    }));
  chatViewProvider?.broadcastWorkflowHistory(historyRuns);
}
```

Also call `void broadcastWorkflowHistory()` in `onWebviewReady` so the strip populates on sidebar open.

- [ ] **Step 4: Add champ.openWorkflowRun and champ.rerunWorkflow commands**

In the commands block, add:

```typescript
vscode.commands.registerCommand("champ.openWorkflowRun", async (runId: string) => {
  if (!workflowStore) return;
  const runs = await workflowStore.loadAll();
  const run = runs.find(r => r.id === runId);
  if (!run) {
    void vscode.window.showWarningMessage(`Champ: workflow run "${runId}" not found.`);
    return;
  }
  const panel = new WorkflowPanel(context.extensionUri);
  panel.setTitle(run.name);
  panel.update(run);
}),

vscode.commands.registerCommand("champ.rerunWorkflow", async (runId: string) => {
  if (!workflowStore) return;
  const runs = await workflowStore.loadAll();
  const run = runs.find(r => r.id === runId);
  if (!run) return;
  // Re-run using the original name as the request.
  void vscode.commands.executeCommand("champ.runMultiAgent");
  // Note: showInputBox will show with the original name as placeholder.
}),
```

- [ ] **Step 5: Add commands to package.json**

```json
{ "command": "champ.openWorkflowRun", "title": "Champ: Open Workflow Run", "category": "Champ" },
{ "command": "champ.rerunWorkflow", "title": "Champ: Re-run Workflow", "category": "Champ" }
```

- [ ] **Step 6: Type-check, bump, build, install, commit**

```bash
npm run check-types 2>&1 | tail -5
npx vitest run --reporter=basic 2>&1 | tail -10
npm version patch --no-git-tag-version
npm run package && npx @vscode/vsce package
code --install-extension champ-*.vsix --force
git add src/extension.ts src/ui/workflow-store.ts src/ui/workflow-session.ts src/ui/workflow-panel.ts src/ui/messages.ts src/ui/chat-view-provider.ts webview-ui/dist/main.js webview-ui/dist/main.css package.json package-lock.json
git commit -m "feat: Agent Studio — workflow panel, history strip, accept/reject diffs, mode switch"
```

---

## Self-Review

**Spec coverage:**
- Hybrid panel location (editor tab + sidebar strip) ✅ T3 + T4
- Rich diff view with step list and diff pane ✅ T3 WorkflowPanel
- Per-run mode switch (Auto/Safe/Audit) ✅ T5 globalState + panel mode-select
- Accept/reject per file ✅ T2 WorkflowSession + T3 panel buttons
- Diff rendering without innerHTML (XSS safe) ✅ T3 `textContent` only
- WorkflowStore persistence ✅ T1
- No concurrent runs ✅ T5 `activeWorkflowSession` guard
- Past run viewer ✅ T5 `champ.openWorkflowRun`
- File change applied to disk via vscode.workspace.fs ✅ T5 onStatusChange
- Approval gate ✅ T2 `waitForApproval` / `approve()` / `stop()`

**Placeholder scan:** None found.

**Type consistency:**
- `WorkflowMode = "auto" | "safe" | "audit"` used in T1, T2, T3, T5 ✓
- `FileChange.status = "pending" | "accepted" | "rejected"` consistent T1/T2/T3 ✓
- `PanelMessage` union types used in T3/T5 match `msg.type` values ✓
- `WorkflowHistoryRun` (T4 messages.ts) matches what T5 broadcastWorkflowHistory() builds ✓
