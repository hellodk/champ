# Spec: Dynamic Agent Graphs

**Date**: 2026-05-16
**Sprint**: 3

---

## Goal

Enable agents to spawn new agents at runtime by emitting a structured `SPAWN:` protocol line in their output, and to synchronize data across agents via a named-channel pub/sub mechanism built on `SharedMemory`, without breaking the existing static DAG execution model.

---

## Architecture

The existing static DAG in `TeamRunner.computeExecutionGroups()` remains the primary execution strategy. SPAWN and pub/sub are layered on top: after each parallel group completes, `TeamRunner` drains a `__spawn_queue` key from `SharedMemory` and uses `computeExecutionGroups()` on the combined (original remaining + newly spawned) agents to derive updated future groups. The `AgentChannel` pub/sub is a thin wrapper around two new `SharedMemory` methods (`publish` / `subscribe`) that agents use to share structured data with each other before their LLM call, decoupling them from direct `dependsOn` data passing in cases where the data is produced asynchronously mid-group. SPAWN and pub/sub are independent features that may be used together or separately.

---

## SPAWN Protocol

### Output Format

An agent signals a spawn request by including the following on a **single line** in its raw LLM output (before `<output>` tag processing):

```
SPAWN: {"id":"<string>","name":"<string>","role":"<string>","systemPrompt":"<string>","dependsOn":["<agentId>",...],"tools":["<toolName>",...],"outputKey":"<string>","model":"<string>"}
```

- The line must begin with exactly `SPAWN: ` (six characters, case-sensitive, followed by a space).
- The remainder of the line must be a single valid JSON object with no embedded newlines.
- The `model` field is optional. All other fields are required.
- Multiple SPAWN lines in a single agent output are all processed.

### Field Definitions

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique agent ID within the run. Must match `^[a-zA-Z0-9_-]+$`. May not collide with any existing agent ID (static or previously spawned). |
| `name` | `string` | Yes | Display name shown in the team panel. |
| `role` | `string` | Yes | One-line role injected into the system prompt header. |
| `systemPrompt` | `string` | Yes | Full system prompt for the spawned agent. |
| `dependsOn` | `string[]` | Yes | IDs of agents that must complete before this agent starts. May be empty (`[]`). May reference only agents that have already completed or are currently defined (static or previously spawned). Must not reference agents that are still pending in the same group as the spawning agent (see Error Handling). |
| `tools` | `string[]` | Yes | Tool names the spawned agent may use. Pass `[]` for LLM-only agents. |
| `outputKey` | `string` | Yes | Key under which the agent's output is stored in `SharedMemory`. |
| `model` | `string` | No | Model override. If absent, inherits `team.defaults.model`. |

### Detection Regex

`TeamAgent` scans its full raw LLM output string (the complete response text, after streaming is complete but before stripping `<output>` tags) for SPAWN lines using the following regex:

```typescript
const SPAWN_LINE_RE = /^SPAWN: (\{.+\})$/gm;
```

For each match, `match[1]` is the JSON string to parse.

### Storage in SharedMemory

Each valid parsed spawn request is appended to `SharedMemory` under the key `__spawn_queue`:

```typescript
// In TeamAgent, after full output is received:
const spawnRequests = extractSpawnRequests(rawOutput); // uses SPAWN_LINE_RE
if (spawnRequests.length > 0) {
  const existing = (memory.get("__spawn_queue") as SpawnRequest[] | undefined) ?? [];
  memory.set("__spawn_queue", [...existing, ...spawnRequests]);
}
```

`SpawnRequest` is the validated parsed form of the JSON from the SPAWN line, typed as:

```typescript
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
```

### TeamRunner Drain Algorithm

After each parallel group completes (i.e., after the `await Promise.all(...)` for a group resolves), `TeamRunner` runs the following procedure:

```
function drainSpawnQueue(memory, team, remainingStaticAgents, completedIds, spawnedCount):
  queue = memory.get("__spawn_queue") as SpawnRequest[] | undefined ?? []
  if queue is empty: return remainingStaticAgents

  memory.set("__spawn_queue", [])  // clear immediately

  newAgents = []
  for each request in queue:
    // 1. Guard: max dynamic agents
    if spawnedCount >= (team.execution.maxDynamicAgents ?? 10):
      log warning: "SPAWN ignored: maxDynamicAgents cap reached (${team.execution.maxDynamicAgents ?? 10})"
      continue

    // 2. Guard: unique ID
    allKnownIds = completedIds + remainingStaticAgents.map(a.id) + newAgents.map(a.id)
    if request.id in allKnownIds:
      log warning: "SPAWN ignored: duplicate agent ID '${request.id}'"
      continue

    // 3. Guard: dependsOn references only completed or known agents
    for dep in request.dependsOn:
      if dep not in (completedIds + allKnownIds):
        log warning: "SPAWN ignored: '${request.id}' depends on unknown agent '${dep}'"
        goto next_request (skip this spawn entirely)

    // 4. Guard: cycle detection (see below)
    tentativeCombined = remainingStaticAgents + newAgents + [toAgentDef(request)]
    if hasCycle(tentativeCombined):
      log warning: "SPAWN ignored: '${request.id}' would introduce a dependency cycle"
      continue

    // 5. Accept
    newAgents.push(toAgentDef(request, team.defaults))
    spawnedCount++

  // Recompute groups from all remaining agents (static + new)
  combined = remainingStaticAgents + newAgents
  return combined  // TeamRunner re-runs computeExecutionGroups(combined)
```

`toAgentDef(request, defaults)` converts a `SpawnRequest` to `Required<TeamAgentDefinition>` by filling in defaults from `team.defaults` (model, maxTokens, temperature) and `TeamExecutionConfig` (timeoutSeconds, retries) and setting `selfCritique: false`, `condition: ""`, `outputFormat: "text"`.

### Updated `TeamRunner.runWithMemory` Loop Shape

```typescript
const groups = this.computeExecutionGroups(team.agents);
let remainingGroups = [...groups];
let spawnedCount = 0;
const completedIds = new Set<string>();

while (remainingGroups.length > 0) {
  const group = remainingGroups.shift()!;

  // ... run group (existing logic) ...

  for (const agent of group) completedIds.add(agent.id);

  // Drain spawn queue after each group
  const allRemaining = remainingGroups.flat();
  const updatedRemaining = drainSpawnQueue(
    memory, team, allRemaining, completedIds, spawnedCount,
  );
  if (updatedRemaining !== allRemaining) {
    // Recompute groups from updated remaining agent list
    remainingGroups = this.computeExecutionGroups(updatedRemaining);
    spawnedCount += updatedRemaining.length - allRemaining.length;
  }
}
```

### Cycle Detection

`hasCycle(agents: TeamAgentDefinition[]): boolean` uses Kahn's algorithm (same structure as `computeExecutionGroups`): if the number of agents processed through the BFS is less than `agents.length`, a cycle exists. This is O(V+E) and runs synchronously.

### `maxDynamicAgents` Guard

`TeamExecutionConfig` gains a new optional field:

```typescript
maxDynamicAgents?: number;  // Default: 10
```

If `team.execution.maxDynamicAgents` is `undefined`, the effective cap is `10`. When `spawnedCount >= cap` at the time a spawn request is processed, the request is silently dropped and a warning is logged to the Champ output channel: `[TeamRunner] SPAWN ignored for '${request.id}': maxDynamicAgents cap (${cap}) reached.`

---

## AgentChannel Pub/Sub

### New Methods on `SharedMemory`

Three new methods are added to the `SharedMemory` class in `src/agent/shared-memory.ts`:

```typescript
/**
 * Publish data to a named channel. Overwrites any existing value.
 * Downstream `subscribe()` calls waiting on this channel will resolve.
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

Channel keys use the prefix `__channel:` to avoid collisions with user-defined SharedMemory keys. These keys appear in `SharedMemory.keys()` and in the `sharedMemorySnapshot` sent to the team panel — they are not hidden.

### YAML Syntax

`TeamAgentDefinition` gains a new optional field:

```typescript
subscribes?: string[];
```

In the team YAML, agents declare which channels they wait for before their LLM call:

```yaml
agents:
  - id: deployer
    name: Deployer
    role: Deploys the application
    systemPrompt: |
      You deploy applications. Proceed only after infra and plan are ready.
    dependsOn: []
    subscribes:
      - channel:plan_ready
      - channel:infra_done
    tools: [run_terminal]
    outputKey: deploy_result
```

Channel names in the `subscribes` array must be plain strings. The `channel:` prefix is part of the channel name — it is a convention to distinguish channels from other SharedMemory keys, but it is not enforced (any string is valid as a channel name).

### How TeamAgent Uses Subscriptions

Before building the LLM messages array, `TeamAgent` resolves each channel:

```typescript
// In TeamAgent.run(), before constructing the user message:
if (agentDef.subscribes && agentDef.subscribes.length > 0) {
  const channelData: Record<string, unknown> = {};
  for (const channelName of agentDef.subscribes) {
    const timeoutMs = (agentDef.timeoutSeconds ?? 120) * 1000;
    const value = await memory.subscribe(channelName, timeoutMs);
    if (value === null) {
      // Log and continue — agent runs with null for this channel
      outputChannel.appendLine(
        `[TeamAgent:${agentDef.id}] Channel '${channelName}' timed out after ${timeoutMs}ms — proceeding with null`,
      );
    }
    channelData[channelName] = value;
  }

  // Inject resolved channel data at the top of the user message:
  const channelBlock = Object.entries(channelData)
    .map(([ch, val]) => `[Channel ${ch}]: ${JSON.stringify(val)}`)
    .join("\n");
  userMessage = channelBlock + "\n\n" + userMessage;
}
```

The injected block format for each channel:

```
[Channel channel:plan_ready]: {"steps":["step1","step2"]}
[Channel channel:infra_done]: {"ip":"10.0.0.1","region":"us-east-1"}
```

An agent publishes to a channel by calling:

```typescript
memory.publish("channel:plan_ready", { steps: [...] });
```

This call is made by `TeamAgent` after the LLM response if the agent's output contains a `__publish:` directive (outside SPAWN scope for Sprint 3 — direct publish calls are wired via tool calls or post-processing in a later sprint). For Sprint 3, publishing is done by agents that call a new `publishChannel` tool (registered in `ToolRegistry`) with signature:

```typescript
publishChannel({ channel: string; data: unknown }): string
```

This tool calls `memory.publish(channel, data)` and returns `"Published to channel '${channel}'."`.

### `subscribe` Timeout Behavior

If `subscribe()` returns `null` (timeout):
- The agent continues its LLM call with `null` for that channel's data.
- The injected block shows `[Channel channel:plan_ready]: null`.
- A warning is logged to the Champ output channel (see above).
- The agent's `status` remains `"running"` — no special status for channel timeout.

---

## Updated Type Definitions

### `TeamAgentDefinition` additions

```typescript
// src/agent/team-definition.ts — add to TeamAgentDefinition interface:

/**
 * Named channels this agent waits for before its LLM call.
 * Each string is a channel name. `subscribe()` is called for each.
 * If a channel times out, the agent proceeds with null for that channel.
 */
subscribes?: string[];
```

### `TeamExecutionConfig` additions

```typescript
// src/agent/team-definition.ts — add to TeamExecutionConfig interface:

/**
 * Maximum number of dynamically spawned agents allowed per team run.
 * Applies across all groups combined. Default: 10.
 */
maxDynamicAgents?: number;
```

---

## Execution Order for Spawned Agents

Spawned agents are treated as additional nodes in the DAG. Their `dependsOn` may reference:
- Any agent ID that has already completed at the time of the spawn (valid — they are in `completedIds`).
- Any static agent ID that is still pending (valid — `computeExecutionGroups` handles this correctly by placing the spawned agent after its dependencies).

Their `dependsOn` may NOT reference:
- Agent IDs not known to the system (neither completed nor pending) — these are rejected.
- IDs of agents in the group that just completed but whose `dependsOn` the spawned agent shares (this is valid — they are now in `completedIds`).

After `drainSpawnQueue` returns the updated combined agent list, `TeamRunner` calls `this.computeExecutionGroups(updatedRemaining)` to get new groups. These new groups are prepended to (replace) `remainingGroups` — the remaining static-only groups are discarded in favor of the freshly computed set, which correctly interleaves static remaining agents and spawned agents based on `dependsOn`.

### Concrete Example

Given a team with static agents `[A, B, C]` where `B.dependsOn = ["A"]` and `C.dependsOn = ["B"]`:

- Group 0: `[A]`
- Group 1: `[B]`
- Group 2: `[C]`

After group 0 completes, `A` outputs `SPAWN: {id: "D", dependsOn: ["A"], ...}`.

`drainSpawnQueue` accepts `D`. `computeExecutionGroups([B, C, D])`:
- `B.dependsOn = ["A"]` → `A` is in `completedIds` → in-degree of `B` becomes 0 from the completed set → `B` is a root
- `D.dependsOn = ["A"]` → same → `D` is also a root
- Group 1: `[B, D]` (parallel)
- Group 2: `[C]`

`remainingGroups` becomes `[[B, D], [C]]`.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| SPAWN line present but JSON is invalid | Log warning: `[TeamAgent:${id}] Invalid SPAWN JSON: ${e.message}` — skip this line, continue processing other lines |
| Duplicate agent ID in spawn queue | Log warning: `[TeamRunner] SPAWN ignored: duplicate ID '${id}'` — skip |
| `dependsOn` references an unknown agent ID | Log warning: `[TeamRunner] SPAWN ignored: '${id}' depends on unknown agent '${dep}'` — skip the entire spawn request |
| `dependsOn` references an agent in the currently-running group (not yet completed) | Same as unknown ID (the agent is neither in `completedIds` nor in `remainingStaticAgents` during drain) — skip with warning |
| Spawned agent introduces a cycle | Log warning: `[TeamRunner] SPAWN ignored: '${id}' would introduce a dependency cycle` — skip |
| `maxDynamicAgents` cap reached | Log warning: `[TeamRunner] SPAWN ignored for '${id}': maxDynamicAgents cap (${cap}) reached` — skip |
| Channel `subscribe()` timeout | Agent continues with `null` for that channel; warning logged to output channel |
| `publish` tool called with invalid JSON as `data` | The tool accepts `unknown` — no JSON validation enforced; stored as-is |

---

## Testing

### Unit Tests (new file: `src/test/dynamic-agent-graphs.test.ts`)

**Spawn queue drain logic:**

1. `drainSpawnQueue()` with empty `__spawn_queue` returns `remainingAgents` unchanged.
2. `drainSpawnQueue()` with one valid spawn request adds one agent to the returned list.
3. `drainSpawnQueue()` rejects duplicate ID spawn request (ID already in completedIds).
4. `drainSpawnQueue()` rejects spawn with `dependsOn` referencing unknown agent.
5. `drainSpawnQueue()` clears `__spawn_queue` to empty array in SharedMemory after draining.
6. `drainSpawnQueue()` ignores spawns beyond `maxDynamicAgents` cap.
7. Multiple spawns in one drain: first two accepted, third rejected for cap, no error thrown.

**Cycle detection:**

8. `hasCycle([A, B])` where `B.dependsOn = ["A"]` returns `false`.
9. `hasCycle([A, B])` where `A.dependsOn = ["B"]` and `B.dependsOn = ["A"]` returns `true`.
10. `hasCycle([A, B, C])` where `C.dependsOn = ["B"]` and a new spawn `D.dependsOn = ["C"]` adding back `A.dependsOn = ["D"]` returns `true` (full cycle).

**AgentChannel / SharedMemory:**

11. `memory.publish("ch1", { x: 1 })` then `memory.hasChannel("ch1")` returns `true`.
12. `memory.hasChannel("ch1")` returns `false` before any publish.
13. `memory.subscribe("ch1", 1000)` resolves immediately when channel already published.
14. `memory.subscribe("ch1", 100)` resolves with `null` after ~100ms when channel never published (tolerance: ±50ms).
15. `memory.subscribe("ch1", 500)` resolves with the value when published after 150ms.

**Regex detection:**

16. `SPAWN_LINE_RE` matches `SPAWN: {"id":"foo","name":"Bar",...}` on its own line.
17. `SPAWN_LINE_RE` does not match `spawn: {...}` (lowercase).
18. `SPAWN_LINE_RE` matches multiple SPAWN lines in a multiline string.

---

## Files

| File | Status | Change |
|---|---|---|
| `src/agent/shared-memory.ts` | Modified | Add `publish(channel, data)`, `subscribe(channel, timeoutMs)`, `hasChannel(channel)` |
| `src/agent/team-definition.ts` | Modified | Add `subscribes?: string[]` to `TeamAgentDefinition`; add `maxDynamicAgents?: number` to `TeamExecutionConfig` |
| `src/agent/team-agent.ts` | Modified | Detect SPAWN lines in output (using `SPAWN_LINE_RE`), write to `__spawn_queue`; pre-LLM channel resolution via `memory.subscribe()` for each entry in `subscribes` |
| `src/agent/team-runner.ts` | Modified | Add `drainSpawnQueue()` call after each group; maintain `spawnedCount` and `remainingGroups`; re-run `computeExecutionGroups()` on combined list |
| `src/agent/team-loader.ts` | Modified | Parse `subscribes` array and `maxDynamicAgents` number from YAML and populate on `TeamAgentDefinition` / `TeamExecutionConfig` |
| `src/tools/publish-channel.ts` | New | `publishChannel` tool implementation: calls `memory.publish(channel, data)` |
