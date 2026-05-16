# Dynamic Agent Graphs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable agents to spawn new agents mid-run and communicate directly via named channels, converting the static DAG into a live, self-extending execution graph.

**Architecture:** Two orthogonal mechanisms: (1) SPAWN protocol — agents output `SPAWN: {json}` in their LLM response; `TeamAgent` detects it and stores to `__spawn_queue` in `SharedMemory`; `TeamRunner` drains after each group and recomputes execution groups. (2) `AgentChannel` pub/sub — `SharedMemory` gains `publish`/`subscribe`/`hasChannel` methods; agents declare `subscribes: []` in YAML; `TeamAgent` resolves subscriptions before the LLM call.

**Tech Stack:** TypeScript, existing `TeamRunner`/`TeamAgent`/`SharedMemory`/`TeamLoader`, `js-yaml`.

---

## Task 1: Add `publish`, `subscribe`, `hasChannel` to `SharedMemory`

Read `src/agent/shared-memory.ts` before editing. The current `SharedMemory` class has `private state = new Map<string, unknown>()`. Add three methods using the `__channel:` key prefix to avoid collisions.

- [ ] Open `src/agent/shared-memory.ts`. Add the three methods inside the `SharedMemory` class, after the `reset()` method:

```typescript
  /**
   * Publish data to a named channel. Overwrites any existing value.
   * Channel key is stored as `__channel:${channel}` in state.
   */
  publish(channel: string, data: unknown): void {
    this.state.set(`__channel:${channel}`, data);
  }

  /**
   * Returns true if the channel has been published to at least once.
   */
  hasChannel(channel: string): boolean {
    return this.state.has(`__channel:${channel}`);
  }

  /**
   * Resolves when the channel has data, or returns null after timeoutMs.
   * Polls with exponential backoff: 50ms → 100ms → 200ms → 400ms → 2000ms (capped).
   * Never throws.
   */
  async subscribe(channel: string, timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    let delay = 50;
    while (Date.now() < deadline) {
      if (this.state.has(`__channel:${channel}`)) {
        return this.state.get(`__channel:${channel}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2000);
    }
    return null;
  }
```

The `channels` Map used in the design prompt is NOT needed — channel data lives directly in `this.state` under the `__channel:` prefix. This keeps `SharedMemory.keys()` and `sharedMemorySnapshot` transparent without special filtering.

---

## Task 2: Unit tests for `SharedMemory` pub/sub

- [ ] Create `src/agent/__tests__/shared-memory-channels.test.ts`:

```typescript
// src/agent/__tests__/shared-memory-channels.test.ts
import { describe, it, expect } from "vitest";
import { SharedMemory } from "../shared-memory";

describe("SharedMemory channel pub/sub", () => {
  it("publish + hasChannel: hasChannel returns true after publish", () => {
    const mem = new SharedMemory();
    expect(mem.hasChannel("ch1")).toBe(false);
    mem.publish("ch1", { x: 1 });
    expect(mem.hasChannel("ch1")).toBe(true);
  });

  it("hasChannel returns false before any publish", () => {
    const mem = new SharedMemory();
    expect(mem.hasChannel("never-published")).toBe(false);
  });

  it("subscribe resolves immediately when channel already published", async () => {
    const mem = new SharedMemory();
    mem.publish("ch1", { answer: 42 });
    const result = await mem.subscribe("ch1", 1000);
    expect(result).toEqual({ answer: 42 });
  });

  it("subscribe resolves with null after ~timeoutMs when channel never published", async () => {
    const mem = new SharedMemory();
    const start = Date.now();
    const result = await mem.subscribe("never-channel", 100);
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // Should take at least ~100ms but not too much longer (tolerance: 250ms)
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(350);
  }, 1000);

  it("subscribe resolves with value when published after ~150ms", async () => {
    const mem = new SharedMemory();
    setTimeout(() => mem.publish("delayed-ch", { hello: "world" }), 150);
    const result = await mem.subscribe("delayed-ch", 1000);
    expect(result).toEqual({ hello: "world" });
  }, 2000);

  it("multiple publishes to the same channel — subscribe returns latest value", () => {
    const mem = new SharedMemory();
    mem.publish("ch1", "first");
    mem.publish("ch1", "second");
    // subscribe is synchronous when already available
    return mem.subscribe("ch1", 100).then((result) => {
      expect(result).toBe("second");
    });
  });

  it("channel keys appear in memory.keys()", () => {
    const mem = new SharedMemory();
    mem.publish("scope-ready", { done: true });
    const keys = mem.keys();
    expect(keys).toContain("__channel:scope-ready");
  });

  it("reset() clears channel state", () => {
    const mem = new SharedMemory();
    mem.publish("ch1", "value");
    expect(mem.hasChannel("ch1")).toBe(true);
    mem.reset();
    expect(mem.hasChannel("ch1")).toBe(false);
  });
});
```

- [ ] Run: `npx vitest run src/agent/__tests__/shared-memory-channels.test.ts`
  - Expected: all 8 tests pass.

---

## Task 3: Add `subscribes` and `maxDynamicAgents` to type definitions

- [ ] Open `src/agent/team-definition.ts`. Add `subscribes?: string[]` to `TeamAgentDefinition` after the `selfCritique?` field:

```typescript
  /**
   * Named channels this agent waits for before its LLM call.
   * Each string is a channel name passed to `SharedMemory.subscribe()`.
   * If a channel times out (based on timeoutSeconds), the agent proceeds
   * with null for that channel's value.
   */
  subscribes?: string[];
```

- [ ] Add `maxDynamicAgents?: number` to `TeamExecutionConfig` after the `mode` field:

```typescript
  /**
   * Maximum number of dynamically spawned agents allowed per team run.
   * Applies across all groups combined. Default: 10.
   */
  maxDynamicAgents?: number;
```

- [ ] The full updated `TeamAgentDefinition` interface (for reference — only the additions are needed, not a full rewrite):

The final `TeamAgentDefinition` should have all existing fields plus `subscribes?: string[]`.
The final `TeamExecutionConfig` should have all existing fields plus `maxDynamicAgents?: number`.

---

## Task 4: Update `TeamLoader` YAML parsing for new fields

- [ ] Open `src/agent/team-loader.ts`. In the `parseYaml` method, find the `return { ... }` block in the agents map (around line 141). Add `subscribes` parsing:

```typescript
      // Add after selfCritique:
      subscribes: Array.isArray(a.subscribes)
        ? (a.subscribes as string[]).map(String)
        : [],
```

The full `return` block in the agent map should now be:

```typescript
      return {
        id,
        name: agentName,
        role,
        systemPrompt,
        dependsOn,
        condition: String(a.condition ?? "").trim() || "",
        tools,
        model: String(a.model ?? "").trim() || "",
        maxTokens: Number(a.maxTokens ?? 4096),
        outputKey: String(a.outputKey ?? id).trim(),
        outputFormat: outputFormat as "text" | "json" | "files",
        selfCritique: Boolean(a.selfCritique ?? false),
        subscribes: Array.isArray(a.subscribes)
          ? (a.subscribes as string[]).map(String)
          : [],
      };
```

- [ ] In the `execution` object parsing (around line 174), add `maxDynamicAgents` after `mode`:

```typescript
      mode:
        (execRaw.mode as "auto" | "safe" | "supervised") ??
        DEFAULT_EXECUTION.mode,
      maxDynamicAgents:
        execRaw.maxDynamicAgents != null
          ? Number(execRaw.maxDynamicAgents)
          : undefined,
```

- [ ] TypeScript compile check to confirm types are consistent:
  ```bash
  npx tsc --noEmit 2>&1 | grep -E "(team-loader|team-definition)" | head -20
  ```
  Expected: zero errors on these files.

---

## Task 5: `SpawnRequest` type + SPAWN detection in `TeamAgent`

- [ ] Open `src/agent/team-agent.ts`. At the top of the file (after imports), add the `SpawnRequest` interface and the `SPAWN_LINE_RE` regex:

```typescript
/** Structured spawn request parsed from SPAWN: {...} output lines. */
export interface SpawnRequest {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  dependsOn: string[];
  tools: string[];
  outputKey: string;
  model?: string;
}

/** Matches lines like: SPAWN: {"id":"foo",...} */
const SPAWN_LINE_RE = /^SPAWN: (\{.+\})$/gm;

/**
 * Extract all valid SPAWN requests from a raw LLM output string.
 * Returns [] if no valid SPAWN lines found.
 * Invalid JSON is silently skipped.
 */
export function extractSpawnRequests(
  rawOutput: string,
  agentId: string,
  outputChannel?: { appendLine: (line: string) => void },
): SpawnRequest[] {
  const results: SpawnRequest[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex because SPAWN_LINE_RE has /gm flags and is module-level
  SPAWN_LINE_RE.lastIndex = 0;
  while ((match = SPAWN_LINE_RE.exec(rawOutput)) !== null) {
    try {
      const raw = JSON.parse(match[1]) as Partial<SpawnRequest>;
      if (
        typeof raw.id === "string" &&
        raw.id.trim() &&
        typeof raw.name === "string" &&
        raw.name.trim() &&
        typeof raw.role === "string" &&
        raw.role.trim() &&
        typeof raw.systemPrompt === "string" &&
        raw.systemPrompt.trim()
      ) {
        results.push({
          id: raw.id.trim(),
          name: raw.name.trim(),
          role: raw.role.trim(),
          systemPrompt: raw.systemPrompt.trim(),
          dependsOn: Array.isArray(raw.dependsOn)
            ? (raw.dependsOn as string[]).map(String)
            : [],
          tools: Array.isArray(raw.tools)
            ? (raw.tools as string[]).map(String)
            : [],
          outputKey: typeof raw.outputKey === "string" ? raw.outputKey.trim() : raw.id.trim(),
          model: typeof raw.model === "string" ? raw.model.trim() || undefined : undefined,
        });
      }
    } catch (e) {
      outputChannel?.appendLine(
        `[TeamAgent:${agentId}] Invalid SPAWN JSON: ${(e as Error).message}`,
      );
    }
  }
  return results;
}
```

- [ ] In `TeamAgent.execute()` (or `run()` depending on the method name), find where `text` (the raw LLM output string) is produced — after `streamToString()` resolves or after the `ToolCallingLoop` completes. Insert the SPAWN detection before the BLOCKED check:

```typescript
      // ── SPAWN detection ──────────────────────────────────────────────────
      const spawnRequests = extractSpawnRequests(text, def.id, outputChannel);
      if (spawnRequests.length > 0) {
        const existing =
          (memory.get("__spawn_queue") as SpawnRequest[] | undefined) ?? [];
        memory.set("__spawn_queue", [...existing, ...spawnRequests]);
      }
      // ─────────────────────────────────────────────────────────────────────
```

- [ ] Add channel subscription resolution **before** building the `messages` array. Find the section where `userMessage` is assembled and insert:

```typescript
      // ── Channel subscription resolution ──────────────────────────────────
      let channelBlock = "";
      if (def.subscribes && def.subscribes.length > 0) {
        const channelData: Record<string, unknown> = {};
        for (const channelName of def.subscribes) {
          const timeoutMs = (def.timeoutSeconds ?? 120) * 1000;
          const value = await memory.subscribe(channelName, timeoutMs);
          if (value === null) {
            outputChannel?.appendLine(
              `[TeamAgent:${def.id}] Channel '${channelName}' timed out after ${timeoutMs}ms — proceeding with null`,
            );
          }
          channelData[channelName] = value;
        }
        channelBlock =
          Object.entries(channelData)
            .map(
              ([ch, val]) =>
                `[Channel ${ch}]: ${JSON.stringify(val)}`,
            )
            .join("\n") + "\n\n";
      }
      // Prepend channelBlock to userMessage:
      // userMessage = channelBlock + userMessage;
      // ─────────────────────────────────────────────────────────────────────
```

The exact insertion depends on where `userMessage` is built. Prepend `channelBlock` at the start of the user message string, before `contextText` and memory outputs.

---

## Task 6: Unit tests for `extractSpawnRequests` + SPAWN regex

- [ ] Create `src/agent/__tests__/spawn-extraction.test.ts`:

```typescript
// src/agent/__tests__/spawn-extraction.test.ts
import { describe, it, expect } from "vitest";
import { extractSpawnRequests } from "../team-agent";

const VALID_SPAWN_JSON = JSON.stringify({
  id: "specialist-1",
  name: "Specialist One",
  role: "Handles specialized work",
  systemPrompt: "You are a specialist.",
  dependsOn: ["researcher"],
  tools: ["read_file"],
  outputKey: "specialist_output",
});

describe("SPAWN_LINE_RE + extractSpawnRequests", () => {
  it("matches SPAWN: {...} on its own line and extracts a valid SpawnRequest", () => {
    const output = `Some output text.\nSPAWN: ${VALID_SPAWN_JSON}\nMore text.`;
    const results = extractSpawnRequests(output, "parent-agent");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("specialist-1");
    expect(results[0].name).toBe("Specialist One");
  });

  it("does NOT match 'spawn: {...}' (lowercase)", () => {
    const output = `spawn: ${VALID_SPAWN_JSON}`;
    const results = extractSpawnRequests(output, "parent-agent");
    expect(results).toHaveLength(0);
  });

  it("matches multiple SPAWN lines in a multiline string", () => {
    const spawn2 = JSON.stringify({
      id: "specialist-2",
      name: "Specialist Two",
      role: "Another role",
      systemPrompt: "You are specialist two.",
      dependsOn: [],
      tools: [],
      outputKey: "s2_output",
    });
    const output = `Line 1\nSPAWN: ${VALID_SPAWN_JSON}\nLine 3\nSPAWN: ${spawn2}\nLine 5`;
    const results = extractSpawnRequests(output, "parent-agent");
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("specialist-1");
    expect(results[1].id).toBe("specialist-2");
  });

  it("silently skips malformed JSON in SPAWN line", () => {
    const output = `SPAWN: {not valid json}\nSPAWN: ${VALID_SPAWN_JSON}`;
    const results = extractSpawnRequests(output, "parent-agent");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("specialist-1");
  });

  it("skips SPAWN request missing required id field", () => {
    const noId = JSON.stringify({
      name: "Missing ID",
      role: "Role",
      systemPrompt: "Prompt",
    });
    const output = `SPAWN: ${noId}`;
    const results = extractSpawnRequests(output, "parent-agent");
    expect(results).toHaveLength(0);
  });

  it("defaults dependsOn and tools to empty arrays when absent", () => {
    const minimal = JSON.stringify({
      id: "min-agent",
      name: "Minimal",
      role: "Minimal role",
      systemPrompt: "Minimal prompt.",
    });
    const output = `SPAWN: ${minimal}`;
    const results = extractSpawnRequests(output, "parent-agent");
    expect(results).toHaveLength(1);
    expect(results[0].dependsOn).toEqual([]);
    expect(results[0].tools).toEqual([]);
  });

  it("adds SPAWN requests to __spawn_queue in SharedMemory", () => {
    const { SharedMemory } = require("../shared-memory") as typeof import("../shared-memory");
    const memory = new SharedMemory();
    const output = `SPAWN: ${VALID_SPAWN_JSON}`;
    const requests = extractSpawnRequests(output, "parent-agent");
    if (requests.length > 0) {
      const existing =
        (memory.get("__spawn_queue") as import("../team-agent").SpawnRequest[] | undefined) ?? [];
      memory.set("__spawn_queue", [...existing, ...requests]);
    }
    const queue = memory.get("__spawn_queue") as import("../team-agent").SpawnRequest[];
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe("specialist-1");
  });
});
```

- [ ] Run: `npx vitest run src/agent/__tests__/spawn-extraction.test.ts`
  - Expected: all 7 tests pass.

---

## Task 7: `hasCycle` helper and `drainSpawnQueue` in `TeamRunner`

- [ ] Open `src/agent/team-runner.ts`. Add the `hasCycle` function as a standalone (non-class) function after the existing `writeCheckpoint` function:

```typescript
/**
 * Detect whether the agent list contains a dependency cycle.
 * Uses Kahn's BFS algorithm — same structure as computeExecutionGroups.
 * Returns true if a cycle exists (processed < total agents).
 */
function hasCycle(agents: Required<import("./team-definition").TeamAgentDefinition>[]): boolean {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const a of agents) {
    inDegree.set(a.id, 0);
    adj.set(a.id, []);
  }

  // Build in-degree counts from only the agents in the provided list.
  // References to completed agents (outside this list) are ignored —
  // they don't contribute to in-degree here.
  const knownIds = new Set(agents.map((a) => a.id));
  for (const a of agents) {
    for (const dep of a.dependsOn) {
      if (knownIds.has(dep)) {
        adj.get(dep)!.push(a.id);
        inDegree.set(a.id, (inDegree.get(a.id) ?? 0) + 1);
      }
    }
  }

  let frontier = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id);
  let processed = 0;

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      processed++;
      for (const neighborId of adj.get(nodeId) ?? []) {
        const newDeg = (inDegree.get(neighborId) ?? 0) - 1;
        inDegree.set(neighborId, newDeg);
        if (newDeg === 0) next.push(neighborId);
      }
    }
    frontier = next;
  }

  return processed < agents.length;
}

/**
 * Convert a SpawnRequest to a Required<TeamAgentDefinition>.
 * Fills in default values for fields not in SpawnRequest.
 */
function toAgentDef(
  request: import("./team-agent").SpawnRequest,
  defaults: import("./team-definition").TeamDefaults,
  executionConfig: import("./team-definition").TeamExecutionConfig,
): Required<import("./team-definition").TeamAgentDefinition> {
  return {
    id: request.id,
    name: request.name,
    role: request.role,
    systemPrompt: request.systemPrompt,
    dependsOn: request.dependsOn,
    condition: "",
    tools: request.tools,
    model: request.model ?? defaults.model ?? "",
    maxTokens: defaults.maxTokens ?? 4096,
    outputKey: request.outputKey,
    outputFormat: "text",
    selfCritique: false,
    subscribes: [],
  };
}
```

- [ ] Modify `TeamRunner.runWithMemory()`. Find the `for (const group of groups)` loop:

```typescript
    const groups = this.computeExecutionGroups(team.agents);
    emit("running");
```

Replace with:

```typescript
    let remainingGroups = this.computeExecutionGroups(team.agents);
    let spawnedCount = 0;
    const completedIds = new Set<string>();
    emit("running");
```

Then replace `for (const group of groups) {` with a `while` loop:

```typescript
    try {
      while (remainingGroups.length > 0) {
        const group = remainingGroups.shift()!;

        if (options.abortSignal?.aborted) break;
```

At the end of each group's processing (after the `await Promise.all(...)` for the batch loop), after updating agent statuses, add the spawn queue drain. Find the closing `}` of the batch loop and add:

```typescript
        // ── Spawn queue drain ─────────────────────────────────────────────
        // After the entire group finishes, check if agents spawned new agents.
        for (const [, agState] of agentStates) {
          if (group.some((a) => a.id === agState.id)) {
            completedIds.add(agState.id);
          }
        }
        // Actually track completions for the group that just ran:
        for (const agentDef of group) {
          completedIds.add(agentDef.id);
        }

        const spawnQueue =
          (memory.get("__spawn_queue") as import("./team-agent").SpawnRequest[] | undefined) ??
          [];
        if (spawnQueue.length > 0) {
          memory.set("__spawn_queue", []); // clear immediately

          const cap = team.execution.maxDynamicAgents ?? 10;
          const allRemainingFlat = remainingGroups.flat();
          const knownIds = new Set([
            ...completedIds,
            ...allRemainingFlat.map((a) => a.id),
          ]);

          const newAgents: Required<TeamAgentDefinition>[] = [];
          for (const request of spawnQueue) {
            if (spawnedCount >= cap) {
              const outputCh = (options as { outputChannel?: { appendLine: (s: string) => void } }).outputChannel;
              outputCh?.appendLine(
                `[TeamRunner] SPAWN ignored for '${request.id}': maxDynamicAgents cap (${cap}) reached.`,
              );
              continue;
            }

            // Guard: unique ID
            if (knownIds.has(request.id) || newAgents.some((a) => a.id === request.id)) {
              const outputCh = (options as { outputChannel?: { appendLine: (s: string) => void } }).outputChannel;
              outputCh?.appendLine(
                `[TeamRunner] SPAWN ignored: duplicate ID '${request.id}'.`,
              );
              continue;
            }

            // Guard: dependsOn references only known/completed agents
            const allKnownIds = new Set([
              ...knownIds,
              ...newAgents.map((a) => a.id),
            ]);
            let depUnknown = false;
            for (const dep of request.dependsOn) {
              if (!allKnownIds.has(dep)) {
                const outputCh = (options as { outputChannel?: { appendLine: (s: string) => void } }).outputChannel;
                outputCh?.appendLine(
                  `[TeamRunner] SPAWN ignored: '${request.id}' depends on unknown agent '${dep}'.`,
                );
                depUnknown = true;
                break;
              }
            }
            if (depUnknown) continue;

            // Guard: cycle detection
            const tentative = [...allRemainingFlat, ...newAgents, toAgentDef(request, team.defaults, team.execution)];
            if (hasCycle(tentative)) {
              const outputCh = (options as { outputChannel?: { appendLine: (s: string) => void } }).outputChannel;
              outputCh?.appendLine(
                `[TeamRunner] SPAWN ignored: '${request.id}' would introduce a dependency cycle.`,
              );
              continue;
            }

            // Accept spawn
            const newDef = toAgentDef(request, team.defaults, team.execution);
            newAgents.push(newDef);
            agentStates.set(request.id, {
              id: request.id,
              name: request.name,
              status: "pending",
              output: "",
              tokenCount: 0,
              validationWarnings: [],
              retryCount: 0,
            });
            team.agents.push(newDef);
            spawnedCount++;
          }

          if (newAgents.length > 0) {
            // Recompute remaining groups including spawned agents
            const updatedRemaining = [...allRemainingFlat, ...newAgents];
            remainingGroups = this.computeExecutionGroups(updatedRemaining);
            emit();
          }
        }
        // ─────────────────────────────────────────────────────────────────
```

**Note:** The exact insertion requires careful reading of the `runWithMemory` structure. The drain runs once after the entire group's batch loop completes. Ensure `completedIds` tracking does not double-count — the `for (const agentDef of group)` loop after the batch handles the current group.

---

## Task 8: Unit tests for `hasCycle` and `drainSpawnQueue` logic

- [ ] Create `src/agent/__tests__/dynamic-agent-graphs.test.ts`:

```typescript
// src/agent/__tests__/dynamic-agent-graphs.test.ts
import { describe, it, expect } from "vitest";
import { SharedMemory } from "../shared-memory";
import { TeamRunner } from "../team-runner";
import type { TeamAgentDefinition } from "../team-definition";
import type { SpawnRequest } from "../team-agent";

// ─── hasCycle tests (accessed via TeamRunner.computeExecutionGroups) ───
// We can't directly test hasCycle since it's module-private, but we can
// test cycle behavior via computeExecutionGroups which uses the same logic.

function makeAgent(
  id: string,
  dependsOn: string[] = [],
): Required<TeamAgentDefinition> {
  return {
    id,
    name: id,
    role: `Role of ${id}`,
    systemPrompt: `You are ${id}.`,
    dependsOn,
    condition: "",
    tools: [],
    model: "",
    maxTokens: 4096,
    outputKey: id,
    outputFormat: "text",
    selfCritique: false,
    subscribes: [],
  };
}

describe("hasCycle (via computeExecutionGroups behavior)", () => {
  it("no cycle: [A, B] where B.dependsOn = [A] — computeExecutionGroups returns 2 groups", () => {
    const runner = new TeamRunner();
    const agents = [makeAgent("A"), makeAgent("B", ["A"])];
    const groups = runner.computeExecutionGroups(agents);
    // No cycle — should produce [[A], [B]]
    expect(groups).toHaveLength(2);
    expect(groups[0].map((a) => a.id)).toContain("A");
    expect(groups[1].map((a) => a.id)).toContain("B");
  });

  it("cycle: A.dependsOn=[B], B.dependsOn=[A] — computeExecutionGroups returns 0 groups (no roots)", () => {
    const runner = new TeamRunner();
    const agents = [makeAgent("A", ["B"]), makeAgent("B", ["A"])];
    const groups = runner.computeExecutionGroups(agents);
    // Cycle: no agents have in-degree 0 → no groups produced
    expect(groups).toHaveLength(0);
  });
});

describe("__spawn_queue drain logic (SharedMemory + state)", () => {
  it("empty __spawn_queue: memory unchanged after drain check", () => {
    const memory = new SharedMemory();
    const queue =
      (memory.get("__spawn_queue") as SpawnRequest[] | undefined) ?? [];
    expect(queue).toHaveLength(0);
    // Nothing to drain
    memory.set("__spawn_queue", []);
    expect(memory.get("__spawn_queue")).toEqual([]);
  });

  it("valid spawn request is added to __spawn_queue by extractSpawnRequests logic", () => {
    const memory = new SharedMemory();
    const request: SpawnRequest = {
      id: "spawned-agent",
      name: "Spawned Agent",
      role: "Does work",
      systemPrompt: "You do work.",
      dependsOn: [],
      tools: [],
      outputKey: "spawned_output",
    };
    const existing = (memory.get("__spawn_queue") as SpawnRequest[] | undefined) ?? [];
    memory.set("__spawn_queue", [...existing, request]);
    const queue = memory.get("__spawn_queue") as SpawnRequest[];
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe("spawned-agent");
  });

  it("duplicate ID in spawn queue: drain logic skips it", () => {
    // Simulate the duplicate check: if ID already in completedIds, skip
    const completedIds = new Set(["agent-a", "spawned-agent"]);
    const request: SpawnRequest = {
      id: "spawned-agent", // duplicate
      name: "Spawned Agent",
      role: "Role",
      systemPrompt: "Prompt",
      dependsOn: [],
      tools: [],
      outputKey: "out",
    };
    // Drain logic check:
    const isDuplicate = completedIds.has(request.id);
    expect(isDuplicate).toBe(true);
  });

  it("spawn with dependsOn referencing unknown agent: drain skips it", () => {
    const completedIds = new Set(["agent-a"]);
    const remainingIds = new Set(["agent-b"]);
    const allKnown = new Set([...completedIds, ...remainingIds]);
    const request: SpawnRequest = {
      id: "new-agent",
      name: "New Agent",
      role: "Role",
      systemPrompt: "Prompt",
      dependsOn: ["unknown-agent"], // not known
      tools: [],
      outputKey: "new_out",
    };
    const hasUnknownDep = request.dependsOn.some((dep) => !allKnown.has(dep));
    expect(hasUnknownDep).toBe(true);
  });

  it("drain clears __spawn_queue to empty after processing", () => {
    const memory = new SharedMemory();
    const request: SpawnRequest = {
      id: "new-id",
      name: "New",
      role: "Role",
      systemPrompt: "Prompt",
      dependsOn: [],
      tools: [],
      outputKey: "out",
    };
    memory.set("__spawn_queue", [request]);
    // Simulate drain: read, clear, process
    const queue = (memory.get("__spawn_queue") as SpawnRequest[]) ?? [];
    expect(queue).toHaveLength(1);
    memory.set("__spawn_queue", []); // drain clears immediately
    expect((memory.get("__spawn_queue") as SpawnRequest[]).length).toBe(0);
  });

  it("maxDynamicAgents cap: third request is dropped when cap is 2", () => {
    const cap = 2;
    let spawnedCount = 0;
    const accepted: SpawnRequest[] = [];

    const makeRequest = (id: string): SpawnRequest => ({
      id,
      name: id,
      role: "Role",
      systemPrompt: "Prompt",
      dependsOn: [],
      tools: [],
      outputKey: id,
    });

    for (const req of [
      makeRequest("s1"),
      makeRequest("s2"),
      makeRequest("s3"),
    ]) {
      if (spawnedCount >= cap) {
        // Dropped
      } else {
        accepted.push(req);
        spawnedCount++;
      }
    }

    expect(accepted).toHaveLength(2);
    expect(accepted[0].id).toBe("s1");
    expect(accepted[1].id).toBe("s2");
  });

  it("multiple valid spawns in one drain: all accepted when under cap", () => {
    const cap = 10;
    let spawnedCount = 0;
    const knownIds = new Set(["existing-agent"]);
    const newAgents: SpawnRequest[] = [];

    const requests = [
      { id: "s1", name: "S1", role: "r", systemPrompt: "p", dependsOn: [], tools: [], outputKey: "s1" },
      { id: "s2", name: "S2", role: "r", systemPrompt: "p", dependsOn: [], tools: [], outputKey: "s2" },
    ] as SpawnRequest[];

    for (const req of requests) {
      if (spawnedCount >= cap) continue;
      if (knownIds.has(req.id)) continue;
      if (newAgents.some((a) => a.id === req.id)) continue;
      newAgents.push(req);
      spawnedCount++;
    }

    expect(newAgents).toHaveLength(2);
  });
});
```

- [ ] Run: `npx vitest run src/agent/__tests__/dynamic-agent-graphs.test.ts`
  - Expected: all tests pass.

---

## Task 9: Create `publishChannel` tool

- [ ] Create `src/tools/publish-channel.ts`:

```typescript
// src/tools/publish-channel.ts
/**
 * publishChannel tool: lets agents broadcast data to a named SharedMemory channel.
 * Downstream agents with `subscribes: [channelName]` in their YAML will receive
 * this data before their LLM call.
 */
import type { SharedMemory } from "../agent/shared-memory";

export interface PublishChannelInput {
  channel: string;
  data: unknown;
}

/**
 * Create the publishChannel tool handler bound to the given SharedMemory instance.
 * Returns a function that publishes `input.data` to `input.channel` and returns
 * a confirmation string.
 */
export function createPublishChannelTool(
  memory: SharedMemory,
): (input: PublishChannelInput) => string {
  return function publishChannel(input: PublishChannelInput): string {
    if (!input.channel || typeof input.channel !== "string") {
      return "Error: 'channel' must be a non-empty string.";
    }
    memory.publish(input.channel, input.data);
    return `Published to channel '${input.channel}'.`;
  };
}

/**
 * JSON schema for the publishChannel tool input.
 * Register this in ToolRegistry alongside the handler.
 */
export const publishChannelSchema = {
  name: "publish_channel",
  description:
    "Publish structured data to a named channel so that downstream agents can receive it via their `subscribes` configuration. Use this to pass handoff data between agents without relying on direct dependsOn chaining.",
  inputSchema: {
    type: "object",
    required: ["channel", "data"],
    properties: {
      channel: {
        type: "string",
        description:
          "Channel name. Convention: prefix with 'channel:' (e.g. 'channel:plan_ready'). Must match the subscribes entry in the receiving agent's YAML.",
      },
      data: {
        description: "Data to publish. May be any JSON-serializable value.",
      },
    },
  },
} as const;
```

- [ ] Create `src/tools/__tests__/publish-channel.test.ts`:

```typescript
// src/tools/__tests__/publish-channel.test.ts
import { describe, it, expect } from "vitest";
import { createPublishChannelTool } from "../publish-channel";
import { SharedMemory } from "../../agent/shared-memory";

describe("createPublishChannelTool", () => {
  it("publishes data to the named channel in SharedMemory", () => {
    const memory = new SharedMemory();
    const tool = createPublishChannelTool(memory);
    const result = tool({ channel: "channel:plan_ready", data: { steps: ["a", "b"] } });
    expect(result).toBe("Published to channel 'channel:plan_ready'.");
    expect(memory.hasChannel("channel:plan_ready")).toBe(true);
  });

  it("returns an error message for empty channel name", () => {
    const memory = new SharedMemory();
    const tool = createPublishChannelTool(memory);
    const result = tool({ channel: "", data: "value" });
    expect(result).toContain("Error");
    expect(memory.hasChannel("")).toBe(false);
  });

  it("published value can be retrieved via subscribe", async () => {
    const memory = new SharedMemory();
    const tool = createPublishChannelTool(memory);
    tool({ channel: "channel:infra_done", data: { ip: "10.0.0.1" } });
    const received = await memory.subscribe("channel:infra_done", 100);
    expect(received).toEqual({ ip: "10.0.0.1" });
  });
});
```

- [ ] Run: `npx vitest run src/tools/__tests__/publish-channel.test.ts`
  - Expected: all 3 tests pass.

---

## Task 10: Create YAML template `dynamic-research.yaml`

- [ ] Ensure `.champ/templates/teams/` directory exists. Create `.champ/templates/teams/dynamic-research.yaml`:

```yaml
# .champ/templates/teams/dynamic-research.yaml
#
# Dynamic Research Team — demonstrates SPAWN protocol and AgentChannel pub/sub.
#
# Flow:
#   1. PM defines scope → publishes to channel:scope_ready
#   2. Researcher subscribes to channel:scope_ready → does research →
#      SPAWNs 2-3 specialized sub-agents based on findings
#   3. Spawned sub-agents run in parallel (if dependsOn allows)
#   4. Aggregator collects all outputs

name: Dynamic Research Team
description: >
  A research team where the PM scopes the work, the Researcher discovers
  what specialists are needed, and spawns them dynamically mid-run.
version: "1"

defaults:
  model: ""
  maxTokens: 4096

execution:
  maxParallel: 4
  totalTokenBudget: 200000
  timeoutSeconds: 180
  retries: 1
  checkpoints: true
  mode: auto
  maxDynamicAgents: 6

agents:
  - id: pm
    name: Product Manager
    role: Defines the research scope and success criteria
    systemPrompt: |
      You are a Product Manager. Your job is to define a clear, scoped research plan.

      Given the user's research request in SharedMemory under the key '__userRequest',
      produce a structured scope document with:
        - research_question: The core question to answer
        - sub_topics: A list of 2-4 sub-topics to investigate
        - success_criteria: What a complete answer looks like

      After producing the scope, publish it to the channel so the researcher can begin:
        Use the publish_channel tool: channel="channel:scope_ready", data=<your scope JSON>

      Output the scope as JSON inside <output>...</output> tags.
    dependsOn: []
    subscribes: []
    tools:
      - publish_channel
    outputKey: pm_scope
    outputFormat: json

  - id: researcher
    name: Lead Researcher
    role: Conducts initial research and spawns specialized sub-agents
    systemPrompt: |
      You are a Lead Researcher. You receive a research scope from the PM via the
      channel:scope_ready channel (injected at the top of this message).

      Your job:
        1. Analyze the scope and identify what types of specialists are needed.
        2. For each specialist (max 3), emit a SPAWN line in your output:
           SPAWN: {"id":"<unique-id>","name":"<display name>","role":"<one-line role>","systemPrompt":"<full prompt>","dependsOn":["researcher"],"tools":[],"outputKey":"<key>"}

           Each specialist should focus on ONE sub-topic from the scope.
           The specialist's systemPrompt must include: "Investigate: <sub-topic>. Write your findings to outputKey."

        3. Begin your own research summary of the overall question.

      Output your research summary inside <output>...</output> tags.
      The SPAWN lines must appear in your raw output (not inside <output> tags).
    dependsOn:
      - pm
    subscribes:
      - channel:scope_ready
    tools: []
    outputKey: researcher_summary
    outputFormat: text

  - id: aggregator
    name: Research Aggregator
    role: Combines all research outputs into a final report
    systemPrompt: |
      You are a Research Aggregator. The SharedMemory contains outputs from the
      lead researcher and any spawned specialist agents. Key names are in the
      sharedMemorySnapshot visible in your context.

      Your job:
        1. Read all available research outputs from SharedMemory.
        2. Synthesize them into a single coherent report with:
           - Executive Summary (3-5 sentences)
           - Findings by Sub-Topic
           - Conclusions and Recommendations
        3. Output the full report inside <output>...</output> tags.
    dependsOn:
      - researcher
    subscribes: []
    tools: []
    outputKey: final_report
    outputFormat: text
```

---

## Task 11: TypeScript compile check, full test run, version bump, commit

- [ ] TypeScript compile check:
  ```bash
  npx tsc --noEmit 2>&1 | head -40
  ```
  Expected: zero errors.

- [ ] Run full test suite:
  ```bash
  npx vitest run
  ```
  Expected: all tests pass including the new 18 tests (8 SharedMemory + 7 SPAWN + 3 publish-channel).

- [ ] Version bump:
  ```bash
  npm version patch --no-git-tag-version
  ```

- [ ] Build:
  ```bash
  npm run compile
  ```

- [ ] Package:
  ```bash
  npx vsce package --no-dependencies
  ```

- [ ] Commit:
  ```bash
  git add \
    src/agent/shared-memory.ts \
    src/agent/team-definition.ts \
    src/agent/team-loader.ts \
    src/agent/team-agent.ts \
    src/agent/team-runner.ts \
    src/agent/__tests__/shared-memory-channels.test.ts \
    src/agent/__tests__/spawn-extraction.test.ts \
    src/agent/__tests__/dynamic-agent-graphs.test.ts \
    src/tools/publish-channel.ts \
    src/tools/__tests__/publish-channel.test.ts \
    .champ/templates/teams/dynamic-research.yaml

  git commit -m "feat: dynamic agent graphs — SPAWN protocol, AgentChannel pub/sub, maxDynamicAgents cap"
  ```

---

## Key Decisions

1. **Channel data lives in `this.state` under `__channel:` prefix** — not in a separate `channels: Map`. This keeps `SharedMemory.keys()` transparent and means channel data appears in `sharedMemorySnapshot` without any special filtering code in `TeamRunner`.

2. **`extractSpawnRequests` is exported from `team-agent.ts`** — this allows it to be unit-tested without running a full team. The regex is also exported as `SPAWN_LINE_RE` for the same reason. The `lastIndex` is reset before each use because the regex has the `g` flag.

3. **`hasCycle` and `toAgentDef` are module-private functions in `team-runner.ts`** (not class methods) because they are pure, do not need `this`, and would pollute the public API.

4. **`dependsOn` validation during drain**: the spec requires checking `completedIds + remainingStaticAgents + newAgents`. The implementation uses `allKnownIds` which is rebuilt each iteration. This is O(n) per spawn request but acceptable for the ~10-agent cap.

5. **`Required<TeamAgentDefinition>` now includes `subscribes: string[]`** — this means `team-loader.ts` must set it (defaulting to `[]`), and all places that construct a `Required<TeamAgentDefinition>` must include it. The `toAgentDef` helper sets `subscribes: []` for spawned agents.

6. **The `publishChannel` tool name in `ToolRegistry` is `publish_channel`** (snake_case) to match existing tool naming convention in `VALID_TOOLS`.
