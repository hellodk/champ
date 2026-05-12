# Multi-Agent, Analytics & Rich Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `AgentOrchestrator` to the UI for multi-agent workflows, add per-agent analytics visible in the chat and exported via OTLP/HTTP (with offline buffering and replay), fix the image attachment pipeline so Claude/OpenAI/Gemini can see attached images, and add `generate_diagram` + `generate_doc` tools so agents can produce mermaid diagrams and architecture documents.

**Architecture:** All backend infrastructure already exists (AgentOrchestrator, specialized agents, MetricsCollector, image ContentBlock types) but none of it is wired to the UI. This plan adds the wiring layer: `AgentAnalytics` (per-run tracker), `MultiAgentRunner` (orchestration + progress events), image ContentBlock pipeline in ChatViewProvider, two new file-creation tools, OTLP telemetry export with offline `EventBuffer` (drops-oldest, 1 000 events / 5 MB cap) + `AnalyticsExporter` (exponential-backoff retry, configurable endpoint + format), and a Grafana dashboard JSON for per-user analytics.

**Tech Stack:** TypeScript, VS Code Extension API, existing `AgentOrchestrator` + `AgentController` + `ChatViewProvider`, `vitest` for tests.

---

## File Map

| File | Status | Role |
|------|--------|------|
| `src/observability/agent-analytics.ts` | **Create** | Per-run analytics tracker: tool call records, task timing, markdown report |
| `src/agent/multi-agent-runner.ts` | **Create** | Wraps `AgentOrchestrator`; builds Planner→Context→Code→Reviewer→Validator pipeline; streams progress events |
| `src/tools/generate-diagram.ts` | **Create** | `generate_diagram` tool: writes mermaid diagram to `.md` file |
| `src/tools/generate-doc.ts` | **Create** | `generate_doc` tool: writes architecture/technical document to `.md` file |
| `src/observability/agent-analytics.test.ts` | **Create** | Unit tests for AgentAnalytics |
| `test/unit/agent/multi-agent-runner.test.ts` | **Create** | Unit tests for MultiAgentRunner |
| `test/unit/tools/generate-diagram.test.ts` | **Create** | Unit tests for generate_diagram tool |
| `test/unit/tools/generate-doc.test.ts` | **Create** | Unit tests for generate_doc tool |
| `src/agent/orchestrator.ts` | **Modify** | Add `onAgentProgress` callback to `WorkflowOptions` |
| `src/agent/agent-controller.ts` | **Modify** | Add `setHistory()`, `setAnalytics()`, wire analytics in `processMessage` loop |
| `src/agent-manager/types.ts` | **Modify** | Add `AgentRunReport`, `AgentTaskRecord`, `ToolCallRecord` types |
| `src/ui/chat-view-provider.ts` | **Modify** | Fix image attachment pipeline; add multi-agent run handler |
| `src/extension.ts` | **Modify** | Register new tools; add `champ.runMultiAgent` + `champ.showAnalytics` commands |
| `src/config/config-loader.ts` | **Modify** | Add `TelemetryConfig` interface + `telemetry:` block validation in `ConfigLoader.validate()` |
| `src/telemetry/event-buffer.ts` | **Create** | FIFO offline buffer: drops oldest on overflow; 1 000-event / 5 MB cap |
| `src/telemetry/analytics-exporter.ts` | **Create** | HTTP exporter: OTLP/JSON + plain-JSON format; exponential-backoff retry; drains buffer when online |
| `src/telemetry/event-buffer.test.ts` | **Create** | Unit tests for EventBuffer |
| `src/telemetry/analytics-exporter.test.ts` | **Create** | Unit tests for AnalyticsExporter |
| `docs/grafana/champ-analytics-dashboard.json` | **Create** | Grafana dashboard JSON with per-user analytics panels |

---

### Task 1: AgentAnalytics — per-run tracking class

**Files:**
- Create: `src/observability/agent-analytics.ts`
- Modify: `src/agent-manager/types.ts`
- Test: `src/observability/agent-analytics.test.ts`

- [ ] **Step 1: Add analytics types to `src/agent-manager/types.ts`**

Open `src/agent-manager/types.ts` and append at the bottom:

```typescript
// ── Analytics types ────────────────────────────────────────────────

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
  durationMs: number;
  success: boolean;
  result?: string;
  error?: string;
}

export interface AgentTaskRecord {
  agentName: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: ToolCallRecord[];
  success: boolean;
  error?: string;
}

export interface AgentRunReport {
  runId: string;
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  agents: AgentTaskRecord[];
  success: boolean;
}
```

- [ ] **Step 2: Write failing tests for AgentAnalytics**

Create `src/observability/agent-analytics.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { AgentAnalytics } from "./agent-analytics";

describe("AgentAnalytics", () => {
  let analytics: AgentAnalytics;

  beforeEach(() => {
    analytics = new AgentAnalytics();
  });

  it("records a task with tool calls", () => {
    analytics.recordTask({
      agentName: "planner",
      startTime: 1000,
      endTime: 2000,
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      toolCalls: [
        {
          toolName: "read_file",
          args: { path: "src/main.ts" },
          startTime: 1100,
          durationMs: 50,
          success: true,
          result: "file contents",
        },
      ],
      success: true,
    });
    expect(analytics.getRecords()).toHaveLength(1);
    expect(analytics.getRecords()[0].agentName).toBe("planner");
    expect(analytics.getRecords()[0].toolCalls).toHaveLength(1);
  });

  it("produces a summary report", () => {
    analytics.recordTask({
      agentName: "code",
      startTime: 0, endTime: 3000, durationMs: 3000,
      inputTokens: 200, outputTokens: 400,
      toolCalls: [], success: true,
    });
    const report = analytics.toReport();
    expect(report.totalInputTokens).toBe(200);
    expect(report.totalOutputTokens).toBe(400);
    expect(report.agents).toHaveLength(1);
    expect(report.success).toBe(true);
  });

  it("marks report as failed when any task failed", () => {
    analytics.recordTask({
      agentName: "reviewer",
      startTime: 0, endTime: 1000, durationMs: 1000,
      inputTokens: 50, outputTokens: 30,
      toolCalls: [], success: false, error: "rejected",
    });
    expect(analytics.toReport().success).toBe(false);
  });

  it("formats a markdown table", () => {
    analytics.recordTask({
      agentName: "planner",
      startTime: 0, endTime: 2500, durationMs: 2500,
      inputTokens: 100, outputTokens: 50,
      toolCalls: [{ toolName: "grep_search", args: {}, startTime: 0, durationMs: 100, success: true }],
      success: true,
    });
    const md = analytics.formatMarkdown();
    expect(md).toContain("planner");
    expect(md).toContain("2.5s");
    expect(md).toContain("| 1 |");
  });

  it("resets all records", () => {
    analytics.recordTask({
      agentName: "code", startTime: 0, endTime: 1000, durationMs: 1000,
      inputTokens: 0, outputTokens: 0, toolCalls: [], success: true,
    });
    analytics.reset();
    expect(analytics.getRecords()).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test -- --reporter=verbose src/observability/agent-analytics.test.ts 2>&1 | tail -15
```

Expected: FAIL — `Cannot find module './agent-analytics'`

- [ ] **Step 4: Create `src/observability/agent-analytics.ts`**

```typescript
import type { AgentTaskRecord, AgentRunReport } from "../agent-manager/types";

export { AgentTaskRecord, AgentRunReport };
export type { AgentTaskRecord as AgentTaskRecordInput };

let runCounter = 0;

export class AgentAnalytics {
  private records: AgentTaskRecord[] = [];
  private runStartTime: number = Date.now();

  recordTask(record: AgentTaskRecord): void {
    this.records.push(record);
  }

  getRecords(): AgentTaskRecord[] {
    return [...this.records];
  }

  toReport(): AgentRunReport {
    const endTime = Date.now();
    runCounter++;
    return {
      runId: `run-${this.runStartTime.toString(36)}-${runCounter}`,
      startTime: this.runStartTime,
      endTime,
      totalDurationMs: endTime - this.runStartTime,
      totalInputTokens: this.records.reduce((s, r) => s + r.inputTokens, 0),
      totalOutputTokens: this.records.reduce((s, r) => s + r.outputTokens, 0),
      agents: [...this.records],
      success: this.records.length > 0 && this.records.every((r) => r.success),
    };
  }

  formatMarkdown(): string {
    const lines = [
      "## Agent Analytics",
      "",
      "| Agent | Duration | Tokens In | Tokens Out | Tools | Status |",
      "|-------|----------|-----------|------------|-------|--------|",
    ];
    for (const r of this.records) {
      const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
      const status = r.success ? "✅" : "❌";
      lines.push(
        `| ${r.agentName} | ${dur} | ${r.inputTokens} | ${r.outputTokens} | ${r.toolCalls.length} | ${status} |`,
      );
    }
    const report = this.toReport();
    lines.push(
      "",
      `**Total:** ${(report.totalDurationMs / 1000).toFixed(1)}s · ${report.totalInputTokens} in · ${report.totalOutputTokens} out`,
    );
    return lines.join("\n");
  }

  reset(): void {
    this.records = [];
    this.runStartTime = Date.now();
  }
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npm test -- src/observability/agent-analytics.test.ts 2>&1 | tail -10
```

Expected: 5 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/observability/agent-analytics.ts src/observability/agent-analytics.test.ts src/agent-manager/types.ts
git commit -m "feat: AgentAnalytics — per-run task/tool recording with markdown report"
```

---

### Task 2: AgentController — `setHistory` + analytics wiring

**Files:**
- Modify: `src/agent/agent-controller.ts`
- Test: existing `test/unit/agent/agent-controller.test.ts`

The goal is twofold:
1. Add `setHistory(messages: LLMMessage[]): void` to fix the ugly history-injection hack in `AgentManager.importSession()`.
2. Add `setAnalytics(analytics: AgentAnalytics, agentName?: string): void` and wire it into `processMessage` so tool calls and token usage are recorded automatically.

- [ ] **Step 1: Write failing tests for the two new methods**

Open `test/unit/agent/agent-controller.test.ts`. Add these two tests inside the existing describe block (find a good spot after existing tests — do not modify existing tests):

```typescript
import { AgentAnalytics } from "../../../src/observability/agent-analytics";

// ...inside the existing describe("AgentController") block:

it("setHistory replaces the conversation history", () => {
  const ctrl = new AgentController(mockProvider(), new ToolRegistry(), "/ws");
  ctrl.setHistory([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
  expect(ctrl.getHistory()).toHaveLength(2);
  expect(ctrl.getHistory()[0].content).toBe("hello");
});

it("setAnalytics wires token recording after processMessage", async () => {
  const provider = mockProvider(); // uses the existing mock that returns done delta
  const analytics = new AgentAnalytics();
  const ctrl = new AgentController(provider, new ToolRegistry(), "/ws");
  ctrl.setAnalytics(analytics, "test-agent");
  await ctrl.processMessage("hi", {});
  const records = analytics.getRecords();
  expect(records).toHaveLength(1);
  expect(records[0].agentName).toBe("test-agent");
  expect(records[0].success).toBe(true);
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npm test -- test/unit/agent/agent-controller.test.ts 2>&1 | tail -15
```

Expected: FAIL — `ctrl.setHistory is not a function` + `ctrl.setAnalytics is not a function`

- [ ] **Step 3: Add `setHistory` to `AgentController`**

In `src/agent/agent-controller.ts`, find the `reset()` method and add `setHistory` directly after it:

```typescript
/** Replace conversation history (used when restoring persisted sessions). */
setHistory(messages: LLMMessage[]): void {
  this.history = [...messages];
}
```

- [ ] **Step 4: Add `setAnalytics` and analytics fields to `AgentController`**

At the top of the `AgentController` class body (after the existing private fields), add:

```typescript
private analyticsInstance: import("../observability/agent-analytics").AgentAnalytics | null = null;
private analyticsAgentName = "champ";

setAnalytics(
  analytics: import("../observability/agent-analytics").AgentAnalytics,
  agentName = "champ",
): void {
  this.analyticsInstance = analytics;
  this.analyticsAgentName = agentName;
}
```

- [ ] **Step 5: Wire analytics recording inside `processMessage`**

Inside `processMessage`, make these three targeted edits:

**5a.** Right before the `for (let iteration = 0; ...)` loop (after `const repoMap = await this.getRepoMap();`), add:

```typescript
// Analytics — track start time and per-tool timings.
const taskStartTime = Date.now();
const toolStartTimes = new Map<string, number>();
const toolCallRecords: import("../agent-manager/types").ToolCallRecord[] = [];
let totalInputTokens = 0;
let totalOutputTokens = 0;
let hadError = false;
```

**5b.** Inside the `for await (const delta of stream)` loop, add tracking for tool call start/end and done:

After the existing `} else if (delta.type === "tool_call_start" && delta.toolCall) {` block, in the same switch/if chain, find `} else if (delta.type === "done") {` and replace it with:

```typescript
} else if (delta.type === "done") {
  totalInputTokens += delta.usage.inputTokens;
  totalOutputTokens += delta.usage.outputTokens;
  this.emit(delta);
  break;
```

Also add after the `} else if (delta.type === "tool_call_start" && delta.toolCall) {` line (after `pendingToolCalls.push(delta.toolCall); this.emit(delta);`):

```typescript
  toolStartTimes.set(delta.toolCall.id, Date.now());
```

**5c.** Inside the tool execution loop `for (const call of pendingToolCalls)`, immediately after:
```typescript
this.emit({
  type: "tool_call_end",
  toolCallId: call.id,
  toolName: call.name,
  toolResult: redactedOutput,
  toolSuccess: result.success,
});
```
add:
```typescript
        // Record tool call for analytics.
        const toolStart = toolStartTimes.get(call.id) ?? Date.now();
        toolStartTimes.delete(call.id);
        toolCallRecords.push({
          toolName: call.name,
          args: call.arguments,
          startTime: toolStart,
          durationMs: Date.now() - toolStart,
          success: result.success,
          result: result.success ? result.output.slice(0, 200) : undefined,
          error: result.success ? undefined : result.output,
        });
```

**5d.** Immediately before the `return { text: ..., toolCalls: ... };` at the very end of `processMessage`, add:

```typescript
    // Record this processMessage call as one agent task.
    if (this.analyticsInstance) {
      this.analyticsInstance.recordTask({
        agentName: this.analyticsAgentName,
        startTime: taskStartTime,
        endTime: Date.now(),
        durationMs: Date.now() - taskStartTime,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolCalls: toolCallRecords,
        success: !hadError,
      });
    }
```

Also find the `if (errorOccurred) { return { ... }; }` early-return and set `hadError = true;` before it:

```typescript
      if (errorOccurred) {
        hadError = true;
        return {
          text: collectedText.join(""),
          toolCalls: collectedToolCalls,
        };
      }
```

- [ ] **Step 6: Run tests**

```bash
npm test -- test/unit/agent/agent-controller.test.ts 2>&1 | tail -15
```

Expected: all existing tests pass + 2 new tests pass.

- [ ] **Step 7: Fix `AgentManager.importSession` to use `setHistory`**

In `src/agent-manager/agent-manager.ts`, find the `importSession` method. It currently has a hack like:
```typescript
(controller as unknown as { history: unknown[] }).history = serialized.history ?? [];
```

Replace it with:
```typescript
controller.setHistory(serialized.history ?? []);
```

- [ ] **Step 8: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/agent/agent-controller.ts src/agent-manager/agent-manager.ts test/unit/agent/agent-controller.test.ts
git commit -m "feat: AgentController — setHistory(), setAnalytics(), analytics wiring in processMessage"
```

---

### Task 3: AgentOrchestrator — progress callbacks

**Files:**
- Modify: `src/agent/orchestrator.ts`
- Test: existing `test/unit/agent/orchestrator.test.ts`

- [ ] **Step 1: Add `AgentProgressEvent` type and `onAgentProgress` to `WorkflowOptions`**

In `src/agent/orchestrator.ts`, after the `WorkflowOptions` interface, add:

```typescript
export type AgentProgressEvent =
  | { type: "agent_started"; agentName: string; step: number; totalSteps: number }
  | { type: "agent_completed"; agentName: string; durationMs: number; success: boolean; output: string }
  | { type: "agent_failed"; agentName: string; error: string; attempt: number };
```

Then add `onAgentProgress` to `WorkflowOptions`:

```typescript
export interface WorkflowOptions {
  maxRetries?: number;
  retryFrom?: Record<string, string>;
  context?: ContextChunk[];
  abortSignal?: AbortSignal;
  /** Called before and after each agent executes. */
  onAgentProgress?: (event: AgentProgressEvent) => void;
}
```

- [ ] **Step 2: Write failing test**

In `test/unit/agent/orchestrator.test.ts`, add inside the existing describe block:

```typescript
it("calls onAgentProgress before and after each agent", async () => {
  const orch = new AgentOrchestrator();
  orch.registerAgent({
    name: "a",
    role: "test",
    execute: async () => ({ success: true, output: "done" }),
  });
  const events: string[] = [];
  await orch.executeWorkflow("test", ["a"], {
    onAgentProgress: (e) => events.push(e.type),
  });
  expect(events).toEqual(["agent_started", "agent_completed"]);
});

it("calls agent_failed on agent failure", async () => {
  const orch = new AgentOrchestrator();
  orch.registerAgent({
    name: "b",
    role: "test",
    execute: async () => ({ success: false, output: "no", error: "bad" }),
  });
  const events: string[] = [];
  await orch.executeWorkflow("test", ["b"], {
    maxRetries: 1,
    onAgentProgress: (e) => events.push(e.type),
  });
  // 1 start + 1 fail = 2 events (maxRetries=1 so only one attempt)
  expect(events).toContain("agent_started");
  expect(events).toContain("agent_failed");
});
```

- [ ] **Step 3: Run to confirm tests fail**

```bash
npm test -- test/unit/agent/orchestrator.test.ts 2>&1 | tail -10
```

Expected: FAIL — `events` array is empty.

- [ ] **Step 4: Wire the progress callbacks in `executeWorkflow`**

In `src/agent/orchestrator.ts`, inside the `while (i < sequence.length)` loop, make two edits:

**Before** `const startTime = Date.now();`, add:

```typescript
      options.onAgentProgress?.({
        type: "agent_started",
        agentName: name,
        step: i + 1,
        totalSteps: sequence.length,
      });
```

**After** the `executionLog.push({ ... });` call, add:

```typescript
      if (output.success) {
        options.onAgentProgress?.({
          type: "agent_completed",
          agentName: name,
          durationMs: endTime - startTime,
          success: true,
          output: output.output,
        });
      } else {
        options.onAgentProgress?.({
          type: "agent_failed",
          agentName: name,
          error: output.error ?? output.output,
          attempt: attemptNumber,
        });
      }
```

- [ ] **Step 5: Run tests**

```bash
npm test -- test/unit/agent/orchestrator.test.ts 2>&1 | tail -10
```

Expected: all tests pass (including the 2 new ones).

- [ ] **Step 6: Commit**

```bash
git add src/agent/orchestrator.ts test/unit/agent/orchestrator.test.ts
git commit -m "feat: AgentOrchestrator — onAgentProgress callbacks (agent_started/completed/failed)"
```

---

### Task 4: MultiAgentRunner — orchestrate the full pipeline

**Files:**
- Create: `src/agent/multi-agent-runner.ts`
- Test: `test/unit/agent/multi-agent-runner.test.ts`

`MultiAgentRunner` builds and runs the standard Planner→Context→Code→Reviewer→Validator pipeline, streaming `AgentProgressEvent`s to the caller. It wires `AgentAnalytics` so each agent's timing is recorded.

- [ ] **Step 1: Write failing tests**

Create `test/unit/agent/multi-agent-runner.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { MultiAgentRunner } from "../../../src/agent/multi-agent-runner";
import { AgentOrchestrator } from "../../../src/agent/orchestrator";

function makeOrchestrator(agentNames: string[], succeed = true): AgentOrchestrator {
  const orch = new AgentOrchestrator();
  for (const name of agentNames) {
    orch.registerAgent({
      name,
      role: name,
      execute: vi.fn().mockResolvedValue({ success: succeed, output: `${name}-done` }),
    });
  }
  return orch;
}

describe("MultiAgentRunner", () => {
  it("runs the standard sequence and emits progress events", async () => {
    const orch = makeOrchestrator(["planner", "context", "code", "reviewer", "validator"]);
    const runner = new MultiAgentRunner(orch);
    const events: string[] = [];
    const result = await runner.run("build auth feature", {
      onProgress: (e) => events.push(e.type),
    });
    expect(result.success).toBe(true);
    expect(events).toContain("agent_started");
    expect(events).toContain("agent_completed");
    expect(events).toContain("workflow_complete");
  });

  it("exposes the analytics report when analytics provided", async () => {
    const { AgentAnalytics } = await import("../../../src/observability/agent-analytics");
    const orch = makeOrchestrator(["planner"]);
    const runner = new MultiAgentRunner(orch);
    const analytics = new AgentAnalytics();
    // Manually record a task to simulate what AgentController would record
    analytics.recordTask({
      agentName: "planner", startTime: 0, endTime: 1000, durationMs: 1000,
      inputTokens: 50, outputTokens: 30, toolCalls: [], success: true,
    });
    let completedReport: import("../../../src/agent-manager/types").AgentRunReport | undefined;
    await runner.run("test", {
      analytics,
      onProgress: (e) => {
        if (e.type === "workflow_complete") completedReport = e.report;
      },
    });
    expect(completedReport).toBeDefined();
    expect(completedReport!.agents.length).toBeGreaterThan(0);
  });

  it("emits workflow_complete with success=false when an agent fails and retries exhausted", async () => {
    const orch = makeOrchestrator(["planner"], false);
    const runner = new MultiAgentRunner(orch);
    const events: Array<{ type: string; success?: boolean }> = [];
    const result = await runner.run("test", {
      onProgress: (e) => {
        if (e.type === "workflow_complete") events.push({ type: e.type, success: e.report.success });
      },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- test/unit/agent/multi-agent-runner.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module './multi-agent-runner'`

- [ ] **Step 3: Create `src/agent/multi-agent-runner.ts`**

```typescript
/**
 * MultiAgentRunner: builds and runs the standard Champ multi-agent pipeline.
 *
 * Pipeline: planner → context → code → reviewer → validator
 *
 * Callers pass an `onProgress` callback to receive real-time events about
 * which agent is running and when it completes. The runner also wires
 * `AgentAnalytics` so per-agent timing is recorded automatically.
 *
 * The `AgentOrchestrator` must have the required agents registered before
 * calling `run()`. In production, `extension.ts` calls
 * `MultiAgentRunner.buildDefaultPipeline(provider, toolRegistry, workspaceRoot)`
 * which constructs the standard agents. In tests, pass a pre-configured
 * orchestrator directly.
 */
import { AgentOrchestrator } from "./orchestrator";
import type { WorkflowResult, AgentProgressEvent } from "./orchestrator";
import type { AgentAnalytics } from "../observability/agent-analytics";
import type { AgentRunReport } from "../agent-manager/types";

export type MultiAgentProgressEvent =
  | AgentProgressEvent
  | { type: "workflow_complete"; report: AgentRunReport };

export interface MultiAgentRunOptions {
  onProgress?: (event: MultiAgentProgressEvent) => void;
  abortSignal?: AbortSignal;
  analytics?: AgentAnalytics;
  /** Override default pipeline. Default: ["planner","context","code","reviewer","validator"] */
  sequence?: string[];
  maxRetries?: number;
}

export class MultiAgentRunner {
  constructor(private readonly orchestrator: AgentOrchestrator) {}

  async run(
    userRequest: string,
    options: MultiAgentRunOptions = {},
  ): Promise<WorkflowResult> {
    const sequence = options.sequence ?? [
      "planner",
      "context",
      "code",
      "reviewer",
      "validator",
    ];
    const analytics = options.analytics;

    const result = await this.orchestrator.executeWorkflow(
      userRequest,
      sequence,
      {
        abortSignal: options.abortSignal,
        maxRetries: options.maxRetries ?? 3,
        retryFrom: { reviewer: "code" },
        onAgentProgress: (event) => {
          options.onProgress?.(event);
        },
      },
    );

    // Emit the final analytics report.
    const report = analytics?.toReport() ?? {
      runId: `run-${Date.now()}`,
      startTime: Date.now(),
      endTime: Date.now(),
      totalDurationMs: result.executionLog.reduce((s, e) => s + e.durationMs, 0),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      agents: result.executionLog.map((e) => ({
        agentName: e.agentName,
        startTime: e.startTime,
        endTime: e.endTime,
        durationMs: e.durationMs,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        success: e.success,
      })),
      success: result.success,
    };

    options.onProgress?.({ type: "workflow_complete", report });
    return result;
  }

  /**
   * Build the default pipeline using real agents backed by an LLM provider.
   * Called from extension.ts during activation.
   */
  static buildDefaultPipeline(
    provider: import("../providers/types").LLMProvider,
    toolRegistry: import("../tools/registry").ToolRegistry,
    workspaceRoot: string,
  ): MultiAgentRunner {
    const { PlannerAgent } = require("./agents/planner-agent") as {
      PlannerAgent: new (p: import("../providers/types").LLMProvider) => import("./agents/types").Agent;
    };
    const { ContextAgent } = require("./agents/context-agent") as {
      ContextAgent: new () => import("./agents/types").Agent;
    };
    const { CodeAgent } = require("./agents/code-agent") as {
      CodeAgent: new (p: import("../providers/types").LLMProvider) => import("./agents/types").Agent;
    };
    const { ReviewerAgent } = require("./agents/reviewer-agent") as {
      ReviewerAgent: new (p: import("../providers/types").LLMProvider) => import("./agents/types").Agent;
    };
    const { ValidatorAgent } = require("./agents/validator-agent") as {
      ValidatorAgent: new (r: import("../tools/registry").ToolRegistry, root: string) => import("./agents/types").Agent;
    };

    const orch = new AgentOrchestrator();
    orch.registerAgent(new PlannerAgent(provider));
    orch.registerAgent(new ContextAgent());
    orch.registerAgent(new CodeAgent(provider));
    orch.registerAgent(new ReviewerAgent(provider));
    orch.registerAgent(new ValidatorAgent(toolRegistry, workspaceRoot));
    return new MultiAgentRunner(orch);
  }
}
```

- [ ] **Step 4: Check ValidatorAgent constructor signature**

Read `src/agent/agents/validator-agent.ts` (first 20 lines) to verify its constructor. If it differs from `new ValidatorAgent(toolRegistry, workspaceRoot)`, adjust the `buildDefaultPipeline` code in the file above accordingly before running tests.

- [ ] **Step 5: Run tests**

```bash
npm test -- test/unit/agent/multi-agent-runner.test.ts 2>&1 | tail -10
```

Expected: 3 tests passing.

- [ ] **Step 6: Run full suite to verify no regressions**

```bash
npm test 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add src/agent/multi-agent-runner.ts test/unit/agent/multi-agent-runner.test.ts
git commit -m "feat: MultiAgentRunner — orchestrates planner→context→code→reviewer→validator with progress events"
```

---

### Task 5: Image attachment pipeline

**Files:**
- Modify: `src/ui/chat-view-provider.ts` (lines ~136, ~364–405, ~476, ~613–622)
- Modify: `src/agent/agent-controller.ts` (line ~289 — `processMessage` signature)
- Test: `test/unit/ui/chat-view-provider.test.ts`

Currently all file attachments are decoded as UTF-8 text. When the attachment is an image (jpeg, png, gif, webp), the provider that supports images (Claude, OpenAI, Gemini) should receive a proper `ContentBlock { type: "image" }` instead.

- [ ] **Step 1: Write failing tests**

In `test/unit/ui/chat-view-provider.test.ts`, add inside the existing describe block:

```typescript
it("enriches user message with image ContentBlock for image attachments", async () => {
  // Set up a provider + view the same way as other tests in this file
  // use the existing pattern for createMockWebviewView + resolveWebviewView

  const view = createMockWebviewView(postMessage);
  provider.resolveWebviewView(view as never, {} as never, {} as never);

  // Simulate an image attachment
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; // 1x1 pixel PNG
  view.fireMessage({ type: "attachFileRequest", filename: "screenshot.png", mimeType: "image/png", contentBase64: pngBase64 });

  // Now fire a user message — it should call processMessage with ContentBlock[]
  let capturedContent: unknown;
  const mockAgent = {
    onStreamDelta: vi.fn().mockReturnValue(() => {}),
    processMessage: vi.fn().mockImplementation((content: unknown) => {
      capturedContent = content;
      return Promise.resolve({ text: "", toolCalls: [] });
    }),
    getMode: vi.fn().mockReturnValue("agent"),
  };
  provider.setAgent(mockAgent as never);
  view.fireMessage({ type: "userMessage", text: "what do you see?" });
  await new Promise((resolve) => setImmediate(resolve));

  expect(Array.isArray(capturedContent)).toBe(true);
  const blocks = capturedContent as Array<{ type: string; mimeType?: string }>;
  expect(blocks.some((b) => b.type === "image" && b.mimeType === "image/png")).toBe(true);
});
```

- [ ] **Step 2: Run to confirm test fails**

```bash
npm test -- test/unit/ui/chat-view-provider.test.ts 2>&1 | grep -E "FAIL|image" | head -10
```

Expected: test fails — `capturedContent` is a string, not an array.

- [ ] **Step 3: Change `pendingAttachments` type in `ChatViewProvider`**

In `src/ui/chat-view-provider.ts`, find the `pendingAttachments` field declaration (~line 136). Change it from:

```typescript
private pendingAttachments: Array<{
  filename: string;
  content: string;
}> = [];
```

to:

```typescript
private pendingAttachments: Array<{
  filename: string;
  content: string;        // UTF-8 decoded text (for non-image files)
  mimeType: string;       // MIME type — "image/png" etc. or "text/plain"
  isImage: boolean;
  imageData?: string;     // base64 for images
}> = [];
```

- [ ] **Step 4: Update `attachFileRequest` handler to store mime type**

In `src/ui/chat-view-provider.ts`, find the `isAttachFileRequest(msg)` handler block (~line 364). Replace the inner `try { const content = Buffer.from... }` block with:

```typescript
        const isImage = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i.test(
          msg.mimeType ?? "",
        );
        if (isImage) {
          this.pendingAttachments.push({
            filename: msg.filename,
            content: "",
            mimeType: msg.mimeType,
            isImage: true,
            imageData: msg.contentBase64,
          });
        } else {
          try {
            const content = Buffer.from(msg.contentBase64, "base64").toString("utf-8");
            this.pendingAttachments.push({
              filename: msg.filename,
              content,
              mimeType: msg.mimeType ?? "text/plain",
              isImage: false,
            });
          } catch {
            this.postMessage(createError(`Failed to decode attached file: ${msg.filename}`));
          }
        }
```

- [ ] **Step 5: Update `openFilePickerRequest` handler to detect images**

In the `openFilePickerRequest` handler (~line 381), inside the file loop, replace:

```typescript
              const content = new TextDecoder().decode(data);
              const filename = uri.path.split("/").pop() ?? "file";
              this.pendingAttachments.push({ filename, content });
```

with:

```typescript
              const filename = uri.path.split("/").pop() ?? "file";
              const ext = filename.split(".").pop()?.toLowerCase() ?? "";
              const imageMimeMap: Record<string, string> = {
                png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                gif: "image/gif", webp: "image/webp",
              };
              const mimeType = imageMimeMap[ext] ?? "text/plain";
              const isImage = ext in imageMimeMap;
              if (isImage) {
                const imageData = Buffer.from(data).toString("base64");
                this.pendingAttachments.push({ filename, content: "", mimeType, isImage: true, imageData });
              } else {
                const content = new TextDecoder().decode(data);
                this.pendingAttachments.push({ filename, content, mimeType, isImage: false });
              }
```

- [ ] **Step 6: Change `enrichWithAttachments` to return `string | ContentBlock[]`**

In `src/ui/chat-view-provider.ts`, replace the entire `enrichWithAttachments` method (~line 613):

```typescript
  private enrichWithAttachments(
    text: string,
  ): string | import("../providers/types").ContentBlock[] {
    if (this.pendingAttachments.length === 0) return text;

    const hasImages = this.pendingAttachments.some((a) => a.isImage);
    if (!hasImages) {
      // Text-only path: keep original behaviour.
      const sections = this.pendingAttachments
        .map((a) => `--- ${a.filename} ---\n${a.content}`)
        .join("\n\n");
      this.pendingAttachments = [];
      return `${text}\n\n# Attached files\n\n${sections}`;
    }

    // Mixed or image-only: build a ContentBlock array.
    const blocks: import("../providers/types").ContentBlock[] = [
      { type: "text", text },
    ];
    for (const att of this.pendingAttachments) {
      if (att.isImage && att.imageData) {
        blocks.push({
          type: "image",
          imageData: att.imageData,
          mimeType: att.mimeType,
        });
      } else {
        blocks.push({
          type: "text",
          text: `\n\n--- ${att.filename} ---\n${att.content}`,
        });
      }
    }
    this.pendingAttachments = [];
    return blocks;
  }
```

- [ ] **Step 7: Update `AgentController.processMessage` signature to accept `ContentBlock[]`**

In `src/agent/agent-controller.ts`, change the `processMessage` signature from:

```typescript
async processMessage(
  userText: string,
  options: ProcessMessageOptions = {},
): Promise<ProcessMessageResult> {
```

to:

```typescript
async processMessage(
  userText: string | import("../providers/types").ContentBlock[],
  options: ProcessMessageOptions = {},
): Promise<ProcessMessageResult> {
```

The line `this.history.push({ role: "user", content: userText });` requires no change because `LLMMessage.content` is already typed as `string | ContentBlock[]`.

- [ ] **Step 8: Update `handleUserMessage` in `ChatViewProvider`**

In `src/ui/chat-view-provider.ts`, find the line:

```typescript
    const enrichedText = this.enrichWithAttachments(contextResolved);
```

Rename the variable to make the type clear:

```typescript
    const enrichedContent = this.enrichWithAttachments(contextResolved);
```

Then find the `await this.agent.processMessage(enrichedText, {` call and change it to:

```typescript
      const result = await this.agent.processMessage(enrichedContent, {
```

- [ ] **Step 9: Run type-check and tests**

```bash
npm run check-types 2>&1 && npm test -- test/unit/ui/chat-view-provider.test.ts 2>&1 | tail -10
```

Expected: no type errors; image attachment test passes.

- [ ] **Step 10: Run full suite**

```bash
npm test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/ui/chat-view-provider.ts src/agent/agent-controller.ts
git commit -m "feat: image attachment pipeline — attachments with image MIME types become ContentBlocks for vision-capable providers"
```

---

### Task 6: `generate_diagram` tool

**Files:**
- Create: `src/tools/generate-diagram.ts`
- Test: `test/unit/tools/generate-diagram.test.ts`

This tool writes a mermaid diagram to a `.md` file. The agent provides the mermaid source code; the tool wraps it with the correct fencing and a title heading.

- [ ] **Step 1: Write failing tests**

Create `test/unit/tools/generate-diagram.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { generateDiagramTool } from "../../../src/tools/generate-diagram";

const ctx = {
  workspaceRoot: os.tmpdir(),
  abortSignal: new AbortController().signal,
  reportProgress: () => {},
  requestApproval: async () => true,
};

const outFile = path.join(os.tmpdir(), "test-diagram.md");

afterEach(async () => {
  try { await fs.unlink(outFile); } catch { /* ok */ }
});

describe("generate_diagram tool", () => {
  it("writes a .md file with mermaid fencing", async () => {
    const result = await generateDiagramTool.execute(
      {
        filename: "test-diagram.md",
        title: "Auth Flow",
        diagramType: "sequenceDiagram",
        content: "User->>Server: login\nServer-->>User: token",
      },
      ctx,
    );
    expect(result.success).toBe(true);
    const written = await fs.readFile(outFile, "utf-8");
    expect(written).toContain("# Auth Flow");
    expect(written).toContain("```mermaid");
    expect(written).toContain("User->>Server: login");
    expect(written).toContain("```");
  });

  it("creates parent directories if missing", async () => {
    const deep = path.join(os.tmpdir(), "champ-test-diagrams", "flow.md");
    const result = await generateDiagramTool.execute(
      { filename: deep, title: "T", diagramType: "flowchart", content: "A-->B" },
      ctx,
    );
    expect(result.success).toBe(true);
    await fs.unlink(deep);
    await fs.rmdir(path.dirname(deep));
  });

  it("rejects paths outside the workspace when given a relative path that escapes", async () => {
    // The tool joins relative paths to workspaceRoot. An absolute path
    // outside workspaceRoot should be rejected.
    const result = await generateDiagramTool.execute(
      { filename: "/etc/passwd.md", title: "T", diagramType: "flowchart", content: "A" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("not allowed");
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npm test -- test/unit/tools/generate-diagram.test.ts 2>&1 | tail -8
```

Expected: FAIL — `Cannot find module './generate-diagram'`

- [ ] **Step 3: Create `src/tools/generate-diagram.ts`**

```typescript
import * as path from "path";
import * as fs from "fs/promises";
import type { Tool, ToolExecutionContext, ToolResult } from "./registry";

export const generateDiagramTool: Tool = {
  name: "generate_diagram",
  description:
    "Write a Mermaid diagram to a Markdown file. Provide the Mermaid source code in `content` (no fencing — the tool adds it). Supported types: flowchart, sequenceDiagram, classDiagram, erDiagram, gantt, pie, gitgraph.",
  requiresApproval: true,
  parameters: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description: "Output file path relative to workspace root, e.g. docs/auth-flow.md",
      },
      title: {
        type: "string",
        description: "Diagram title used as the H1 heading in the file",
      },
      diagramType: {
        type: "string",
        enum: [
          "flowchart",
          "sequenceDiagram",
          "classDiagram",
          "erDiagram",
          "gantt",
          "pie",
          "gitgraph",
        ],
        description: "Mermaid diagram type keyword",
      },
      content: {
        type: "string",
        description: "The Mermaid diagram source (without the ```mermaid fencing)",
      },
    },
    required: ["filename", "title", "diagramType", "content"],
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const { filename, title, diagramType, content } = args as {
      filename: string;
      title: string;
      diagramType: string;
      content: string;
    };

    // Resolve to absolute path. Relative paths are joined to workspaceRoot.
    const fullPath = path.isAbsolute(filename)
      ? filename
      : path.join(ctx.workspaceRoot, filename);

    // Refuse to write outside the workspace.
    if (!fullPath.startsWith(ctx.workspaceRoot + path.sep) && fullPath !== ctx.workspaceRoot) {
      // Allow absolute paths only if they're under workspaceRoot.
      if (!fullPath.startsWith(ctx.workspaceRoot)) {
        return {
          success: false,
          output: `Path "${filename}" is outside the workspace — not allowed.`,
        };
      }
    }

    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });

    const markdown = `# ${title}\n\n\`\`\`mermaid\n${diagramType}\n${content}\n\`\`\`\n`;
    await fs.writeFile(fullPath, markdown, "utf-8");

    ctx.reportProgress(`Diagram written to ${filename}`);
    return {
      success: true,
      output: `Mermaid diagram written to ${filename}`,
      metadata: { filesCreated: [fullPath] },
    };
  },
};
```

- [ ] **Step 4: Run tests**

```bash
npm test -- test/unit/tools/generate-diagram.test.ts 2>&1 | tail -8
```

Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/tools/generate-diagram.ts test/unit/tools/generate-diagram.test.ts
git commit -m "feat: generate_diagram tool — writes mermaid diagrams to .md files"
```

---

### Task 7: `generate_doc` tool

**Files:**
- Create: `src/tools/generate-doc.ts`
- Test: `test/unit/tools/generate-doc.test.ts`

This tool writes a technical document (architecture spec, API reference, decision record, etc.) to a Markdown file with a type annotation header.

- [ ] **Step 1: Write failing tests**

Create `test/unit/tools/generate-doc.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { generateDocTool } from "../../../src/tools/generate-doc";

const ctx = {
  workspaceRoot: os.tmpdir(),
  abortSignal: new AbortController().signal,
  reportProgress: () => {},
  requestApproval: async () => true,
};

const outFile = path.join(os.tmpdir(), "test-arch.md");

afterEach(async () => {
  try { await fs.unlink(outFile); } catch { /* ok */ }
});

describe("generate_doc tool", () => {
  it("writes a markdown file with type annotation header", async () => {
    const result = await generateDocTool.execute(
      {
        filename: "test-arch.md",
        docType: "architecture",
        content: "# My System\n\nThis is the architecture.",
      },
      ctx,
    );
    expect(result.success).toBe(true);
    const written = await fs.readFile(outFile, "utf-8");
    expect(written).toContain("type: architecture");
    expect(written).toContain("# My System");
  });

  it("creates parent directories", async () => {
    const deep = path.join(os.tmpdir(), "champ-docs", "spec.md");
    const result = await generateDocTool.execute(
      { filename: deep, docType: "technical", content: "# Spec" },
      ctx,
    );
    expect(result.success).toBe(true);
    await fs.unlink(deep);
    await fs.rmdir(path.dirname(deep));
  });

  it("rejects paths outside workspace", async () => {
    const result = await generateDocTool.execute(
      { filename: "/etc/shadow.md", docType: "architecture", content: "x" },
      ctx,
    );
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npm test -- test/unit/tools/generate-doc.test.ts 2>&1 | tail -8
```

- [ ] **Step 3: Create `src/tools/generate-doc.ts`**

```typescript
import * as path from "path";
import * as fs from "fs/promises";
import type { Tool, ToolExecutionContext, ToolResult } from "./registry";

const DOC_TYPES = [
  "architecture",
  "api-reference",
  "decision-record",
  "component-spec",
  "technical",
] as const;

export const generateDocTool: Tool = {
  name: "generate_doc",
  description:
    "Write a technical document to a Markdown file. Provide the full Markdown content. Supported docTypes: architecture, api-reference, decision-record, component-spec, technical. A metadata comment is prepended automatically.",
  requiresApproval: true,
  parameters: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description: "Output file path relative to workspace root, e.g. docs/ARCHITECTURE.md",
      },
      docType: {
        type: "string",
        enum: [...DOC_TYPES],
        description: "Document type — appended as metadata in the file header",
      },
      content: {
        type: "string",
        description: "Full Markdown content of the document",
      },
    },
    required: ["filename", "docType", "content"],
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const { filename, docType, content } = args as {
      filename: string;
      docType: string;
      content: string;
    };

    const fullPath = path.isAbsolute(filename)
      ? filename
      : path.join(ctx.workspaceRoot, filename);

    if (!fullPath.startsWith(ctx.workspaceRoot)) {
      return {
        success: false,
        output: `Path "${filename}" is outside the workspace — not allowed.`,
      };
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const header = `<!-- generated by Champ | type: ${docType} | date: ${date} -->\n\n`;
    await fs.writeFile(fullPath, header + content, "utf-8");

    ctx.reportProgress(`Document written to ${filename}`);
    return {
      success: true,
      output: `Document written to ${filename}`,
      metadata: { filesCreated: [fullPath] },
    };
  },
};
```

- [ ] **Step 4: Run tests**

```bash
npm test -- test/unit/tools/generate-doc.test.ts 2>&1 | tail -8
```

Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/tools/generate-doc.ts test/unit/tools/generate-doc.test.ts
git commit -m "feat: generate_doc tool — writes architecture/technical documents to .md files"
```

---

### Task 8: Extension wiring — register tools, multi-agent command, analytics command

**Files:**
- Modify: `src/extension.ts`

This is the final wiring task. It:
1. Registers `generate_diagram` and `generate_doc` tools in the `ToolRegistry`
2. Adds a `champ.runMultiAgent` command that streams multi-agent workflow progress to the chat panel using the existing `toolCallStart`/`toolCallResult`/`streamDelta` message types
3. Adds a `champ.showAnalytics` command that opens the last run's analytics report in a VS Code output channel
4. Wires `AgentAnalytics` into the active session's `AgentController` so single-agent runs also record analytics

- [ ] **Step 1: Import the new modules in `extension.ts`**

At the top of `src/extension.ts`, in the existing imports section, add:

```typescript
import { generateDiagramTool } from "./tools/generate-diagram";
import { generateDocTool } from "./tools/generate-doc";
import { MultiAgentRunner } from "./agent/multi-agent-runner";
import { AgentAnalytics } from "./observability/agent-analytics";
import type { AgentRunReport } from "./agent-manager/types";
```

- [ ] **Step 2: Register the two new tools**

In the tool registry block (around where `toolRegistry.register(fileSearchTool)` is), add:

```typescript
  toolRegistry.register(generateDiagramTool);
  toolRegistry.register(generateDocTool);
```

- [ ] **Step 3: Add a module-level `lastAnalyticsReport` store**

After the existing module-level singletons (`let smartRouter: SmartRouter | undefined;` etc.), add:

```typescript
let lastAnalyticsReport: AgentRunReport | null = null;
let sessionAnalytics: AgentAnalytics | undefined;
```

- [ ] **Step 4: Wire `AgentAnalytics` into sessions in `loadProvider`**

Inside `loadProvider`, after `agentManager?.swapProvider(newProvider);`, add:

```typescript
      // Wire a fresh AgentAnalytics instance into every session's controller
      // so single-agent runs record token + tool usage automatically.
      sessionAnalytics = new AgentAnalytics();
      agentManager?.listSessions(true).forEach((meta) => {
        const sess = agentManager!.getSession(meta.id);
        sess?.controller.setAnalytics(sessionAnalytics!, "champ");
      });
```

Also wire it when a new session is created. In the `champ.newSession` command handler (inside the command registration block), after `agentManager.createSession(label)`, add:

```typescript
      if (sessionAnalytics) {
        session.controller.setAnalytics(sessionAnalytics, "champ");
      }
```

Apply the same one-liner to `champ.newChat`:

```typescript
      if (agentManager) {
        const session = agentManager.createSession();
        if (sessionAnalytics) session.controller.setAnalytics(sessionAnalytics, "champ");
        ...
```

- [ ] **Step 5: Update `onStreamCompleted` to store the analytics report**

In the existing `chatViewProvider.onStreamCompleted` callback (already in `extension.ts`), add after `broadcastMetrics()`:

```typescript
    if (sessionAnalytics) {
      lastAnalyticsReport = sessionAnalytics.toReport();
    }
```

- [ ] **Step 6: Register `champ.runMultiAgent` command**

Inside the existing `context.subscriptions.push(vscode.commands.registerCommand(...))` block, add a new command registration. Add it after the `champ.rescanModels` command:

```typescript
    vscode.commands.registerCommand("champ.runMultiAgent", async () => {
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

      // Use a fresh analytics instance for this workflow run.
      const runAnalytics = new AgentAnalytics();

      // Stream progress into the chat panel using existing protocol:
      // - toolCallStart for each agent that starts
      // - streamDelta for text output
      // - toolCallResult for each agent that finishes
      chatViewProvider?.postMessage({
        type: "streamDelta",
        text: `🚀 **Multi-agent workflow started**\n\n> ${userRequest}\n\n`,
      });

      const runner = MultiAgentRunner.buildDefaultPipeline(
        provider,
        toolRegistry,
        workspaceRoot,
      );

      try {
        await runner.run(userRequest, {
          analytics: runAnalytics,
          onProgress: (event) => {
            if (event.type === "agent_started") {
              chatViewProvider?.postMessage({
                type: "toolCallStart",
                toolName: event.agentName,
                args: { step: `${event.step}/${event.totalSteps}` },
              });
            } else if (event.type === "agent_completed") {
              chatViewProvider?.postMessage({
                type: "toolCallResult",
                toolName: event.agentName,
                result: event.output.slice(0, 300),
                success: true,
              });
            } else if (event.type === "agent_failed") {
              chatViewProvider?.postMessage({
                type: "toolCallResult",
                toolName: event.agentName,
                result: `Failed (attempt ${event.attempt}): ${event.error}`,
                success: false,
              });
            } else if (event.type === "workflow_complete") {
              lastAnalyticsReport = event.report;
              const md = runAnalytics.formatMarkdown();
              chatViewProvider?.postMessage({ type: "streamDelta", text: `\n\n${md}\n` });
              chatViewProvider?.postMessage({ type: "streamEnd" });
            }
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        chatViewProvider?.postMessage({ type: "error", message: `Multi-agent workflow failed: ${msg}` });
      }
    }),
```

- [ ] **Step 7: Register `champ.showAnalytics` command**

Still inside the same `context.subscriptions.push(...)` block, add:

```typescript
    vscode.commands.registerCommand("champ.showAnalytics", () => {
      if (!lastAnalyticsReport) {
        void vscode.window.showInformationMessage(
          "Champ: no analytics data yet — send a message first.",
        );
        return;
      }
      const channel = vscode.window.createOutputChannel("Champ Analytics");
      channel.clear();
      channel.appendLine("# Champ Analytics Report");
      channel.appendLine("");
      channel.appendLine(`Run ID:     ${lastAnalyticsReport.runId}`);
      channel.appendLine(`Start:      ${new Date(lastAnalyticsReport.startTime).toLocaleTimeString()}`);
      channel.appendLine(`Duration:   ${(lastAnalyticsReport.totalDurationMs / 1000).toFixed(1)}s`);
      channel.appendLine(`Tokens in:  ${lastAnalyticsReport.totalInputTokens}`);
      channel.appendLine(`Tokens out: ${lastAnalyticsReport.totalOutputTokens}`);
      channel.appendLine(`Success:    ${lastAnalyticsReport.success}`);
      channel.appendLine("");
      channel.appendLine("## Per-agent tasks");
      for (const a of lastAnalyticsReport.agents) {
        channel.appendLine(
          `  ${a.success ? "✓" : "✗"} ${a.agentName.padEnd(14)} ${(a.durationMs / 1000).toFixed(1)}s  in=${a.inputTokens}  out=${a.outputTokens}  tools=${a.toolCalls.length}`,
        );
        for (const t of a.toolCalls) {
          channel.appendLine(
            `      [${t.success ? "ok" : "fail"}] ${t.toolName.padEnd(20)} ${t.durationMs}ms`,
          );
        }
      }
      channel.show(true);
    }),
```

- [ ] **Step 8: Register the new commands in `package.json`**

Open `package.json`. In `contributes.commands`, add:

```json
{
  "command": "champ.runMultiAgent",
  "title": "Champ: Run Multi-Agent Workflow",
  "category": "Champ"
},
{
  "command": "champ.showAnalytics",
  "title": "Champ: Show Analytics",
  "category": "Champ"
}
```

- [ ] **Step 9: Type-check**

```bash
npm run check-types 2>&1
```

Expected: no errors. Fix any TypeScript errors before proceeding.

- [ ] **Step 10: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass (530+ passing, 0 failing).

- [ ] **Step 11: Build production bundle to verify no bundling issues**

```bash
npm run package 2>&1 | tail -5
```

Expected: `dist/extension.js` bundle size printed, no errors.

- [ ] **Step 12: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: wire multi-agent workflow, analytics, generate_diagram/doc tools into extension"
```

---

### Task 9: TelemetryConfig — type definition, YAML validation, and config template

**Files:**
- Modify: `src/config/config-loader.ts`
- Modify: `src/extension.ts` (the `generateDefaultConfigYaml` function at line ~1279)

Analytics export is opt-in and requires an explicit `endpoint:` in the YAML. No endpoint = no export. The telemetry block is validated the same way `routing:` is validated.

- [ ] **Step 1: Add `TelemetryConfig` interface to `src/config/config-loader.ts`**

After the `RoutingConfig` interface (around line 87), add:

```typescript
export interface TelemetryConfig {
  enabled?: boolean;
  endpoint: string;
  format?: "json" | "otlp";
  userId?: string;
  headers?: Record<string, string>;
  bufferMaxEvents?: number;
  bufferMaxBytes?: number;
  timeoutMs?: number;
}
```

- [ ] **Step 2: Add `telemetry?` to `ChampConfig`**

Inside the `ChampConfig` interface, after `routing?: RoutingConfig;`, add:

```typescript
  telemetry?: TelemetryConfig;
```

- [ ] **Step 3: Add `telemetry:` validation to `ConfigLoader.validate()`**

At the end of `ConfigLoader.validate()`, just before `return result;` (currently after the `routing` block), add:

```typescript
    // telemetry
    if ("telemetry" in raw) {
      const tel = raw.telemetry;
      if (typeof tel !== "object" || tel === null || Array.isArray(tel)) {
        throw new Error("`telemetry` must be an object");
      }
      const t = tel as Record<string, unknown>;
      if (!("endpoint" in t) || typeof t.endpoint !== "string" || !t.endpoint) {
        throw new Error("telemetry.endpoint must be a non-empty string");
      }
      const out: TelemetryConfig = { endpoint: t.endpoint };
      if ("enabled" in t) {
        if (typeof t.enabled !== "boolean") throw new Error("telemetry.enabled must be a boolean");
        out.enabled = t.enabled;
      }
      if ("format" in t) {
        if (t.format !== "json" && t.format !== "otlp") {
          throw new Error('telemetry.format must be "json" or "otlp"');
        }
        out.format = t.format as "json" | "otlp";
      }
      if ("userId" in t) {
        if (typeof t.userId !== "string") throw new Error("telemetry.userId must be a string");
        out.userId = t.userId;
      }
      if ("headers" in t) {
        if (typeof t.headers !== "object" || t.headers === null || Array.isArray(t.headers)) {
          throw new Error("telemetry.headers must be an object");
        }
        out.headers = t.headers as Record<string, string>;
      }
      if ("bufferMaxEvents" in t) {
        if (typeof t.bufferMaxEvents !== "number") throw new Error("telemetry.bufferMaxEvents must be a number");
        out.bufferMaxEvents = t.bufferMaxEvents;
      }
      if ("bufferMaxBytes" in t) {
        if (typeof t.bufferMaxBytes !== "number") throw new Error("telemetry.bufferMaxBytes must be a number");
        out.bufferMaxBytes = t.bufferMaxBytes;
      }
      if ("timeoutMs" in t) {
        if (typeof t.timeoutMs !== "number") throw new Error("telemetry.timeoutMs must be a number");
        out.timeoutMs = t.timeoutMs;
      }
      result.telemetry = out;
    }
```

- [ ] **Step 4: Add `telemetry:` merge support in `ConfigLoader.merge()`**

Inside `ConfigLoader.merge()`, after the `if (override.routing)` block, add:

```typescript
    if (override.telemetry) {
      result.telemetry = { ...result.telemetry, ...override.telemetry };
    }
```

- [ ] **Step 5: Add commented telemetry section to `generateDefaultConfigYaml()` in `src/extension.ts`**

In the `generateDefaultConfigYaml` function (line ~1279), append to the returned template string (just before the closing backtick):

```yaml

# ── Telemetry Export (opt-in) ──────────────────────────────────────
# Send analytics to an OTLP/HTTP or plain-JSON collector.
# If the collector is offline events are buffered locally and replayed.
# telemetry:
#   enabled: true
#   endpoint: http://localhost:4318/v1/traces   # OTLP HTTP endpoint
#   format: otlp                                 # "otlp" or "json"
#   userId: your-name                            # optional; overrides machineId
#   # headers:                                   # for authenticated collectors
#   #   Authorization: Bearer <token>
#   bufferMaxEvents: 1000                        # drop oldest when exceeded
#   bufferMaxBytes: 5242880                      # 5 MB byte cap
#   timeoutMs: 5000
```

- [ ] **Step 6: Type-check**

```bash
npm run check-types 2>&1
```

Expected: no errors.

- [ ] **Step 7: Run tests**

```bash
npm test 2>&1 | tail -5
```

Expected: all existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/config/config-loader.ts src/extension.ts
git commit -m "feat: TelemetryConfig type + YAML validation + default config template section"
```

---

### Task 10: EventBuffer — offline circular buffer

**Files:**
- Create: `src/telemetry/event-buffer.ts`
- Create: `src/telemetry/event-buffer.test.ts`

The buffer keeps events in memory. When either cap is hit (1 000 events or 5 MB) the oldest event is dropped. `drain()` returns all buffered events and resets the buffer to empty — called by the exporter when it successfully sends.

- [ ] **Step 1: Write the failing tests**

Create `src/telemetry/event-buffer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { EventBuffer } from "../../src/telemetry/event-buffer";

describe("EventBuffer", () => {
  it("stores and drains events", () => {
    const buf = new EventBuffer(100, 1_000_000);
    buf.push({ id: "a" });
    buf.push({ id: "b" });
    const drained = buf.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0]).toEqual({ id: "a" });
    expect(buf.size()).toBe(0);
  });

  it("drops oldest when event cap exceeded", () => {
    const buf = new EventBuffer(3, 1_000_000);
    buf.push({ id: "1" });
    buf.push({ id: "2" });
    buf.push({ id: "3" });
    buf.push({ id: "4" }); // pushes out "1"
    const drained = buf.drain();
    expect(drained.map((e: { id: string }) => e.id)).toEqual(["2", "3", "4"]);
  });

  it("drops oldest when byte cap exceeded", () => {
    // Each event is ~20 bytes when serialized. Cap at 50 bytes.
    const buf = new EventBuffer(1000, 50);
    buf.push({ id: "aaa" }); // ~13 bytes
    buf.push({ id: "bbb" }); // ~13 bytes → total ~26
    buf.push({ id: "ccc" }); // ~13 bytes → would exceed 50; drops "aaa"
    buf.push({ id: "ddd" }); // ~13 bytes → would exceed; drops "bbb"
    const drained = buf.drain();
    expect(drained.map((e: { id: string }) => e.id)).toEqual(["ccc", "ddd"]);
  });

  it("drain resets size and byteSize", () => {
    const buf = new EventBuffer(100, 1_000_000);
    buf.push({ id: "x" });
    buf.drain();
    expect(buf.size()).toBe(0);
    expect(buf.byteSize()).toBe(0);
  });

  it("byteSize tracks serialized size", () => {
    const buf = new EventBuffer(100, 1_000_000);
    const event = { id: "test" };
    buf.push(event);
    expect(buf.byteSize()).toBe(JSON.stringify(event).length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test src/telemetry/event-buffer.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../../src/telemetry/event-buffer'`

- [ ] **Step 3: Implement `EventBuffer`**

Create `src/telemetry/event-buffer.ts`:

```typescript
export class EventBuffer<T = unknown> {
  private queue: T[] = [];
  private _byteSize = 0;

  constructor(
    private readonly maxEvents: number,
    private readonly maxBytes: number,
  ) {}

  push(event: T): void {
    const bytes = JSON.stringify(event).length;
    // Evict oldest until both caps are satisfied.
    while (
      this.queue.length > 0 &&
      (this.queue.length >= this.maxEvents || this._byteSize + bytes > this.maxBytes)
    ) {
      const evicted = this.queue.shift()!;
      this._byteSize -= JSON.stringify(evicted).length;
    }
    this.queue.push(event);
    this._byteSize += bytes;
  }

  drain(): T[] {
    const events = this.queue.splice(0);
    this._byteSize = 0;
    return events;
  }

  size(): number {
    return this.queue.length;
  }

  byteSize(): number {
    return this._byteSize;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test src/telemetry/event-buffer.test.ts 2>&1 | tail -10
```

Expected: 5 tests pass, 0 failing.

- [ ] **Step 5: Type-check**

```bash
npm run check-types 2>&1
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/telemetry/event-buffer.ts src/telemetry/event-buffer.test.ts
git commit -m "feat: EventBuffer — offline circular buffer with event + byte caps"
```

---

### Task 11: AnalyticsExporter — HTTP export with offline buffering and retry

**Files:**
- Create: `src/telemetry/analytics-exporter.ts`
- Create: `src/telemetry/analytics-exporter.test.ts`

`AnalyticsExporter.export(event)` tries to POST immediately. On network failure it pushes the event to `EventBuffer` and schedules a retry (5 s → 10 s → 20 s → 40 s → cap at 300 s, reset on success). `flush()` drains the buffer and retries all events immediately. `dispose()` clears the retry timer.

The `"otlp"` format wraps events in a minimal OTLP trace spans payload. The `"json"` format posts a raw JSON array.

- [ ] **Step 1: Write the failing tests**

Create `src/telemetry/analytics-exporter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnalyticsExporter } from "../../src/telemetry/analytics-exporter";
import type { TelemetryConfig } from "../../src/config/config-loader";
import type { TelemetryEvent } from "../../src/telemetry/analytics-exporter";

const baseCfg: TelemetryConfig = {
  endpoint: "http://localhost:4318/v1/traces",
  format: "json",
  bufferMaxEvents: 10,
  bufferMaxBytes: 100_000,
  timeoutMs: 1000,
};

const sampleEvent: TelemetryEvent = {
  runId: "r1",
  timestamp: "2026-04-22T00:00:00.000Z",
  userId: "user-abc",
  sessionId: "sess-1",
  workspaceId: "ws-abc",
  extensionVersion: "1.5.0",
  report: {
    runId: "r1",
    startTime: 0,
    totalDurationMs: 100,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    success: true,
    agents: [],
  },
};

describe("AnalyticsExporter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts event when endpoint is reachable", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const exp = new AnalyticsExporter(baseCfg, "user-abc", "ws-abc");
    await exp.export(sampleEvent);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(baseCfg.endpoint);
    exp.dispose();
  });

  it("buffers event when fetch throws", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const exp = new AnalyticsExporter(baseCfg, "user-abc", "ws-abc");
    await exp.export(sampleEvent);
    expect(exp.bufferedCount()).toBe(1);
    exp.dispose();
  });

  it("flush sends buffered events and clears buffer on success", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const exp = new AnalyticsExporter(baseCfg, "user-abc", "ws-abc");
    await exp.export(sampleEvent); // goes to buffer
    await exp.flush();             // retries successfully
    expect(exp.bufferedCount()).toBe(0);
    exp.dispose();
  });

  it("flush keeps events in buffer when endpoint still unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("offline"));
    const exp = new AnalyticsExporter(baseCfg, "user-abc", "ws-abc");
    await exp.export(sampleEvent);
    await exp.flush();
    expect(exp.bufferedCount()).toBe(1);
    exp.dispose();
  });

  it("wraps payload in OTLP envelope when format is otlp", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const exp = new AnalyticsExporter({ ...baseCfg, format: "otlp" }, "user-abc", "ws-abc");
    await exp.export(sampleEvent);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { resourceSpans: unknown[] };
    expect(body).toHaveProperty("resourceSpans");
    exp.dispose();
  });

  it("sends custom headers when configured", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const exp = new AnalyticsExporter(
      { ...baseCfg, headers: { Authorization: "Bearer tok" } },
      "user-abc",
      "ws-abc",
    );
    await exp.export(sampleEvent);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    exp.dispose();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test src/telemetry/analytics-exporter.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../../src/telemetry/analytics-exporter'`

- [ ] **Step 3: Implement `AnalyticsExporter`**

Create `src/telemetry/analytics-exporter.ts`:

```typescript
import { EventBuffer } from "./event-buffer";
import type { TelemetryConfig } from "../config/config-loader";
import type { AgentRunReport } from "../agent-manager/types";

export interface TelemetryEvent {
  runId: string;
  timestamp: string;
  userId: string;
  userEmail?: string;
  sessionId: string;
  workspaceId: string;
  extensionVersion: string;
  report: AgentRunReport;
}

const DEFAULT_BUFFER_EVENTS = 1_000;
const DEFAULT_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 300_000];

export class AnalyticsExporter {
  private readonly buffer: EventBuffer<TelemetryEvent>;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: TelemetryConfig,
    private readonly userId: string,
    private readonly workspaceId: string,
  ) {
    this.buffer = new EventBuffer<TelemetryEvent>(
      config.bufferMaxEvents ?? DEFAULT_BUFFER_EVENTS,
      config.bufferMaxBytes ?? DEFAULT_BUFFER_BYTES,
    );
  }

  async export(event: TelemetryEvent): Promise<void> {
    const success = await this.send([event]);
    if (!success) {
      this.buffer.push(event);
      this.scheduleRetry();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.size() === 0) return;
    const events = this.buffer.drain();
    const success = await this.send(events);
    if (!success) {
      // Put them back
      events.forEach((e) => this.buffer.push(e));
    } else {
      this.retryAttempt = 0;
      this.clearRetryTimer();
    }
  }

  bufferedCount(): number {
    return this.buffer.size();
  }

  dispose(): void {
    this.clearRetryTimer();
  }

  private async send(events: TelemetryEvent[]): Promise<boolean> {
    const { endpoint, format = "otlp", headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = this.config;
    const body = format === "otlp" ? this.toOtlpPayload(events) : JSON.stringify(events);
    const contentType = "application/json";

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": contentType, ...headers },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  private toOtlpPayload(events: TelemetryEvent[]): string {
    const spans = events.map((ev) => ({
      traceId: ev.runId.replace(/-/g, "").padEnd(32, "0"),
      spanId: ev.runId.replace(/-/g, "").slice(0, 16).padEnd(16, "0"),
      name: "champ.agent_run",
      kind: 3, // CLIENT
      startTimeUnixNano: String(new Date(ev.timestamp).getTime() * 1_000_000),
      endTimeUnixNano: String(
        (new Date(ev.timestamp).getTime() + ev.report.totalDurationMs) * 1_000_000,
      ),
      attributes: [
        { key: "user.id", value: { stringValue: ev.userId } },
        { key: "session.id", value: { stringValue: ev.sessionId } },
        { key: "workspace.id", value: { stringValue: ev.workspaceId } },
        { key: "extension.version", value: { stringValue: ev.extensionVersion } },
        { key: "tokens.input", value: { intValue: ev.report.totalInputTokens } },
        { key: "tokens.output", value: { intValue: ev.report.totalOutputTokens } },
        { key: "run.success", value: { boolValue: ev.report.success } },
        { key: "run.duration_ms", value: { intValue: ev.report.totalDurationMs } },
        ...(ev.userEmail
          ? [{ key: "user.email", value: { stringValue: ev.userEmail } }]
          : []),
      ],
      status: { code: ev.report.success ? 1 : 2 },
    }));

    return JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "champ-vscode" } },
              { key: "service.version", value: { stringValue: events[0]?.extensionVersion ?? "" } },
            ],
          },
          scopeSpans: [{ spans }],
        },
      ],
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return; // already scheduled
    const delayMs = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)];
    this.retryAttempt++;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      await this.flush();
      if (this.buffer.size() > 0) {
        this.scheduleRetry(); // still failing — schedule again
      }
    }, delayMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test src/telemetry/analytics-exporter.test.ts 2>&1 | tail -10
```

Expected: 6 tests pass, 0 failing.

- [ ] **Step 5: Type-check**

```bash
npm run check-types 2>&1
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/telemetry/analytics-exporter.ts src/telemetry/analytics-exporter.test.ts
git commit -m "feat: AnalyticsExporter — OTLP/JSON HTTP export with EventBuffer offline replay"
```

---

### Task 12: Wire `AnalyticsExporter` into extension activation

**Files:**
- Modify: `src/extension.ts`

`AnalyticsExporter` is created once during activation (when `yamlConfig.telemetry` is present) and reused across sessions. It receives a `TelemetryEvent` after every completed run (single-agent and multi-agent). `dispose()` is called on extension deactivation.

- [ ] **Step 1: Add imports in `src/extension.ts`**

In the existing imports block at the top of `src/extension.ts`, add:

```typescript
import { AnalyticsExporter } from "./telemetry/analytics-exporter";
import type { TelemetryEvent } from "./telemetry/analytics-exporter";
```

- [ ] **Step 2: Add module-level exporter singleton**

After the `let lastAnalyticsReport: AgentRunReport | null = null;` line (added in Task 8 Step 3), add:

```typescript
let analyticsExporter: AnalyticsExporter | undefined;
```

- [ ] **Step 3: Instantiate `AnalyticsExporter` when config is loaded**

Inside `loadProvider` (the function that runs on every YAML config reload), after the existing `smartRouter.discover()` block, add:

```typescript
      // Rebuild telemetry exporter whenever config reloads.
      analyticsExporter?.dispose();
      analyticsExporter = undefined;
      if (yamlConfig?.telemetry?.enabled !== false && yamlConfig?.telemetry?.endpoint) {
        const machineId: string = vscode.env.machineId;
        const resolvedUserId = yamlConfig.telemetry.userId ?? machineId;
        const wsHash = workspaceRoot
          ? Buffer.from(workspaceRoot).toString("base64").slice(0, 8)
          : "unknown";
        analyticsExporter = new AnalyticsExporter(yamlConfig.telemetry, resolvedUserId, wsHash);
      }
```

- [ ] **Step 4: Export analytics event after each completed run**

In the `chatViewProvider.onStreamCompleted` callback (where `lastAnalyticsReport = sessionAnalytics.toReport()` was added in Task 8 Step 5), add immediately after:

```typescript
    if (analyticsExporter && lastAnalyticsReport) {
      const event: TelemetryEvent = {
        runId: lastAnalyticsReport.runId,
        timestamp: new Date(lastAnalyticsReport.startTime).toISOString(),
        userId: analyticsExporter["userId" as keyof AnalyticsExporter] as string,
        sessionId: agentManager?.activeSessionId ?? "unknown",
        workspaceId: analyticsExporter["workspaceId" as keyof AnalyticsExporter] as string,
        extensionVersion: context.extension.packageJSON.version as string,
        report: lastAnalyticsReport,
      };
      void analyticsExporter.export(event);
    }
```

Wait — accessing private fields via bracket notation is fragile. Refactor `AnalyticsExporter` to expose `userId` and `workspaceId` as public readonly fields by changing the constructor parameters to `public readonly`:

In `src/telemetry/analytics-exporter.ts`, change the constructor signature:

```typescript
  constructor(
    private readonly config: TelemetryConfig,
    public readonly userId: string,
    public readonly workspaceId: string,
  ) {
```

Then update Step 4 to:

```typescript
    if (analyticsExporter && lastAnalyticsReport) {
      const event: TelemetryEvent = {
        runId: lastAnalyticsReport.runId,
        timestamp: new Date(lastAnalyticsReport.startTime).toISOString(),
        userId: analyticsExporter.userId,
        sessionId: agentManager?.activeSessionId ?? "unknown",
        workspaceId: analyticsExporter.workspaceId,
        extensionVersion: context.extension.packageJSON.version as string,
        report: lastAnalyticsReport,
      };
      void analyticsExporter.export(event);
    }
```

- [ ] **Step 5: Export analytics event after multi-agent workflow too**

In the `workflow_complete` branch of the `champ.runMultiAgent` handler (Task 8 Step 6), after `lastAnalyticsReport = event.report;`, add:

```typescript
              if (analyticsExporter) {
                const telEvent: TelemetryEvent = {
                  runId: event.report.runId,
                  timestamp: new Date(event.report.startTime).toISOString(),
                  userId: analyticsExporter.userId,
                  sessionId: "multi-agent",
                  workspaceId: analyticsExporter.workspaceId,
                  extensionVersion: context.extension.packageJSON.version as string,
                  report: event.report,
                };
                void analyticsExporter.export(telEvent);
              }
```

- [ ] **Step 6: Dispose exporter on extension deactivation**

Find the `export function deactivate()` function (or the `context.subscriptions.push(...)` cleanup block). If a `deactivate` function exists, add:

```typescript
export function deactivate(): void {
  analyticsExporter?.dispose();
}
```

If deactivate is not exported, add it at the bottom of `extension.ts`.

- [ ] **Step 7: Type-check**

```bash
npm run check-types 2>&1
```

Expected: no errors. Fix any TypeScript errors before proceeding.

- [ ] **Step 8: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/extension.ts src/telemetry/analytics-exporter.ts
git commit -m "feat: wire AnalyticsExporter into extension — export telemetry after every run"
```

---

### Task 13: Grafana dashboard JSON

**Files:**
- Create: `docs/grafana/champ-analytics-dashboard.json`

This is a static Grafana dashboard JSON file. Import it via Grafana → Dashboards → Import → Upload JSON. It assumes a Prometheus datasource named `Prometheus` and an OTLP → Prometheus pipeline (e.g. OpenTelemetry Collector writing to Prometheus, or Grafana Agent with OTLP receiver). The metrics are produced by an OpenTelemetry Collector that transforms the trace spans Champ exports into Prometheus counters/histograms via the `spanmetricsconnector`.

PromQL metric names used:
- `traces_spanmetrics_calls_total{span_name="champ.agent_run"}` — request rate per user
- `traces_spanmetrics_duration_milliseconds_bucket{span_name="champ.agent_run"}` — latency histogram
- Attribute filters: `user_id`, `run_success`, `workspace_id`
- For token usage and tool calls, the dashboard queries a custom metric `champ_tokens_total` and `champ_tool_calls_total` which the Collector can derive from span attributes using the `transform` processor.

- [ ] **Step 1: Create the directory and dashboard file**

```bash
mkdir -p docs/grafana
```

Create `docs/grafana/champ-analytics-dashboard.json`:

```json
{
  "__inputs": [
    {
      "name": "DS_PROMETHEUS",
      "label": "Prometheus",
      "description": "",
      "type": "datasource",
      "pluginId": "prometheus",
      "pluginName": "Prometheus"
    }
  ],
  "__requires": [
    { "type": "grafana", "id": "grafana", "name": "Grafana", "version": "10.0.0" },
    { "type": "datasource", "id": "prometheus", "name": "Prometheus", "version": "1.0.0" },
    { "type": "panel", "id": "timeseries", "name": "Time series", "version": "" },
    { "type": "panel", "id": "stat", "name": "Stat", "version": "" },
    { "type": "panel", "id": "table", "name": "Table", "version": "" },
    { "type": "panel", "id": "barchart", "name": "Bar chart", "version": "" }
  ],
  "annotations": { "list": [] },
  "editable": true,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 1,
  "id": null,
  "links": [],
  "panels": [
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": { "color": { "mode": "palette-classic" }, "custom": { "lineWidth": 2 } }
      },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "id": 1,
      "options": { "legend": { "displayMode": "list" }, "tooltip": { "mode": "multi" } },
      "title": "Agent Runs / Hour (by user)",
      "type": "timeseries",
      "targets": [
        {
          "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
          "expr": "sum by(user_id) (increase(traces_spanmetrics_calls_total{span_name=\"champ.agent_run\"}[1h]))",
          "legendFormat": "{{user_id}}",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": { "color": { "mode": "thresholds" }, "unit": "ms",
          "thresholds": { "mode": "absolute", "steps": [
            { "color": "green", "value": null },
            { "color": "yellow", "value": 5000 },
            { "color": "red", "value": 15000 }
          ]}
        }
      },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "id": 2,
      "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "orientation": "auto", "textMode": "auto", "colorMode": "background" },
      "title": "P95 Agent Run Duration",
      "type": "stat",
      "targets": [
        {
          "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
          "expr": "histogram_quantile(0.95, sum by(le) (rate(traces_spanmetrics_duration_milliseconds_bucket{span_name=\"champ.agent_run\"}[1h])))",
          "legendFormat": "P95",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": { "color": { "mode": "palette-classic" }, "custom": { "lineWidth": 2 } }
      },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "id": 3,
      "options": { "legend": { "displayMode": "list" }, "tooltip": { "mode": "multi" } },
      "title": "Tokens / Day (by user)",
      "type": "timeseries",
      "targets": [
        {
          "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
          "expr": "sum by(user_id) (increase(champ_tokens_total[1d]))",
          "legendFormat": "{{user_id}}",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": { "color": { "mode": "palette-classic" }, "custom": { "lineWidth": 2 } }
      },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "id": 4,
      "options": { "legend": { "displayMode": "list" }, "tooltip": { "mode": "multi" } },
      "title": "Error Rate / Hour",
      "type": "timeseries",
      "targets": [
        {
          "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
          "expr": "sum(increase(traces_spanmetrics_calls_total{span_name=\"champ.agent_run\",run_success=\"false\"}[1h]))",
          "legendFormat": "errors",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": { "color": { "mode": "palette-classic" } },
        "overrides": []
      },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 16 },
      "id": 5,
      "options": { "xField": "tool_name", "barWidth": 0.7 },
      "title": "Tool Call Frequency / Hour",
      "type": "barchart",
      "targets": [
        {
          "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
          "expr": "sort_desc(sum by(tool_name) (increase(champ_tool_calls_total[1h])))",
          "legendFormat": "{{tool_name}}",
          "refId": "A",
          "instant": true
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {},
        "overrides": [
          { "matcher": { "id": "byName", "options": "Runs" }, "properties": [{ "id": "custom.width", "value": 80 }] },
          { "matcher": { "id": "byName", "options": "Tokens" }, "properties": [{ "id": "custom.width", "value": 100 }] }
        ]
      },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 16 },
      "id": 6,
      "options": { "sortBy": [{ "displayName": "Runs", "desc": true }] },
      "title": "User Activity (last 7d)",
      "type": "table",
      "targets": [
        {
          "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
          "expr": "sum by(user_id) (increase(traces_spanmetrics_calls_total{span_name=\"champ.agent_run\"}[7d]))",
          "legendFormat": "{{user_id}}",
          "refId": "A",
          "instant": true,
          "format": "table"
        }
      ],
      "transformations": [
        { "id": "organize", "options": { "renameByName": { "user_id": "User", "Value": "Runs" } } }
      ]
    }
  ],
  "refresh": "1m",
  "schemaVersion": 38,
  "tags": ["champ", "analytics"],
  "templating": {
    "list": [
      {
        "current": {},
        "hide": 0,
        "includeAll": true,
        "label": "User",
        "multi": true,
        "name": "user_id",
        "options": [],
        "query": {
          "query": "label_values(traces_spanmetrics_calls_total{span_name=\"champ.agent_run\"}, user_id)",
          "refId": "StandardVariableQuery"
        },
        "refresh": 2,
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" }
      }
    ]
  },
  "time": { "from": "now-7d", "to": "now" },
  "timepicker": {},
  "timezone": "browser",
  "title": "Champ Analytics",
  "uid": "champ-analytics-v1",
  "version": 1
}
```

- [ ] **Step 2: Verify the JSON is valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('docs/grafana/champ-analytics-dashboard.json','utf8')); console.log('valid')"
```

Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add docs/grafana/champ-analytics-dashboard.json
git commit -m "feat: Grafana dashboard JSON for Champ analytics (per-user runs, tokens, latency, errors)"
```

---

## Self-Review

**Spec coverage:**
- Multi-agent run support ✓ (Task 3 + 4 + 8 Step 6)
- Analytics on each agent's tasks ✓ (Task 1 + 2 + 8 Steps 3-5, 7)
- Create files ✓ (existing `create_file` tool + new `generate_diagram`/`generate_doc`)
- Code generation ✓ (existing agent loop; multi-agent CodeAgent in Task 4)
- Architecture documents ✓ (`generate_doc` tool, Task 7)
- Mermaid diagrams ✓ (`generate_diagram` tool, Task 6)
- Analyze images ✓ (Task 5 — image attachments become vision ContentBlocks)
- OTLP/HTTP telemetry export with configurable endpoint ✓ (Task 11 `AnalyticsExporter`, Task 12 wiring)
- Offline buffering with replay ✓ (Task 10 `EventBuffer`, Task 11 `scheduleRetry`)
- User/session identification for backtracking ✓ (`vscode.env.machineId`, configurable `userId`, `sessionId` in `TelemetryEvent`)
- Configurable collector/aggregator endpoint + format ✓ (Task 9 `TelemetryConfig.endpoint` + `.format`)
- Grafana dashboard ✓ (Task 13 — per-user runs, tokens, P95 latency, error rate, tool frequency, user activity table)

**Placeholder scan:** All code blocks are complete. No "TBD" or "handle edge cases" stubs.

**Type consistency:**
- `AgentRunReport` defined in Task 1 (types.ts), used in Tasks 4, 8, 11, 12 ✓
- `AgentTaskRecord` defined in Task 1, used in Task 2 (`recordTask`) ✓
- `MultiAgentProgressEvent` defined in Task 4, used in Task 8 ✓
- `ToolCallRecord` defined in Task 1, pushed in Task 2 ✓
- `setHistory` defined in Task 2, used to fix `importSession` in Task 2 ✓
- `setAnalytics` defined in Task 2, called in Task 8 ✓
- `onAgentProgress` added to `WorkflowOptions` in Task 3, consumed by `MultiAgentRunner` in Task 4 ✓
- `TelemetryConfig` defined in Task 9 (config-loader.ts), consumed by `AnalyticsExporter` in Task 11 ✓
- `TelemetryEvent` defined in Task 11 (analytics-exporter.ts), emitted in Task 12 ✓
- `EventBuffer<TelemetryEvent>` instantiated inside `AnalyticsExporter` in Task 11 ✓
- `analyticsExporter.userId` / `.workspaceId` are `public readonly` (Task 11 Step 4 note), accessed in Task 12 Steps 4-5 ✓

**One gap to verify:** `ValidatorAgent` constructor signature (Task 4 Step 4). The plan notes this explicitly — check before running tests.
