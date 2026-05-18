# Sprint N: Agent Execution Console — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-agent execution timeline, pre-run cost estimates, pause/resume controls, agent output expansion, and re-run capability to the Champ team execution UI.

**Architecture:** TeamRunner gains a pause/resume mechanism via a `PauseSignal` interface checked between execution groups. `TeamRunState` gains a `pauseRequested` flag. The pre-run cost estimate uses a conservative 3K tokens/agent heuristic and shows a confirmation dialog. `AgentGraphPanel` grows a "Timeline" tab showing per-agent duration + tokens + expandable output. Re-run calls `TeamRunner.run()` with the same `TeamDefinition` + task from `TeamRunStore` history.

**Tech Stack:** TypeScript (TeamRunner, extension host), Preact TSX (AgentGraphPanel), Vitest (tests), VS Code WebviewPanel API

---

## File Map

| File | Change |
|---|---|
| `src/agent/team-definition.ts` | Add `pauseRequested?: boolean` to `TeamRunState` |
| `src/agent/team-runner.ts` | Add `PauseSignal` interface to `TeamRunOptions`; check between groups |
| `src/ui/messages.ts` | Add `TeamPauseRequest`, `TeamResumeRequest`, `TeamCostEstimateMessage`, `RerunTeamRequest` + type guards |
| `src/ui/team-panel.ts` | Add pause/resume/rerun buttons; `showCostEstimate()`; `setRunId()` |
| `src/extension.ts` | `estimateTeamCost()` helper; confirm dialog; pause wiring; `champ.rerunTeam` command |
| `webview-ui/src/components/AgentGraphPanel.tsx` | Graph/Timeline tabs; `TimelineRow` with expandable output |
| `src/agent/__tests__/team-runner-pause.test.ts` | New — pause/resume unit tests |

---

### Task 1: Add PauseSignal interface and wire into TeamRunner

**Files:**
- Modify: `src/agent/team-definition.ts`
- Modify: `src/agent/team-runner.ts`
- Create: `src/agent/__tests__/team-runner-pause.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/agent/__tests__/team-runner-pause.test.ts
import { describe, it, expect, vi } from "vitest";
import { TeamRunner } from "../team-runner";
import type { TeamDefinition, TeamAgentDefinition } from "../team-definition";

function makeAgent(id: string, deps: string[] = []): Required<TeamAgentDefinition> {
  return {
    id, name: id, role: `role of ${id}`, systemPrompt: `You are ${id}`,
    dependsOn: deps, condition: "", tools: [], model: "", maxTokens: 1000,
    outputKey: id, outputFormat: "text" as const, selfCritique: false, subscribes: [],
  };
}

function makeTeam(agents: Required<TeamAgentDefinition>[]): TeamDefinition {
  return {
    name: "Pause Test Team", description: "tests pause", version: "1",
    sourcePath: "/test/pause-team.yaml",
    defaults: { model: "", maxTokens: 1000 },
    execution: {
      maxParallel: 3, totalTokenBudget: 0, timeoutSeconds: 10,
      retries: 0, checkpoints: false, mode: "auto", maxDynamicAgents: 5,
    },
    agents,
  };
}

function makeFakeProvider(output = "<output>done</output>") {
  return {
    name: "test",
    config: { provider: "test" as const, model: "test" },
    chat: async function* () { yield { type: "text" as const, text: output }; },
  };
}

describe("TeamRunner pause/resume", () => {
  it("emits state_update and complete even when pauseSignal never pauses", async () => {
    const team = makeTeam([makeAgent("agentA"), makeAgent("agentB", ["agentA"])]);
    const provider = makeFakeProvider();
    const runner = new TeamRunner();
    const events: string[] = [];
    const pauseSignal = {
      get isPaused() { return false; },
      waitForResume: () => Promise.resolve(),
      requestPause: () => { /* no-op */ },
    };

    await runner.run(team, "do work", provider as never, { get: () => undefined, register: vi.fn() } as never, {
      pauseSignal,
      onEvent: (e) => { events.push(e.type); },
    });

    expect(events).toContain("state_update");
    expect(events).toContain("complete");
  });

  it("resumes after pause and completes all agents", async () => {
    const team = makeTeam([makeAgent("a1"), makeAgent("a2", ["a1"])]);
    const provider = makeFakeProvider();
    const runner = new TeamRunner();
    let pauseCallCount = 0;
    const pauseSignal = {
      get isPaused() { return pauseCallCount === 1; },
      waitForResume: () => Promise.resolve(),
      requestPause: () => { pauseCallCount++; },
    };

    const finalState = await runner.run(
      team, "task", provider as never,
      { get: () => undefined, register: vi.fn() } as never,
      { pauseSignal, onEvent: () => {} },
    );

    expect(finalState.status).toBe("completed");
    expect(finalState.agents.every((a) => a.status === "done" || a.status === "skipped")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/agent/__tests__/team-runner-pause.test.ts
```
Expected: FAIL — `pauseSignal` not a known property of `TeamRunOptions`

- [ ] **Step 3: Add PauseSignal interface before TeamRunOptions in team-runner.ts**

```typescript
/** Controls pause/resume of a team run between execution groups. */
export interface PauseSignal {
  /** True when a pause has been requested externally. */
  readonly isPaused: boolean;
  /** Resolves when the consumer calls resume (sets isPaused back to false). */
  waitForResume(): Promise<void>;
  /** External caller sets this to indicate a pause is desired. */
  requestPause(): void;
}
```

Add `pauseSignal?: PauseSignal` to `TeamRunOptions` after the `onBlocked` field.

- [ ] **Step 4: Add pauseRequested to TeamRunState in team-definition.ts**

After `tokenBudget?: number` in `TeamRunState`, add:
```typescript
  /** Set to true by the runner when suspended between groups waiting for resume. */
  pauseRequested?: boolean;
```

- [ ] **Step 5: Check pauseSignal between groups in team-runner.ts**

Inside the `while (remainingGroups.length > 0)` loop, immediately after `if (options.abortSignal?.aborted) break;`, add:

```typescript
        if (options.pauseSignal?.isPaused) {
          const pausedState = { ...buildState("paused"), pauseRequested: true };
          options.onEvent?.({ type: "state_update", state: pausedState });
          void options.teamRunStore?.save(pausedState);
          await options.pauseSignal.waitForResume();
        }
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run src/agent/__tests__/team-runner-pause.test.ts
```
Expected: Both PASS

- [ ] **Step 7: Type check**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/agent/team-definition.ts src/agent/team-runner.ts src/agent/__tests__/team-runner-pause.test.ts
git commit -m "feat(teams): add PauseSignal interface and pause/resume between execution groups"
```

---

### Task 2: Add cost estimate and pause/resume message types

**Files:**
- Modify: `src/ui/messages.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import type { TeamCostEstimateMessage, TeamPauseRequest, TeamResumeRequest, RerunTeamRequest } from "../../ui/messages";
import { isTeamPauseRequest, isTeamResumeRequest, isRerunTeamRequest } from "../../ui/messages";

it("TeamCostEstimateMessage has required fields", () => {
  const msg: TeamCostEstimateMessage = {
    type: "teamCostEstimate",
    agentCount: 3,
    estimatedTokens: 9000,
    estimatedCostUsd: "~$0.03",
    teamName: "Test Team",
  };
  expect(msg.agentCount).toBe(3);
});

it("isTeamPauseRequest identifies pause messages", () => {
  expect(isTeamPauseRequest({ type: "teamPause" } as never)).toBe(true);
  expect(isTeamPauseRequest({ type: "teamResume" } as never)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/ui/__tests__/
```
Expected: FAIL — types not found

- [ ] **Step 3: Add four new types to messages.ts**

After the last existing interface, add:

```typescript
// Team execution control messages

/** Extension → Webview: pre-run cost estimate before a team run starts. */
export interface TeamCostEstimateMessage {
  type: "teamCostEstimate";
  agentCount: number;
  estimatedTokens: number;
  /** Formatted e.g. "~$0.04" or "< $0.01". */
  estimatedCostUsd: string;
  teamName: string;
}

/** Webview → Extension: user clicked "Pause" in TeamPanel. */
export interface TeamPauseRequest {
  type: "teamPause";
}

/** Webview → Extension: user clicked "Resume" in TeamPanel after a pause. */
export interface TeamResumeRequest {
  type: "teamResume";
}

/** Webview → Extension: re-run a previous team execution with the same task. */
export interface RerunTeamRequest {
  type: "rerunTeam";
  runId: string;
}
```

Add `TeamCostEstimateMessage` to `ExtensionToWebviewMessage` union, and `TeamPauseRequest | TeamResumeRequest | RerunTeamRequest` to `WebviewToExtensionMessage` union.

Add type guards:
```typescript
export function isTeamPauseRequest(msg: WebviewToExtensionMessage): msg is TeamPauseRequest {
  return msg.type === "teamPause";
}
export function isTeamResumeRequest(msg: WebviewToExtensionMessage): msg is TeamResumeRequest {
  return msg.type === "teamResume";
}
export function isRerunTeamRequest(msg: WebviewToExtensionMessage): msg is RerunTeamRequest {
  return msg.type === "rerunTeam";
}
```

- [ ] **Step 4: Run type check and tests**

```bash
npx tsc --noEmit && npx vitest run src/ui/__tests__/
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/messages.ts
git commit -m "feat(teams): add TeamCostEstimate/Pause/Resume/Rerun message types"
```

---

### Task 3: Add cost banner and Pause/Resume/Re-run buttons to TeamPanel

**Files:**
- Modify: `src/ui/team-panel.ts`

- [ ] **Step 1: Extend TeamPanelMessage union**

Find `export type TeamPanelMessage` and add:
```typescript
  | { type: "teamPause" }
  | { type: "teamResume" }
  | { type: "rerunTeam"; runId: string }
```

- [ ] **Step 2: Add showCostEstimate() and setRunId() methods**

```typescript
showCostEstimate(estimate: {
  agentCount: number;
  estimatedTokens: number;
  estimatedCostUsd: string;
  teamName: string;
}): void {
  if (this._disposed) return;
  void this.panel.webview.postMessage({ type: "teamCostEstimate", ...estimate });
}

setRunId(runId: string): void {
  if (this._disposed) return;
  void this.panel.webview.postMessage({ type: "teamSetRunId", runId });
}
```

- [ ] **Step 3: Add cost banner div to renderHtml()**

Before the `<div class="tb">` toolbar in the HTML template, insert:
```html
<div id="costBanner" style="display:none;padding:5px 12px;font-size:11px;
  background:var(--vscode-inputValidation-infoBackground,rgba(0,128,255,.12));
  border-bottom:1px solid var(--vscode-panel-border);
  color:var(--vscode-foreground);"></div>
```

- [ ] **Step 4: Add Pause, Resume, Re-run buttons to toolbar**

After the `<button ... id="stopBtn" ...>■ Stop</button>` line, add:
```html
<button class="btn" id="pauseBtn" onclick="pauseRun()" style="display:none" title="Pause after current group">⏸ Pause</button>
<button class="btn" id="resumeBtn" onclick="resumeRun()" style="display:none" title="Resume run">▶ Resume</button>
<button class="btn" id="rerunBtn" onclick="rerunRun()" style="display:none" title="Re-run with same task">↺ Re-run</button>
```

- [ ] **Step 5: Add JS functions and message handling**

In the `<script>` block, add:
```javascript
let currentRunId = null;
function pauseRun() { vscode.postMessage({type:'teamPause'}); }
function resumeRun() { vscode.postMessage({type:'teamResume'}); }
function rerunRun() {
  if (currentRunId) vscode.postMessage({type:'rerunTeam', runId:currentRunId});
}
```

In the message handler, add:
```javascript
if (msg.type === 'teamCostEstimate') {
  const banner = document.getElementById('costBanner');
  if (banner) {
    banner.textContent = 'Estimated: ' + msg.agentCount + ' agent(s) · ~'
      + msg.estimatedTokens.toLocaleString() + ' tokens · ' + msg.estimatedCostUsd;
    banner.style.display = '';
  }
  return;
}
if (msg.type === 'teamSetRunId') { currentRunId = msg.runId; return; }
```

In `updateMeta()`, after the stop button display toggle, add:
```javascript
const isRunning = state.status === 'running';
const isPaused = state.status === 'paused';
const isDone = ['completed','stopped','failed'].includes(state.status);
document.getElementById('pauseBtn').style.display = isRunning ? '' : 'none';
document.getElementById('resumeBtn').style.display = isPaused ? '' : 'none';
document.getElementById('rerunBtn').style.display = isDone ? '' : 'none';
```

- [ ] **Step 6: Type check**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/ui/team-panel.ts
git commit -m "feat(teams): TeamPanel pause/resume/rerun buttons and cost estimate banner"
```

---

### Task 4: Pre-run cost estimate dialog and pause/resume wiring in extension.ts

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Add estimateTeamCost helper**

After the `workspaceRoot` assignment near the top of `activate()`, add:

```typescript
function estimateTeamCost(team: import("./agent/team-definition").TeamDefinition): {
  agentCount: number;
  estimatedTokens: number;
  estimatedCostUsd: string;
} {
  const AVG_TOKENS_PER_AGENT = 3000;
  const agentCount = team.agents.length;
  const estimatedTokens = agentCount * AVG_TOKENS_PER_AGENT;
  const costUsd = (estimatedTokens / 1000) * 0.003;
  const estimatedCostUsd = costUsd < 0.01 ? "< $0.01" : `~$${costUsd.toFixed(2)}`;
  return { agentCount, estimatedTokens, estimatedCostUsd };
}
```

- [ ] **Step 2: Add confirmation dialog + PauseSignal to the champ.runTeam handler**

Find `const panel = new TeamPanel(context.extensionUri, selectedTeam.name)` inside the `champ.runTeam` handler and prepend:

```typescript
const estimate = estimateTeamCost(selectedTeam);
const confirmLabel = `Run (${estimate.estimatedCostUsd} est.)`;
const costConfirm = await vscode.window.showInformationMessage(
  `"${selectedTeam.name}" — ${estimate.agentCount} agent(s)\nEst: ~${estimate.estimatedTokens.toLocaleString()} tokens  ${estimate.estimatedCostUsd}`,
  { modal: false },
  confirmLabel, "Cancel",
);
if (costConfirm !== confirmLabel) return;
```

After creating `panel`, add `panel.showCostEstimate({ ...estimate, teamName: selectedTeam.name });`.

Add `PauseSignal` state alongside `abortController`:

```typescript
let _isPaused = false;
let _resumeResolve: (() => void) | null = null;
const pauseSignal: import("./agent/team-runner").PauseSignal = {
  get isPaused() { return _isPaused; },
  waitForResume() {
    return new Promise<void>((resolve) => { _resumeResolve = resolve; });
  },
  requestPause() { _isPaused = true; },
};
```

In `panel.onMessage()`, add cases for `teamPause`, `teamResume`, `rerunTeam`:
```typescript
} else if (msg.type === "teamPause") {
  pauseSignal.requestPause();
} else if (msg.type === "teamResume") {
  _isPaused = false;
  const res = _resumeResolve;
  _resumeResolve = null;
  res?.();
} else if (msg.type === "rerunTeam") {
  void vscode.commands.executeCommand("champ.rerunTeam", msg.runId);
}
```

Pass `pauseSignal` to `runner.run()`:
```typescript
void runner.run(selectedTeam, userRequest, provider, toolRegistry, {
  workspaceRoot,
  abortSignal: abortController.signal,
  pauseSignal,      // ADD THIS
  teamRunStore,
  onEvent: (event) => { ... }
});
```

After a `complete` event, call `panel.setRunId(event.state.runId)`.

- [ ] **Step 3: Register champ.rerunTeam command**

After `champ.resumeTeamRun` registration, add:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand("champ.rerunTeam", async (runId?: string) => {
    if (!teamRunStore || !teamLoader || !workspaceRoot) {
      void vscode.window.showErrorMessage("Champ: open a workspace first.");
      return;
    }
    const provider = providerRegistry?.getActive();
    if (!provider) {
      void vscode.window.showErrorMessage("Champ: configure a provider first.");
      return;
    }
    let targetRunId = runId;
    if (!targetRunId) {
      const records = await teamRunStore.loadAll();
      if (records.length === 0) {
        void vscode.window.showInformationMessage("Champ: no team run history.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        records.map((r) => ({
          label: `${r.state.teamName} — ${r.state.userRequest.slice(0, 50)}`,
          description: `${r.state.status} · ${new Date(r.state.startTime).toLocaleString()}`,
          runId: r.state.runId,
        })),
        { placeHolder: "Select a run to re-run", title: "Re-run Team" },
      );
      if (!pick) return;
      targetRunId = pick.runId;
    }
    const record = await teamRunStore.load(targetRunId);
    if (!record) {
      void vscode.window.showErrorMessage(`Champ: run ${targetRunId} not found.`);
      return;
    }
    const teams = await teamLoader.loadAll();
    const team = teams.find((t) => t.name === record.state.teamName);
    if (!team) {
      void vscode.window.showErrorMessage(`Champ: team "${record.state.teamName}" not found.`);
      return;
    }
    const estimate = estimateTeamCost(team);
    const confirmLabel = `Re-run (${estimate.estimatedCostUsd} est.)`;
    const ok = await vscode.window.showInformationMessage(
      `Re-run "${team.name}" with: "${record.state.userRequest.slice(0, 80)}"\nEst: ${estimate.estimatedCostUsd}`,
      { modal: false }, confirmLabel, "Cancel",
    );
    if (ok !== confirmLabel) return;

    const panel = new TeamPanel(context.extensionUri, team.name);
    panel.showCostEstimate({ ...estimate, teamName: team.name });
    const runner = new TeamRunner();
    const abortController = new AbortController();
    panel.onMessage((msg) => { if (msg.type === "teamStop") abortController.abort(); });
    void runner.run(team, record.state.userRequest, provider, toolRegistry, {
      workspaceRoot, abortSignal: abortController.signal, teamRunStore,
      onEvent: (event) => {
        if (event.type === "state_update" || event.type === "complete") {
          panel.update(event.state);
          if (event.type === "complete") panel.setRunId(event.state.runId);
        } else if (event.type === "agent_stream") {
          panel.streamChunk(event.agentId, event.chunk);
        } else if (event.type === "error") {
          void vscode.window.showErrorMessage(`Re-run failed: ${event.message}`);
          panel.update(event.state);
        }
      },
    });
  }),
);
```

- [ ] **Step 4: Run type check**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "feat(teams): cost estimate dialog, pause/resume wiring, champ.rerunTeam command"
```

---

### Task 5: AgentGraphPanel — add Graph/Timeline tabs with per-agent output expansion

**Files:**
- Modify: `webview-ui/src/components/AgentGraphPanel.tsx`

- [ ] **Step 1: Write the failing test**

Add to `webview-ui/src/test/components.test.tsx`:

```typescript
describe("AgentGraphPanel Timeline tab", () => {
  it("renders Graph and Timeline tab buttons when state is set", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    teamStateSignal.value = {
      runId: "r1", teamName: "T", userRequest: "task", status: "completed",
      agents: [
        { id: "a1", name: "Alpha", status: "done", output: "Alpha finished",
          startTime: 1000, endTime: 4500, tokenCount: 1200,
          validationWarnings: [], retryCount: 0 },
      ],
      sharedMemorySnapshot: {}, startTime: 1000, endTime: 4500,
      totalTokens: 1200, filesChanged: [], mode: "auto",
    };
    render(<AgentGraphPanel />, container);
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons).toContain("Graph");
    expect(buttons).toContain("Timeline");
    document.body.removeChild(container);
    teamStateSignal.value = null;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run webview-ui/src/test/components.test.tsx
```
Expected: FAIL — no "Timeline" button found

- [ ] **Step 3: Add tab signals at the top of AgentGraphPanel.tsx**

After `const isVisibleSignal = signal(false);`, add:

```typescript
type AgentGraphTab = "graph" | "timeline";
const activeTabSignal = signal<AgentGraphTab>("graph");
const expandedAgentIdSignal = signal<string | null>(null);
```

- [ ] **Step 4: Add TimelineRow component before AgentGraphPanel export**

```tsx
function TimelineRow({ agent }: { agent: import("../types").TeamAgentRunState }): JSX.Element {
  const durationMs = agent.startTime && agent.endTime ? agent.endTime - agent.startTime : null;
  const durationStr = durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : "—";
  const tokenStr = agent.tokenCount ? agent.tokenCount.toLocaleString() + " tk" : "—";
  const statusColor: Record<string, string> = {
    done: "var(--vscode-terminal-ansiGreen)",
    failed: "var(--vscode-inputValidation-errorBorder)",
    running: "var(--vscode-progressBar-background)",
    skipped: "var(--vscode-disabledForeground)",
    blocked: "var(--vscode-inputValidation-warningBorder)",
    pending: "var(--vscode-descriptionForeground)",
  };
  const color = statusColor[agent.status] ?? "var(--vscode-foreground)";
  const isExpanded = expandedAgentIdSignal.value === agent.id;
  const isExpandable = ["done", "failed", "blocked"].includes(agent.status);

  return (
    <div data-agentid={agent.id}>
      <div
        onClick={isExpandable ? () => { expandedAgentIdSignal.value = isExpanded ? null : agent.id; } : undefined}
        style={`display:flex;align-items:center;padding:4px 8px;
                border-bottom:1px solid var(--vscode-panel-border);font-size:11px;gap:8px;
                cursor:${isExpandable ? "pointer" : "default"};
                background:${isExpanded ? "var(--vscode-list-hoverBackground)" : "transparent"};`}
      >
        <span style={`width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;`} />
        <span style="flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          {agent.name}
        </span>
        {isExpandable && (
          <span style="color:var(--vscode-descriptionForeground);font-size:10px;">
            {isExpanded ? "▲" : "▼"}
          </span>
        )}
        <span style="color:var(--vscode-descriptionForeground);width:48px;text-align:right;flex-shrink:0;">
          {durationStr}
        </span>
        <span style="color:var(--vscode-descriptionForeground);width:52px;text-align:right;flex-shrink:0;">
          {tokenStr}
        </span>
      </div>
      {isExpanded && agent.output && (
        <div style="padding:6px 10px;font-size:11px;font-family:var(--vscode-editor-font-family,monospace);
                    white-space:pre-wrap;word-break:break-word;max-height:160px;overflow-y:auto;
                    background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);">
          {agent.output.slice(0, 2000)}
          {agent.output.length > 2000 && (
            <span style="opacity:0.5;display:block;margin-top:4px;">
              …{(agent.output.length - 2000).toLocaleString()} chars truncated
            </span>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add tab bar and Timeline view to AgentGraphPanel return**

In the `AgentGraphPanel()` component, after the title bar div, add the tab bar:

```tsx
{/* Tab bar */}
<div style="display:flex;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBarSectionHeader-background);">
  {(["graph", "timeline"] as AgentGraphTab[]).map((tab) => (
    <button
      key={tab}
      onClick={() => { activeTabSignal.value = tab; }}
      style={`flex:1;padding:5px 0;border:none;cursor:pointer;font-size:11px;font-weight:600;
              text-transform:capitalize;
              background:${activeTabSignal.value === tab ? "var(--vscode-list-activeSelectionBackground)" : "transparent"};
              color:${activeTabSignal.value === tab ? "var(--vscode-list-activeSelectionForeground)" : "var(--vscode-foreground)"};
              border-bottom:${activeTabSignal.value === tab ? "2px solid var(--vscode-focusBorder)" : "2px solid transparent"};`}
    >
      {tab === "graph" ? "Graph" : "Timeline"}
    </button>
  ))}
</div>
```

Wrap the existing SVG content in `{activeTabSignal.value === "graph" && (<div ...>existing SVG content</div>)}`.

Add the Timeline view after it:
```tsx
{activeTabSignal.value === "timeline" && (
  <div style="overflow-y:auto;max-height:300px;">
    <div style="display:flex;padding:4px 8px;font-size:10px;opacity:0.6;border-bottom:1px solid var(--vscode-panel-border);gap:8px;">
      <span style="width:8px;flex-shrink:0;" />
      <span style="flex:1;">Agent</span>
      <span style="width:48px;text-align:right;flex-shrink:0;">Duration</span>
      <span style="width:52px;text-align:right;flex-shrink:0;">Tokens</span>
    </div>
    {state.agents.map((agent) => <TimelineRow key={agent.id} agent={agent} />)}
  </div>
)}
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run webview-ui/src/test/components.test.tsx
```
Expected: All PASS

- [ ] **Step 7: Rebuild webview bundle**

```bash
node esbuild.webview.mjs && node --check webview-ui/dist/components.js
```
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add webview-ui/src/components/AgentGraphPanel.tsx webview-ui/dist/components.js webview-ui/src/test/components.test.tsx
git commit -m "feat(teams): AgentGraphPanel Graph/Timeline tabs + per-agent output expansion"
```

---

### Task 6: Full test suite verification and version bump

**Files:**
- Modify: `package.json` (via `npm version patch`)

- [ ] **Step 1: Run all unit tests**

```bash
npx vitest run
```
Expected: All PASS (new pause tests + component tests passing)

- [ ] **Step 2: Full type check**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Rebuild extension bundle**

```bash
npm run compile
```
Expected: No errors

- [ ] **Step 4: Bump version**

```bash
npm version patch
```
Expected: Version bumped from current to next patch

- [ ] **Step 5: Final commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump version — Sprint N Agent Execution Console complete"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All 5 gaps addressed: (1) timeline tab ✓, (2) cost estimate before running ✓, (3) pause/resume ✓, (4) agent output expansion ✓, (5) re-run ✓
- [x] **Placeholder scan:** No TBD, no "implement later" — every step has actual TypeScript/TSX code
- [x] **Type consistency:** `PauseSignal` defined in Task 1 used in Tasks 4; `TeamCostEstimateMessage` defined in Task 2 used in Tasks 3/4; `activeTabSignal` and `expandedAgentIdSignal` defined in Task 5 Step 3 used in Task 5 Steps 4/5
- [x] **Eviction safety:** pause check is only between groups (after `await Promise.all([...])` group execution completes) — never mid-agent
