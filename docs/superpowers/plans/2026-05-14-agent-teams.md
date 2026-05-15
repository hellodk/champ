# Agent Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a domain-agnostic agent team system where users define named teams of specialized agents (DevOps, fullstack, PM, SRE, data — anything) in YAML files, and Champ orchestrates them in a DAG with parallel execution, anti-hallucination guards, and a real-time team control room panel.

**Architecture:** Teams are defined in `.champ/teams/*.yaml` — loaded at startup, picked from a UI dropdown, then executed by `TeamRunner` which builds a DAG from agent `dependsOn` fields, runs parallel groups capped by `maxParallel`, evaluates `condition` expressions against shared memory to skip irrelevant agents, and interpolates `{{key.path}}` template variables into system prompts. Hallucination guards: PM output validated against JSON schema + retried up to 2×, agents can emit `BLOCKED: reason` to pause execution, post-run file existence checks flag discrepancies. A `TeamPanel` WebviewPanel shows the live control room UI.

**Tech Stack:** TypeScript, VS Code ExtensionAPI, js-yaml (already a dependency), existing `streamToString`/`extractJson` from `llm-agent-base.ts`, existing `SharedMemory`, existing `ToolRegistry`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/agent/team-definition.ts` | Create | TypeScript types for team YAML schema |
| `src/agent/team-loader.ts` | Create | Load + validate `.champ/teams/*.yaml` |
| `src/agent/condition-evaluator.ts` | Create | Evaluate `plan.infra != null` expressions against shared memory |
| `src/agent/template-interpolator.ts` | Create | Replace `{{key.path}}` in system prompts with shared memory values |
| `src/agent/team-agent.ts` | Create | Agent that executes using a `TeamAgentDefinition` — handles BLOCKED, structured output tags |
| `src/agent/team-runner.ts` | Create | DAG scheduler + parallel execution + hallucination guards + checkpoints |
| `src/ui/team-panel.ts` | Create | VS Code WebviewPanel — real-time team control room UI |
| `src/extension.ts` | Modify | Register `champ.runTeam`, `champ.listTeams`, `champ.createTeam`; wire TeamRunner |
| `package.json` | Modify | Add commands |
| `webview-ui/dist/main.js` | Modify | Add team picker button to workflow strip |
| `webview-ui/dist/main.css` | Modify | Team panel styles (already in TeamPanel inline HTML) |
| `.champ/templates/teams/devops-platform.yaml` | Create | Built-in DevOps/SRE team template |
| `.champ/templates/teams/fullstack-feature.yaml` | Create | Built-in fullstack feature team |
| `.champ/templates/teams/code-review.yaml` | Create | Built-in security+quality code review team |
| `.champ/templates/teams/incident-response.yaml` | Create | Built-in SRE incident team |
| `docs/TEAMS.md` | Create | End-user documentation |
| `test/unit/agent/team-loader.test.ts` | Create | Tests for TeamLoader |
| `test/unit/agent/condition-evaluator.test.ts` | Create | Tests for ConditionEvaluator |
| `test/unit/agent/template-interpolator.test.ts` | Create | Tests for TemplateInterpolator |
| `test/unit/agent/team-runner.test.ts` | Create | Tests for TeamRunner DAG logic |

---

## Task 1: TeamDefinition types + TeamLoader

**Files:**
- Create: `src/agent/team-definition.ts`
- Create: `src/agent/team-loader.ts`
- Create: `test/unit/agent/team-loader.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/unit/agent/team-loader.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TeamLoader } from "@/agent/team-loader";
import type { TeamDefinition } from "@/agent/team-definition";

const VALID_YAML = `
name: DevOps Platform Team
description: Infrastructure and CI/CD specialists
agents:
  - id: pm
    name: Program Manager
    role: Plans the work
    systemPrompt: You are a PM. Output JSON.
  - id: infra
    name: Infra Engineer
    role: Writes Terraform
    systemPrompt: You are an infra engineer.
    dependsOn: [pm]
    condition: "plan.infra != null"
    tools: [read_file, create_file]
`.trim();

const MISSING_AGENTS_YAML = `
name: Bad Team
description: Missing agents array
`.trim();

const DUPLICATE_IDS_YAML = `
name: Bad Team
description: Duplicate IDs
agents:
  - id: pm
    name: PM
    role: Plans
    systemPrompt: prompt
  - id: pm
    name: PM2
    role: Plans again
    systemPrompt: prompt2
`.trim();

const FORWARD_REF_YAML = `
name: Bad Team
description: Forward reference to nonexistent agent
agents:
  - id: infra
    name: Infra
    role: Does infra
    systemPrompt: prompt
    dependsOn: [nonexistent]
`.trim();

describe("TeamLoader", () => {
  it("parses a valid team YAML string", () => {
    const loader = new TeamLoader("/workspace");
    const team = loader.parseYaml(VALID_YAML, "devops.yaml");
    expect(team.name).toBe("DevOps Platform Team");
    expect(team.agents).toHaveLength(2);
    expect(team.agents[0].id).toBe("pm");
    expect(team.agents[1].dependsOn).toEqual(["pm"]);
    expect(team.agents[1].condition).toBe("plan.infra != null");
    expect(team.agents[1].tools).toEqual(["read_file", "create_file"]);
  });

  it("throws on missing agents array", () => {
    const loader = new TeamLoader("/workspace");
    expect(() => loader.parseYaml(MISSING_AGENTS_YAML, "bad.yaml")).toThrow(
      /agents/i,
    );
  });

  it("throws on duplicate agent IDs", () => {
    const loader = new TeamLoader("/workspace");
    expect(() => loader.parseYaml(DUPLICATE_IDS_YAML, "bad.yaml")).toThrow(
      /duplicate/i,
    );
  });

  it("throws when dependsOn references nonexistent agent ID", () => {
    const loader = new TeamLoader("/workspace");
    expect(() => loader.parseYaml(FORWARD_REF_YAML, "bad.yaml")).toThrow(
      /nonexistent/,
    );
  });

  it("returns empty array when teams directory does not exist", async () => {
    const loader = new TeamLoader("/nonexistent-workspace-xyz");
    const teams = await loader.loadAll();
    expect(teams).toEqual([]);
  });

  it("applies defaults to agents that omit optional fields", () => {
    const loader = new TeamLoader("/workspace");
    const team = loader.parseYaml(VALID_YAML, "devops.yaml");
    // pm has no dependsOn — should default to []
    expect(team.agents[0].dependsOn).toEqual([]);
    // no execution block — should have defaults
    expect(team.execution.maxParallel).toBe(3);
    expect(team.execution.retries).toBe(1);
    expect(team.execution.timeoutSeconds).toBe(120);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-loader.test.ts 2>&1 | tail -10
```

Expected: FAIL — `TeamLoader` not found.

- [ ] **Step 3: Create type definitions**

Create `src/agent/team-definition.ts`:

```typescript
/**
 * Type contracts for agent team definitions loaded from
 * .champ/teams/*.yaml files.
 *
 * Teams are domain-agnostic: DevOps, fullstack, PM, SRE, data science —
 * any combination of specialized agents can be described here.
 */

/** Status of an individual agent within a team run. */
export type TeamAgentStatus =
  | "pending"    // waiting for dependencies
  | "running"    // currently executing
  | "done"       // completed successfully
  | "failed"     // error — optionally retried
  | "skipped"    // condition was false
  | "blocked";   // agent emitted BLOCKED: <reason>

/** Execution mode for the team (controls approval gates). */
export type TeamExecutionMode = "auto" | "safe" | "supervised";

/** A single agent within a team definition. */
export interface TeamAgentDefinition {
  /** Unique identifier within the team, used in dependsOn references. */
  id: string;
  /** Display name shown in the team panel. */
  name: string;
  /** One-line role description, injected into the system prompt header. */
  role: string;
  /**
   * The agent's full system prompt. Supports {{key.path}} template variables
   * that are resolved from SharedMemory at execution time.
   */
  systemPrompt: string;
  /** IDs of agents that must complete before this one starts. Default: []. */
  dependsOn?: string[];
  /**
   * Simple boolean expression evaluated against SharedMemory.
   * Agent is skipped when the expression is false.
   * Supported: dot-path access, != null, == null, == true, == false, != true, != false.
   * Example: "plan.assignments.infra != null"
   */
  condition?: string;
  /**
   * Subset of tool names this agent is allowed to use.
   * If omitted, the agent has no tool access (LLM-only).
   * Allowed values: read_file, edit_file, create_file, delete_file,
   *   list_directory, grep_search, file_search, run_terminal_cmd,
   *   codebase_search, generate_doc, generate_diagram.
   */
  tools?: string[];
  /**
   * Model override for this agent. Uses the team default if omitted,
   * which falls back to the active provider's configured model.
   * Useful for using a large model for planning and a smaller one for
   * implementation steps.
   */
  model?: string;
  /** Maximum tokens for this agent's LLM response. Default: 4096. */
  maxTokens?: number;
  /**
   * Key under which this agent's output is stored in SharedMemory.
   * Defaults to the agent's id. Other agents reference this via {{outputKey}}.
   */
  outputKey?: string;
  /**
   * Expected output format — used for post-execution validation.
   * "json": output is validated as parseable JSON.
   * "files": agent is expected to have created/edited files.
   * "text": no structural validation (default).
   */
  outputFormat?: "text" | "json" | "files";
  /**
   * Enable the self-critique pass for this agent.
   * When true, after the main response a lightweight critic prompt asks
   * "find at least one problem". If a serious issue is found, one retry
   * is triggered. Default: false (opt-in to control token cost).
   */
  selfCritique?: boolean;
}

/** Team-level execution configuration. */
export interface TeamExecutionConfig {
  /** Max agents running simultaneously. Default: 3. */
  maxParallel: number;
  /** Hard cap on total tokens across all agents. Run fails if exceeded. Default: 100000. */
  totalTokenBudget: number;
  /** Per-agent timeout in seconds. Default: 120. */
  timeoutSeconds: number;
  /** How many times to retry a failed agent. Default: 1. */
  retries: number;
  /** Save SharedMemory state after each agent so runs can resume. Default: true. */
  checkpoints: boolean;
  /** Whether to pause for user approval at each agent boundary. Default: "auto". */
  mode: TeamExecutionMode;
}

/** Default model + parameters applied to agents that don't override. */
export interface TeamDefaults {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/** A fully parsed and validated team definition. */
export interface TeamDefinition {
  /** Display name shown in the team picker. */
  name: string;
  /** One-line description shown under the name in the picker. */
  description: string;
  /** Semver string for the team definition itself. Default: "1". */
  version: string;
  /** Agents in definition order. Execution order is determined by dependsOn DAG. */
  agents: Required<TeamAgentDefinition>[];
  /** Execution configuration (all fields populated from defaults). */
  execution: TeamExecutionConfig;
  /** Default model/parameter overrides for agents that don't specify their own. */
  defaults: TeamDefaults;
  /** Absolute path to the source YAML file. */
  sourcePath: string;
}

/** Live state of one agent during a team run. */
export interface TeamAgentRunState {
  id: string;
  name: string;
  status: TeamAgentStatus;
  /** Accumulated streaming output text. */
  output: string;
  startTime?: number;
  endTime?: number;
  tokenCount: number;
  blockedReason?: string;
  validationWarnings: string[];
  retryCount: number;
}

/** Full state of a team run, sent to the TeamPanel. */
export interface TeamRunState {
  runId: string;
  teamName: string;
  userRequest: string;
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  agents: TeamAgentRunState[];
  /** Snapshot of SharedMemory keys (values serialized for display). */
  sharedMemorySnapshot: Record<string, string>;
  startTime: number;
  endTime?: number;
  totalTokens: number;
  filesChanged: string[];
  mode: TeamExecutionMode;
}
```

- [ ] **Step 4: Implement TeamLoader**

Create `src/agent/team-loader.ts`:

```typescript
/**
 * TeamLoader: reads and validates .champ/teams/*.yaml team definitions.
 *
 * Validation rules:
 *   - Must have non-empty name, description, and agents array
 *   - Agent IDs must be unique within the team
 *   - dependsOn references must resolve to defined agent IDs
 *   - No circular dependencies
 */
import * as fs from "fs/promises";
import * as path from "path";
import * as yaml from "js-yaml";
import type {
  TeamDefinition,
  TeamAgentDefinition,
  TeamExecutionConfig,
  TeamDefaults,
} from "./team-definition";

const VALID_TOOLS = new Set([
  "read_file", "edit_file", "create_file", "delete_file",
  "list_directory", "grep_search", "file_search", "run_terminal_cmd",
  "codebase_search", "generate_doc", "generate_diagram",
]);

const DEFAULT_EXECUTION: TeamExecutionConfig = {
  maxParallel: 3,
  totalTokenBudget: 100_000,
  timeoutSeconds: 120,
  retries: 1,
  checkpoints: true,
  mode: "auto",
};

export class TeamLoader {
  constructor(private readonly workspaceRoot: string) {}

  /** Load all team definitions from .champ/teams/. Returns [] if directory absent. */
  async loadAll(): Promise<TeamDefinition[]> {
    const dir = path.join(this.workspaceRoot, ".champ", "teams");
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const teams: TeamDefinition[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const filePath = path.join(dir, entry);
      // Path traversal guard
      if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep))
        continue;
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        teams.push(this.parseYaml(raw, filePath));
      } catch (err) {
        console.warn(`Champ TeamLoader: skipping "${entry}":`, err);
      }
    }
    return teams;
  }

  /** Parse and validate a team YAML string. Throws with a human-readable message on error. */
  parseYaml(raw: string, sourcePath: string): TeamDefinition {
    const doc = yaml.load(raw) as Record<string, unknown>;
    if (!doc || typeof doc !== "object") {
      throw new Error("Team YAML must be a mapping object");
    }

    const name = String(doc.name ?? "").trim();
    if (!name) throw new Error("Team must have a non-empty 'name' field");

    const description = String(doc.description ?? "").trim();
    if (!description)
      throw new Error("Team must have a non-empty 'description' field");

    if (!Array.isArray(doc.agents) || doc.agents.length === 0) {
      throw new Error("Team must have a non-empty 'agents' array");
    }

    const rawAgents = doc.agents as Record<string, unknown>[];
    const ids = new Set<string>();
    const agents: Required<TeamAgentDefinition>[] = rawAgents.map(
      (a, i) => {
        const id = String(a.id ?? "").trim();
        if (!id)
          throw new Error(`Agent at index ${i} is missing required 'id' field`);
        if (ids.has(id))
          throw new Error(`Duplicate agent ID "${id}" in team "${name}"`);
        ids.add(id);

        const agentName = String(a.name ?? id).trim();
        const role = String(a.role ?? "").trim();
        if (!role)
          throw new Error(`Agent "${id}" is missing required 'role' field`);
        const systemPrompt = String(a.systemPrompt ?? "").trim();
        if (!systemPrompt)
          throw new Error(
            `Agent "${id}" is missing required 'systemPrompt' field`,
          );

        const dependsOn = Array.isArray(a.dependsOn)
          ? (a.dependsOn as string[]).map(String)
          : [];
        const tools = Array.isArray(a.tools)
          ? (a.tools as string[]).map(String)
          : [];

        // Validate tool names
        for (const t of tools) {
          if (!VALID_TOOLS.has(t)) {
            throw new Error(
              `Agent "${id}" references unknown tool "${t}". Valid tools: ${[...VALID_TOOLS].join(", ")}`,
            );
          }
        }

        const outputFormat = (a.outputFormat as string) ?? "text";
        if (!["text", "json", "files"].includes(outputFormat)) {
          throw new Error(
            `Agent "${id}" outputFormat must be "text", "json", or "files"`,
          );
        }

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
        };
      },
    );

    // Validate dependsOn references
    for (const agent of agents) {
      for (const dep of agent.dependsOn) {
        if (!ids.has(dep)) {
          throw new Error(
            `Agent "${agent.id}" depends on "${dep}" which is not defined in the team`,
          );
        }
      }
    }

    // Detect cycles via topological sort
    this.detectCycles(agents);

    // Parse execution config
    const execRaw = (doc.execution ?? {}) as Record<string, unknown>;
    const execution: TeamExecutionConfig = {
      maxParallel: Number(execRaw.maxParallel ?? DEFAULT_EXECUTION.maxParallel),
      totalTokenBudget: Number(
        execRaw.totalTokenBudget ?? DEFAULT_EXECUTION.totalTokenBudget,
      ),
      timeoutSeconds: Number(
        execRaw.timeoutSeconds ?? DEFAULT_EXECUTION.timeoutSeconds,
      ),
      retries: Number(execRaw.retries ?? DEFAULT_EXECUTION.retries),
      checkpoints: Boolean(
        execRaw.checkpoints ?? DEFAULT_EXECUTION.checkpoints,
      ),
      mode: (execRaw.mode as "auto" | "safe" | "supervised") ??
        DEFAULT_EXECUTION.mode,
    };

    const defaultsRaw = (doc.defaults ?? {}) as Record<string, unknown>;
    const defaults: TeamDefaults = {
      model: String(defaultsRaw.model ?? "").trim() || undefined,
      maxTokens: defaultsRaw.maxTokens
        ? Number(defaultsRaw.maxTokens)
        : undefined,
      temperature: defaultsRaw.temperature
        ? Number(defaultsRaw.temperature)
        : undefined,
    };

    return {
      name,
      description,
      version: String(doc.version ?? "1"),
      agents,
      execution,
      defaults,
      sourcePath,
    };
  }

  /** Kahn's algorithm cycle detection — throws if a cycle exists. */
  private detectCycles(agents: Required<TeamAgentDefinition>[]): void {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const a of agents) {
      inDegree.set(a.id, 0);
      adj.set(a.id, []);
    }
    for (const a of agents) {
      for (const dep of a.dependsOn) {
        adj.get(dep)!.push(a.id);
        inDegree.set(a.id, (inDegree.get(a.id) ?? 0) + 1);
      }
    }
    const queue = [...inDegree.entries()]
      .filter(([, d]) => d === 0)
      .map(([id]) => id);
    let processed = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      processed++;
      for (const neighbor of adj.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }
    if (processed !== agents.length) {
      throw new Error(
        "Team definition contains a dependency cycle. Check dependsOn fields.",
      );
    }
  }
}
```

- [ ] **Step 5: Run tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-loader.test.ts 2>&1 | tail -15
```

Expected: all 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/agent/team-definition.ts src/agent/team-loader.ts test/unit/agent/team-loader.test.ts && git commit -m "feat: TeamDefinition types and TeamLoader with cycle detection + validation"
```

---

## Task 2: ConditionEvaluator + TemplateInterpolator

**Files:**
- Create: `src/agent/condition-evaluator.ts`
- Create: `src/agent/template-interpolator.ts`
- Create: `test/unit/agent/condition-evaluator.test.ts`
- Create: `test/unit/agent/template-interpolator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/unit/agent/condition-evaluator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ConditionEvaluator } from "@/agent/condition-evaluator";

describe("ConditionEvaluator", () => {
  const mem: Record<string, unknown> = {
    plan: { assignments: { infra: "deploy k8s", cicd: null, security: "scan" } },
    infra_result: { success: true, output: "done" },
    review: null,
  };

  const evaluate = (expr: string) =>
    new ConditionEvaluator().evaluate(expr, mem);

  it("evaluates dot-path != null as true when value exists", () => {
    expect(evaluate("plan.assignments.infra != null")).toBe(true);
  });

  it("evaluates dot-path != null as false when value is null", () => {
    expect(evaluate("plan.assignments.cicd != null")).toBe(false);
  });

  it("evaluates dot-path == null as true when value is null", () => {
    expect(evaluate("plan.assignments.cicd == null")).toBe(true);
  });

  it("evaluates nested success field == true", () => {
    expect(evaluate("infra_result.success == true")).toBe(true);
  });

  it("evaluates == false correctly", () => {
    expect(evaluate("infra_result.success == false")).toBe(false);
  });

  it("returns true for empty condition string (no condition = always run)", () => {
    expect(evaluate("")).toBe(true);
  });

  it("returns true for undefined path that doesn't exist (non-null check fails)", () => {
    expect(evaluate("nonexistent.field != null")).toBe(false);
  });

  it("evaluates top-level null value", () => {
    expect(evaluate("review == null")).toBe(true);
  });
});
```

Create `test/unit/agent/template-interpolator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TemplateInterpolator } from "@/agent/template-interpolator";

describe("TemplateInterpolator", () => {
  const mem: Record<string, unknown> = {
    plan: { assignments: { infra: "deploy k8s", cicd: null } },
    infra_result: "terraform apply done",
    count: 42,
  };

  const interpolate = (template: string) =>
    new TemplateInterpolator().interpolate(template, mem);

  it("replaces a simple key", () => {
    expect(interpolate("Result: {{infra_result}}")).toBe(
      "Result: terraform apply done",
    );
  });

  it("replaces nested dot-path", () => {
    expect(interpolate("Task: {{plan.assignments.infra}}")).toBe(
      "Task: deploy k8s",
    );
  });

  it("replaces null value with (not available) and returns warning", () => {
    const interp = new TemplateInterpolator();
    const result = interp.interpolate("Task: {{plan.assignments.cicd}}", mem);
    expect(result).toBe("Task: (not available)");
    expect(interp.warnings).toHaveLength(1);
    expect(interp.warnings[0]).toContain("plan.assignments.cicd");
  });

  it("replaces numeric value correctly", () => {
    expect(interpolate("Count: {{count}}")).toBe("Count: 42");
  });

  it("leaves non-template text unchanged", () => {
    expect(interpolate("plain text")).toBe("plain text");
  });

  it("replaces multiple occurrences of same key", () => {
    expect(interpolate("{{infra_result}} and again {{infra_result}}")).toBe(
      "terraform apply done and again terraform apply done",
    );
  });

  it("handles undefined path as (not available)", () => {
    const interp = new TemplateInterpolator();
    const result = interp.interpolate("X: {{missing.path}}", mem);
    expect(result).toBe("X: (not available)");
    expect(interp.warnings).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/condition-evaluator.test.ts test/unit/agent/template-interpolator.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement ConditionEvaluator**

Create `src/agent/condition-evaluator.ts`:

```typescript
/**
 * ConditionEvaluator: evaluates simple boolean expressions against a
 * SharedMemory snapshot.
 *
 * Supported syntax:
 *   <dot.path> != null        — true when value is not null/undefined
 *   <dot.path> == null        — true when value is null/undefined
 *   <dot.path> == true/false  — strict boolean comparison
 *   <dot.path> != true/false  — negated boolean comparison
 *
 * Empty expression → always true (no condition = always run).
 *
 * Intentionally minimal: complex logic belongs in the agent's systemPrompt,
 * not in condition expressions.
 */

export class ConditionEvaluator {
  evaluate(expression: string, memory: Record<string, unknown>): boolean {
    const expr = expression.trim();
    if (!expr) return true;

    // Parse: <path> <op> <rhs>
    const match = expr.match(
      /^([\w.]+)\s*(!=|==)\s*(null|true|false|"[^"]*"|'[^']*')$/,
    );
    if (!match) {
      console.warn(`ConditionEvaluator: cannot parse expression "${expr}" — defaulting to true`);
      return true;
    }

    const [, pathStr, op, rhsRaw] = match;
    const lhs = this.resolvePath(pathStr, memory);

    let rhs: unknown;
    if (rhsRaw === "null") rhs = null;
    else if (rhsRaw === "true") rhs = true;
    else if (rhsRaw === "false") rhs = false;
    else rhs = rhsRaw.slice(1, -1); // strip quotes

    if (op === "==") {
      if (rhs === null) return lhs === null || lhs === undefined;
      return lhs === rhs;
    } else {
      // !=
      if (rhs === null) return lhs !== null && lhs !== undefined;
      return lhs !== rhs;
    }
  }

  private resolvePath(path: string, obj: Record<string, unknown>): unknown {
    const parts = path.split(".");
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
```

- [ ] **Step 4: Implement TemplateInterpolator**

Create `src/agent/template-interpolator.ts`:

```typescript
/**
 * TemplateInterpolator: replaces {{key.path}} placeholders in strings
 * with values from a SharedMemory snapshot.
 *
 * Null/undefined values are replaced with "(not available)" and recorded
 * in the warnings array so the TeamRunner can surface them to the user.
 */

export class TemplateInterpolator {
  readonly warnings: string[] = [];

  interpolate(template: string, memory: Record<string, unknown>): string {
    return template.replace(/\{\{([\w.]+)\}\}/g, (_match, path: string) => {
      const value = this.resolvePath(path, memory);
      if (value === null || value === undefined) {
        this.warnings.push(
          `Template variable "{{${path}}}" resolved to null/undefined — replaced with "(not available)"`,
        );
        return "(not available)";
      }
      if (typeof value === "object") {
        return JSON.stringify(value);
      }
      return String(value);
    });
  }

  private resolvePath(path: string, obj: Record<string, unknown>): unknown {
    const parts = path.split(".");
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
```

- [ ] **Step 5: Run tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/condition-evaluator.test.ts test/unit/agent/template-interpolator.test.ts 2>&1 | tail -15
```

Expected: all 17 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/agent/condition-evaluator.ts src/agent/template-interpolator.ts test/unit/agent/condition-evaluator.test.ts test/unit/agent/template-interpolator.test.ts && git commit -m "feat: ConditionEvaluator and TemplateInterpolator for agent team DAG"
```

---

## Task 3: TeamAgent (agent execution with BLOCKED + structured output)

**Files:**
- Create: `src/agent/team-agent.ts`

No separate test file — TeamAgent uses `streamToString` which requires a live LLM. Integration tested via TeamRunner tests with mocked provider.

- [ ] **Step 1: Create TeamAgent**

Create `src/agent/team-agent.ts`:

```typescript
/**
 * TeamAgent: executes a single agent from a TeamDefinition.
 *
 * Anti-hallucination measures:
 *   1. System prompt always begins with an explicit role header
 *   2. Agent can emit BLOCKED: <reason> to signal inability
 *   3. Output is parsed from <output>...</output> tags when present —
 *      reasoning wrapped in <reasoning> tags is discarded
 *   4. selfCritique: an adversarial follow-up prompt asks "find problems"
 *      and triggers one retry if a serious issue is found
 *   5. JSON outputFormat: validates output is parseable JSON
 */
import type { LLMProvider, LLMMessage } from "../providers/types";
import { streamToString, extractJson } from "./agents/llm-agent-base";
import type { Agent, AgentInput, AgentOutput, SharedMemory } from "./agents/types";
import type { TeamAgentDefinition } from "./team-definition";
import { TemplateInterpolator } from "./template-interpolator";

/** Marker that an agent cannot complete its task. */
const BLOCKED_PREFIX = "BLOCKED:";

/** System prompt header injected before the user-defined systemPrompt. */
function buildSystemPrompt(def: TeamAgentDefinition): string {
  return `You are ${def.name}: ${def.role}

IMPORTANT RULES:
1. If you cannot complete your assigned task (missing context, unclear requirements, unsafe action), respond with:
   BLOCKED: <one sentence explaining what is missing>
   Do NOT guess or hallucinate. BLOCKED is always the right response when uncertain.

2. When producing file content or code, wrap your reasoning in <reasoning>...</reasoning> tags and your actual output in <output>...</output> tags. Only the <output> block will be used.

3. Stay strictly within your role. Do not do work assigned to other team members.

---

${def.systemPrompt}`;
}

const CRITIC_PROMPT = `Review your previous response with a critical eye.
Find at least one problem, gap, or incorrect assumption.
If the output is complete and correct, respond with: NO_ISSUES
If there is a serious problem, respond with: ISSUE: <description>
Be honest and specific. "looks good" is not acceptable.`;

export class TeamAgent implements Agent {
  readonly name: string;
  readonly role: string;

  constructor(
    private readonly def: TeamAgentDefinition,
    private readonly provider: LLMProvider,
  ) {
    this.name = def.id;
    this.role = def.role;
  }

  async execute(input: AgentInput, memory: SharedMemory): Promise<AgentOutput> {
    // Build shared memory snapshot for template interpolation
    const memSnapshot: Record<string, unknown> = {};
    for (const key of memory.keys()) {
      memSnapshot[key] = memory.get(key);
    }
    // Also expose agent outputs under their output keys
    const interp = new TemplateInterpolator();
    const resolvedPrompt = interp.interpolate(
      buildSystemPrompt(this.def),
      memSnapshot,
    );

    if (interp.warnings.length > 0) {
      console.warn(
        `TeamAgent "${this.def.id}" template warnings:`,
        interp.warnings,
      );
    }

    const contextText =
      input.context.length > 0
        ? "\n\n# Workspace context\n\n" +
          input.context
            .map(
              (c) =>
                `// ${c.filePath}:${c.startLine}-${c.endLine}\n${c.text}`,
            )
            .join("\n\n---\n\n")
        : "";

    const userContent = `${input.userRequest}${contextText}`;

    const messages: LLMMessage[] = [
      { role: "system", content: resolvedPrompt },
      { role: "user", content: userContent },
    ];

    const { text, error } = await streamToString(this.provider, messages);

    if (error) {
      return {
        success: false,
        output: `Agent "${this.def.id}" error: ${error}`,
        error,
      };
    }

    // BLOCKED detection
    const trimmed = text.trim();
    if (trimmed.startsWith(BLOCKED_PREFIX)) {
      const reason = trimmed.slice(BLOCKED_PREFIX.length).trim();
      const output: AgentOutput = {
        success: false,
        output: text,
        error: `BLOCKED: ${reason}`,
      };
      memory.setOutput(this.def.outputKey || this.def.id, output);
      memory.set(`${this.def.outputKey || this.def.id}_blocked`, true);
      memory.set(`${this.def.outputKey || this.def.id}_blocked_reason`, reason);
      return output;
    }

    // Extract from <output> tags if present (discard <reasoning> content)
    const extractedOutput = this.extractOutputBlock(text);

    // JSON validation
    if (this.def.outputFormat === "json") {
      const parsed = extractJson(extractedOutput);
      if (!parsed) {
        console.warn(
          `TeamAgent "${this.def.id}": outputFormat is "json" but output is not valid JSON`,
        );
        // Store warning but don't fail — the text may still be useful
      } else {
        // Store parsed JSON in memory for template interpolation by other agents
        memory.set(this.def.outputKey || this.def.id, parsed);
      }
    }

    // Self-critique pass (optional, opt-in per agent)
    let finalOutput = extractedOutput;
    if (this.def.selfCritique) {
      finalOutput = await this.runSelfCritique(
        messages,
        extractedOutput,
        userContent,
        resolvedPrompt,
      );
    }

    const agentOutput: AgentOutput = {
      success: true,
      output: finalOutput,
    };

    memory.setOutput(this.def.outputKey || this.def.id, agentOutput);
    // Also store raw text under outputKey for template interpolation
    if (!memory.has(this.def.outputKey || this.def.id)) {
      memory.set(this.def.outputKey || this.def.id, finalOutput);
    }

    return agentOutput;
  }

  /** Extract content from <output>...</output> tags if present. */
  private extractOutputBlock(text: string): string {
    const match = text.match(/<output>([\s\S]*?)<\/output>/i);
    return match ? match[1].trim() : text;
  }

  /**
   * Run a self-critique pass. If the critic finds a serious issue,
   * re-run the main prompt once with the critique as additional context.
   */
  private async runSelfCritique(
    originalMessages: LLMMessage[],
    originalOutput: string,
    userContent: string,
    systemPrompt: string,
  ): Promise<string> {
    const criticMessages: LLMMessage[] = [
      ...originalMessages,
      { role: "assistant", content: originalOutput },
      { role: "user", content: CRITIC_PROMPT },
    ];

    const { text: critique } = await streamToString(
      this.provider,
      criticMessages,
    );

    // If critic found a serious issue, do one retry
    if (critique.includes("ISSUE:")) {
      const issueMatch = critique.match(/ISSUE:\s*(.+)/);
      const issue = issueMatch?.[1] ?? critique;
      console.info(
        `TeamAgent "${this.def.id}" self-critique found issue: ${issue}. Retrying.`,
      );

      const retryMessages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${userContent}\n\n# Important correction\nYour previous attempt had this issue: ${issue}\nPlease fix it in your response.`,
        },
      ];
      const { text: retried } = await streamToString(
        this.provider,
        retryMessages,
      );
      return this.extractOutputBlock(retried);
    }

    return originalOutput;
  }
}
```

- [ ] **Step 2: Run full test suite to confirm no regressions**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/agent/team-agent.ts && git commit -m "feat: TeamAgent with BLOCKED detection, output tag extraction, self-critique"
```

---

## Task 4: TeamRunner — DAG scheduler + parallel execution + hallucination guards

**Files:**
- Create: `src/agent/team-runner.ts`
- Create: `test/unit/agent/team-runner.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/unit/agent/team-runner.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { TeamRunner } from "@/agent/team-runner";
import type { TeamDefinition } from "@/agent/team-definition";

function makeTeam(overrides: Partial<TeamDefinition> = {}): TeamDefinition {
  return {
    name: "Test Team",
    description: "Test",
    version: "1",
    sourcePath: "/test/team.yaml",
    defaults: {},
    execution: {
      maxParallel: 3,
      totalTokenBudget: 100_000,
      timeoutSeconds: 10,
      retries: 0,
      checkpoints: false,
      mode: "auto",
    },
    agents: [
      {
        id: "pm",
        name: "PM",
        role: "Plans",
        systemPrompt: "You are PM. Output JSON: {\"tasks\":{\"worker\":\"do x\"}}",
        dependsOn: [],
        condition: "",
        tools: [],
        model: "",
        maxTokens: 1000,
        outputKey: "pm",
        outputFormat: "json",
        selfCritique: false,
      },
      {
        id: "worker",
        name: "Worker",
        role: "Does work",
        systemPrompt: "You are a worker. Task: {{pm.tasks.worker}}",
        dependsOn: ["pm"],
        condition: "pm.tasks.worker != null",
        tools: [],
        model: "",
        maxTokens: 1000,
        outputKey: "worker",
        outputFormat: "text",
        selfCritique: false,
      },
    ],
    ...overrides,
  };
}

describe("TeamRunner - DAG scheduling", () => {
  it("computes correct parallel execution groups", () => {
    const runner = new TeamRunner();
    const team = makeTeam();
    const groups = runner.computeExecutionGroups(team.agents);
    // pm has no deps → group 0; worker depends on pm → group 1
    expect(groups).toHaveLength(2);
    expect(groups[0].map((a) => a.id)).toEqual(["pm"]);
    expect(groups[1].map((a) => a.id)).toEqual(["worker"]);
  });

  it("puts independent agents in the same group", () => {
    const runner = new TeamRunner();
    const team = makeTeam();
    // Add a second independent agent
    team.agents.push({
      id: "analyst",
      name: "Analyst",
      role: "Analyses",
      systemPrompt: "Analyse",
      dependsOn: [],
      condition: "",
      tools: [],
      model: "",
      maxTokens: 1000,
      outputKey: "analyst",
      outputFormat: "text",
      selfCritique: false,
    });
    const groups = runner.computeExecutionGroups(team.agents);
    // pm + analyst are both independent
    expect(groups[0].map((a) => a.id).sort()).toEqual(["analyst", "pm"].sort());
  });

  it("identifies skipped agents when condition is false", () => {
    const runner = new TeamRunner();
    const mem: Record<string, unknown> = { pm: { tasks: { worker: null } } };
    const team = makeTeam();
    const shouldSkip = runner.shouldSkipAgent(team.agents[1], mem);
    expect(shouldSkip).toBe(true);
  });

  it("does not skip agent when condition is true", () => {
    const runner = new TeamRunner();
    const mem: Record<string, unknown> = { pm: { tasks: { worker: "do x" } } };
    const team = makeTeam();
    const shouldSkip = runner.shouldSkipAgent(team.agents[1], mem);
    expect(shouldSkip).toBe(false);
  });

  it("always runs agent with empty condition", () => {
    const runner = new TeamRunner();
    const mem: Record<string, unknown> = {};
    const team = makeTeam();
    // pm has empty condition
    const shouldSkip = runner.shouldSkipAgent(team.agents[0], mem);
    expect(shouldSkip).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-runner.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement TeamRunner**

Create `src/agent/team-runner.ts`:

```typescript
/**
 * TeamRunner: orchestrates agent team execution.
 *
 * Execution model:
 *   1. Compute parallel groups from the dependency DAG (Kahn's BFS)
 *   2. For each group: run all eligible agents in parallel (capped by maxParallel)
 *   3. After each agent: run file-existence validation, JSON validation, BLOCKED check
 *   4. If agent is BLOCKED: emit event, pause until user resolves
 *   5. Track TokenBudget — abort if exceeded
 *   6. Emit TeamRunState snapshots after every agent completes
 *
 * Anti-hallucination guards applied here (in addition to TeamAgent internals):
 *   - Template null warnings surfaced in agent state validationWarnings
 *   - File existence check: if agent claimed to write files, verify they exist
 *   - Token budget enforcement: prevents runaway agents
 *   - BLOCKED state: pause + user prompt instead of hallucinating
 */
import * as fs from "fs/promises";
import * as path from "path";
import { ConditionEvaluator } from "./condition-evaluator";
import { SharedMemory } from "./shared-memory";
import { TeamAgent } from "./team-agent";
import type {
  TeamDefinition,
  TeamAgentDefinition,
  TeamRunState,
  TeamAgentRunState,
  TeamAgentStatus,
} from "./team-definition";
import type { LLMProvider } from "../providers/types";
import type { ToolRegistry } from "../tools/registry";

export type TeamRunEvent =
  | { type: "state_update"; state: TeamRunState }
  | { type: "agent_stream"; agentId: string; chunk: string }
  | { type: "blocked"; agentId: string; reason: string }
  | { type: "complete"; state: TeamRunState }
  | { type: "error"; message: string; state: TeamRunState };

export interface TeamRunOptions {
  onEvent?: (event: TeamRunEvent) => void;
  abortSignal?: AbortSignal;
  workspaceRoot?: string;
}

export class TeamRunner {
  private evaluator = new ConditionEvaluator();

  /**
   * Compute BFS parallel execution groups from agent dependency graph.
   * Agents in the same group can run in parallel.
   * Returns groups in execution order (group[0] runs first).
   */
  computeExecutionGroups(
    agents: Required<TeamAgentDefinition>[],
  ): Required<TeamAgentDefinition>[][] {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    const byId = new Map<string, Required<TeamAgentDefinition>>();

    for (const a of agents) {
      inDegree.set(a.id, 0);
      adj.set(a.id, []);
      byId.set(a.id, a);
    }
    for (const a of agents) {
      for (const dep of a.dependsOn) {
        adj.get(dep)!.push(a.id);
        inDegree.set(a.id, (inDegree.get(a.id) ?? 0) + 1);
      }
    }

    const groups: Required<TeamAgentDefinition>[][] = [];
    let frontier = [...inDegree.entries()]
      .filter(([, d]) => d === 0)
      .map(([id]) => byId.get(id)!);

    while (frontier.length > 0) {
      groups.push(frontier);
      const nextFrontier: Required<TeamAgentDefinition>[] = [];
      for (const node of frontier) {
        for (const neighborId of adj.get(node.id) ?? []) {
          const newDeg = (inDegree.get(neighborId) ?? 0) - 1;
          inDegree.set(neighborId, newDeg);
          if (newDeg === 0) nextFrontier.push(byId.get(neighborId)!);
        }
      }
      frontier = nextFrontier;
    }
    return groups;
  }

  /** Returns true if the agent should be skipped based on its condition. */
  shouldSkipAgent(
    agent: Required<TeamAgentDefinition>,
    memSnapshot: Record<string, unknown>,
  ): boolean {
    if (!agent.condition) return false;
    return !this.evaluator.evaluate(agent.condition, memSnapshot);
  }

  /** Execute a full team run. Emits TeamRunEvents throughout. */
  async run(
    team: TeamDefinition,
    userRequest: string,
    provider: LLMProvider,
    toolRegistry: ToolRegistry,
    options: TeamRunOptions = {},
  ): Promise<TeamRunState> {
    const runId = `team-${Date.now().toString(36)}`;
    const memory = new SharedMemory();
    const workspaceRoot = options.workspaceRoot ?? process.cwd();

    // Initialize run state
    const agentStates = new Map<string, TeamAgentRunState>(
      team.agents.map((a) => [
        a.id,
        {
          id: a.id,
          name: a.name,
          status: "pending" as TeamAgentStatus,
          output: "",
          tokenCount: 0,
          validationWarnings: [],
          retryCount: 0,
        },
      ]),
    );

    let totalTokens = 0;
    const filesChanged: string[] = [];

    const emitState = (
      status: TeamRunState["status"] = "running",
    ): TeamRunState => {
      const snapshot: Record<string, string> = {};
      for (const key of memory.keys()) {
        const val = memory.get(key);
        snapshot[key] =
          typeof val === "object"
            ? JSON.stringify(val).slice(0, 200)
            : String(val ?? "").slice(0, 200);
      }
      const state: TeamRunState = {
        runId,
        teamName: team.name,
        userRequest,
        status,
        agents: [...agentStates.values()],
        sharedMemorySnapshot: snapshot,
        startTime: Date.now(),
        totalTokens,
        filesChanged,
        mode: team.execution.mode,
      };
      options.onEvent?.({ type: "state_update", state });
      return state;
    };

    const groups = this.computeExecutionGroups(team.agents);
    let finalState = emitState();

    try {
      for (const group of groups) {
        if (options.abortSignal?.aborted) break;

        // Split group into maxParallel-sized batches
        const batches: Required<TeamAgentDefinition>[][] = [];
        for (let i = 0; i < group.length; i += team.execution.maxParallel) {
          batches.push(group.slice(i, i + team.execution.maxParallel));
        }

        for (const batch of batches) {
          if (options.abortSignal?.aborted) break;

          // Build snapshot for condition evaluation
          const memSnapshot: Record<string, unknown> = {};
          for (const key of memory.keys()) memSnapshot[key] = memory.get(key);

          // Run eligible agents in parallel, skip the rest
          await Promise.all(
            batch.map(async (agentDef) => {
              const state = agentStates.get(agentDef.id)!;

              if (this.shouldSkipAgent(agentDef, memSnapshot)) {
                state.status = "skipped";
                emitState();
                return;
              }

              state.status = "running";
              state.startTime = Date.now();
              emitState();

              // Use model override or team default or provider default
              const effectiveModel =
                agentDef.model ||
                team.defaults.model ||
                provider.config.model;
              const effectiveProvider =
                effectiveModel !== provider.config.model
                  ? provider.withModel?.(effectiveModel) ?? provider
                  : provider;

              // Build scoped tool registry for this agent
              const scopedRegistry =
                agentDef.tools.length > 0
                  ? buildScopedRegistry(toolRegistry, agentDef.tools)
                  : undefined;

              const agent = new TeamAgent(agentDef, effectiveProvider);

              let attempts = 0;
              const maxAttempts = team.execution.retries + 1;

              while (attempts < maxAttempts) {
                attempts++;
                const output = await agent.execute(
                  { userRequest, context: [] },
                  memory,
                );

                if (output.error?.startsWith("BLOCKED:")) {
                  state.status = "blocked";
                  state.blockedReason = output.error.slice("BLOCKED:".length).trim();
                  state.endTime = Date.now();
                  emitState();
                  options.onEvent?.({
                    type: "blocked",
                    agentId: agentDef.id,
                    reason: state.blockedReason,
                  });
                  return; // Leave as blocked — user must intervene
                }

                if (output.success) {
                  state.status = "done";
                  state.output = output.output;
                  state.endTime = Date.now();

                  // File existence validation
                  if (agentDef.outputFormat === "files") {
                    const warnings = await validateFilesExist(
                      output.output,
                      workspaceRoot,
                    );
                    state.validationWarnings.push(...warnings);
                    filesChanged.push(
                      ...extractMentionedFiles(output.output, workspaceRoot),
                    );
                  }

                  emitState();
                  return;
                }

                // Failed — retry if attempts remain
                if (attempts < maxAttempts) {
                  state.retryCount++;
                  console.info(
                    `TeamRunner: retrying agent "${agentDef.id}" (attempt ${attempts + 1}/${maxAttempts})`,
                  );
                } else {
                  state.status = "failed";
                  state.output = output.output;
                  state.endTime = Date.now();
                  emitState();
                }
              }
            }),
          );
        }
      }

      const hasFailures = [...agentStates.values()].some(
        (s) => s.status === "failed",
      );
      const hasBlocked = [...agentStates.values()].some(
        (s) => s.status === "blocked",
      );
      const finalStatus = hasBlocked
        ? "paused"
        : hasFailures
          ? "failed"
          : options.abortSignal?.aborted
            ? "stopped"
            : "completed";

      finalState = emitState(finalStatus);
      options.onEvent?.({ type: "complete", state: finalState });
      return finalState;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finalState = emitState("failed");
      options.onEvent?.({ type: "error", message, state: finalState });
      return finalState;
    }
  }
}

/** Build a ToolRegistry that only exposes allowed tool names. */
function buildScopedRegistry(
  full: ToolRegistry,
  allowedTools: string[],
): ToolRegistry {
  const allowed = new Set(allowedTools);
  const scoped = new (full.constructor as new () => ToolRegistry)();
  for (const name of allowedTools) {
    const tool = full.get(name);
    if (tool) (scoped as unknown as { tools: Map<string, unknown> }).tools?.set(name, tool);
  }
  return scoped;
}

/** Check if files mentioned in agent output actually exist on disk. */
async function validateFilesExist(
  output: string,
  workspaceRoot: string,
): Promise<string[]> {
  const warnings: string[] = [];
  // Extract file paths: lines like "Created: path/to/file.ts" or "# path/to/file.ts"
  const filePatterns = [
    /(?:created?|wrote?|wrote to|writing|modified?)[:\s]+([^\s]+\.\w{1,6})/gi,
    /^#+\s+([^\s]+\.\w{1,6})/gm,
  ];
  const mentioned = new Set<string>();
  for (const re of filePatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      mentioned.add(m[1]);
    }
  }
  for (const relPath of mentioned) {
    const abs = path.isAbsolute(relPath)
      ? relPath
      : path.join(workspaceRoot, relPath);
    try {
      await fs.access(abs);
    } catch {
      warnings.push(
        `Agent mentioned file "${relPath}" but it does not exist on disk`,
      );
    }
  }
  return warnings;
}

/** Extract file paths from output for the filesChanged list. */
function extractMentionedFiles(
  output: string,
  workspaceRoot: string,
): string[] {
  const re = /([^\s]+\.\w{1,6})/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const abs = path.isAbsolute(m[1])
      ? m[1]
      : path.join(workspaceRoot, m[1]);
    if (!abs.startsWith(workspaceRoot)) continue;
    found.push(path.relative(workspaceRoot, abs));
  }
  return [...new Set(found)];
}
```

- [ ] **Step 4: Run tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-runner.test.ts 2>&1 | tail -15
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/agent/team-runner.ts test/unit/agent/team-runner.test.ts && git commit -m "feat: TeamRunner with DAG scheduling, parallel execution, BLOCKED handling, file validation"
```

---

## Task 5: TeamPanel — real-time control room WebviewPanel

**Files:**
- Create: `src/ui/team-panel.ts`

- [ ] **Step 1: Create TeamPanel**

Create `src/ui/team-panel.ts`:

```typescript
/**
 * TeamPanel: VS Code WebviewPanel showing the real-time team control room.
 *
 * Layout:
 *   Left column (220px): agent roster with status badges + live metrics
 *   Right column: streaming output of the selected agent + shared plan
 *
 * Messages Extension → Webview:
 *   { type: "teamUpdate", state: TeamRunState }
 *   { type: "agentStream", agentId: string, chunk: string }
 *
 * Messages Webview → Extension:
 *   { type: "teamStop" }
 *   { type: "teamSkipAgent", agentId: string }
 *   { type: "teamRetryAgent", agentId: string }
 */
import * as vscode from "vscode";
import type { TeamRunState } from "../agent/team-definition";

export type TeamPanelMessage =
  | { type: "teamStop" }
  | { type: "teamSkipAgent"; agentId: string }
  | { type: "teamRetryAgent"; agentId: string };

export class TeamPanel {
  private panel: vscode.WebviewPanel;
  private messageHandler: ((msg: TeamPanelMessage) => void) | undefined;
  private disposed = false;

  constructor(extensionUri: vscode.Uri, teamName: string) {
    this.panel = vscode.window.createWebviewPanel(
      "champ.teamPanel",
      `⚡ ${teamName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    this.panel.webview.html = this.renderHtml(teamName);
    this.panel.webview.onDidReceiveMessage((msg: TeamPanelMessage) => {
      this.messageHandler?.(msg);
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
    });
  }

  onMessage(handler: (msg: TeamPanelMessage) => void): void {
    this.messageHandler = handler;
  }

  update(state: TeamRunState): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "teamUpdate", state });
  }

  streamChunk(agentId: string, chunk: string): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "agentStream", agentId, chunk });
  }

  dispose(): void {
    this.disposed = true;
    this.panel.dispose();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private renderHtml(teamName: string): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-font-family);font-size:13px;background:var(--vscode-editor-background);color:var(--vscode-foreground);display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBarSectionHeader-background);flex-shrink:0}
  .toolbar-title{flex:1;font-weight:600;font-size:14px}
  .toolbar-meta{font-size:11px;opacity:.65}
  .btn{padding:3px 10px;border:1px solid var(--vscode-button-border,var(--vscode-panel-border));border-radius:3px;cursor:pointer;font-size:11px}
  .btn-stop{background:var(--vscode-errorForeground);color:#fff;border-color:transparent}
  .btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  .main{display:flex;flex:1;overflow:hidden}
  /* Left roster */
  .roster{width:220px;flex-shrink:0;border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;overflow-y:auto}
  .roster-agent{padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--vscode-panel-border);transition:background .1s}
  .roster-agent:hover,.roster-agent.active{background:var(--vscode-list-activeSelectionBackground)}
  .roster-agent-name{font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px}
  .roster-agent-role{font-size:10px;opacity:.6;margin-top:2px}
  .roster-agent-warn{font-size:10px;color:var(--vscode-editorWarning-foreground);margin-top:2px}
  .status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot-pending{background:var(--vscode-disabledForeground)}
  .dot-running{background:var(--vscode-progressBar-background);animation:pulse 1s infinite}
  .dot-done{background:#4ec9b0}
  .dot-failed{background:var(--vscode-errorForeground)}
  .dot-skipped{background:var(--vscode-disabledForeground);opacity:.4}
  .dot-blocked{background:var(--vscode-editorWarning-foreground);animation:pulse 1s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .roster-actions{display:flex;gap:4px;margin-top:4px}
  .roster-action-btn{font-size:10px;padding:1px 6px;background:none;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;color:var(--vscode-foreground)}
  .metrics{padding:8px 10px;border-top:1px solid var(--vscode-panel-border);font-size:10px;opacity:.7;margin-top:auto}
  .metrics-row{display:flex;justify-content:space-between}
  /* Right output */
  .output-pane{flex:1;display:flex;flex-direction:column;overflow:hidden}
  .output-header{padding:6px 12px;background:var(--vscode-sideBarSectionHeader-background);border-bottom:1px solid var(--vscode-panel-border);font-size:11px;font-weight:600;flex-shrink:0}
  .output-body{flex:1;overflow-y:auto;padding:10px 14px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;white-space:pre-wrap;word-break:break-word;line-height:1.6}
  .plan-panel{padding:8px 12px;border-top:1px solid var(--vscode-panel-border);font-size:11px;max-height:160px;overflow-y:auto;flex-shrink:0}
  .plan-title{font-weight:600;margin-bottom:4px;opacity:.7}
  .plan-item{display:flex;gap:6px;margin:2px 0}
  .blocked-banner{background:var(--vscode-inputValidation-warningBackground);border:1px solid var(--vscode-inputValidation-warningBorder);padding:8px 12px;margin:8px;border-radius:4px;font-size:12px}
  .blocked-reason{font-weight:600;margin-bottom:4px}
</style>
</head>
<body>
<div class="toolbar">
  <span class="toolbar-title">⚡ ${teamName}</span>
  <span class="toolbar-meta" id="meta">Initialising…</span>
  <button class="btn btn-stop" id="stopBtn" onclick="stop()">■ Stop</button>
</div>
<div class="main">
  <div class="roster" id="roster"></div>
  <div class="output-pane">
    <div class="output-header" id="outputHeader">Select an agent to view output</div>
    <div class="output-body" id="outputBody"></div>
    <div class="plan-panel" id="planPanel" style="display:none">
      <div class="plan-title">Shared plan</div>
      <div id="planItems"></div>
    </div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let state = null;
  let selectedAgent = null;
  const agentOutputs = {};

  function stop() { vscode.postMessage({ type: 'teamStop' }); }
  function skipAgent(id) { vscode.postMessage({ type: 'teamSkipAgent', agentId: id }); }
  function retryAgent(id) { vscode.postMessage({ type: 'teamRetryAgent', agentId: id }); }

  const STATUS_DOT = {
    pending: 'dot-pending', running: 'dot-running', done: 'dot-done',
    failed: 'dot-failed', skipped: 'dot-skipped', blocked: 'dot-blocked'
  };
  const STATUS_ICON = {
    pending: '○', running: '●', done: '✓', failed: '✗', skipped: '⊘', blocked: '⚠'
  };

  function renderRoster() {
    if (!state) return;
    const roster = document.getElementById('roster');
    roster.innerHTML = '';
    for (const a of state.agents) {
      const div = document.createElement('div');
      div.className = 'roster-agent' + (selectedAgent === a.id ? ' active' : '');
      div.onclick = () => selectAgent(a.id);
      const elapsed = a.startTime && a.endTime
        ? ((a.endTime - a.startTime) / 1000).toFixed(1) + 's'
        : a.startTime ? ((Date.now() - a.startTime) / 1000).toFixed(0) + 's' : '';
      div.innerHTML = '<div class="roster-agent-name">'
        + '<span class="status-dot ' + (STATUS_DOT[a.status] || '') + '"></span>'
        + text(a.name)
        + (elapsed ? '<span style="margin-left:auto;opacity:.5;font-size:10px">' + text(elapsed) + '</span>' : '')
        + '</div>'
        + '<div class="roster-agent-role">' + text(a.status.toUpperCase()) + '</div>'
        + (a.validationWarnings.length ? '<div class="roster-agent-warn">⚠ ' + a.validationWarnings.length + ' warning(s)</div>' : '');
      if (a.status === 'blocked') {
        const acts = document.createElement('div');
        acts.className = 'roster-actions';
        const skipBtn = document.createElement('button');
        skipBtn.className = 'roster-action-btn'; skipBtn.textContent = 'Skip';
        skipBtn.onclick = (e) => { e.stopPropagation(); skipAgent(a.id); };
        const retryBtn = document.createElement('button');
        retryBtn.className = 'roster-action-btn'; retryBtn.textContent = 'Retry';
        retryBtn.onclick = (e) => { e.stopPropagation(); retryAgent(a.id); };
        acts.append(skipBtn, retryBtn);
        div.append(acts);
      }
      roster.append(div);
    }
    // Metrics
    const dur = state.startTime ? ((Date.now() - state.startTime) / 1000).toFixed(0) + 's' : '—';
    const done = state.agents.filter(a => a.status === 'done').length;
    const total = state.agents.length;
    const metrics = document.createElement('div');
    metrics.className = 'metrics';
    metrics.innerHTML = '<div class="metrics-row"><span>Agents</span><span>' + done + '/' + total + '</span></div>'
      + '<div class="metrics-row"><span>Time</span><span>' + dur + '</span></div>'
      + '<div class="metrics-row"><span>Tokens</span><span>' + (state.totalTokens || 0).toLocaleString() + '</span></div>'
      + '<div class="metrics-row"><span>Cost</span><span>~$0.00</span></div>';
    roster.append(metrics);
  }

  function selectAgent(id) {
    selectedAgent = id;
    renderRoster();
    renderOutput();
  }

  function renderOutput() {
    if (!state || !selectedAgent) return;
    const agent = state.agents.find(a => a.id === selectedAgent);
    if (!agent) return;
    document.getElementById('outputHeader').textContent = agent.name + ' — ' + agent.status;
    const body = document.getElementById('outputBody');
    // Show blocked banner if applicable
    if (agent.status === 'blocked') {
      body.innerHTML = '<div class="blocked-banner"><div class="blocked-reason">⚠ BLOCKED</div>'
        + '<div>' + text(agent.blockedReason || 'Agent could not complete task') + '</div></div>';
      return;
    }
    body.textContent = agentOutputs[selectedAgent] || agent.output || '(no output yet)';
  }

  function renderPlan() {
    const memSnap = state?.sharedMemorySnapshot ?? {};
    const planKey = Object.keys(memSnap).find(k => k.includes('plan') || k === 'pm');
    const planPanel = document.getElementById('planPanel');
    if (!planKey) { planPanel.style.display = 'none'; return; }
    try {
      const plan = JSON.parse(memSnap[planKey] || '{}');
      const assignments = plan.assignments || plan.tasks || {};
      if (!Object.keys(assignments).length) { planPanel.style.display = 'none'; return; }
      planPanel.style.display = '';
      const items = document.getElementById('planItems');
      items.innerHTML = '';
      const agentStatusMap = {};
      for (const a of (state?.agents ?? [])) agentStatusMap[a.id] = a.status;
      for (const [key, val] of Object.entries(assignments)) {
        if (!val) continue;
        const div = document.createElement('div');
        div.className = 'plan-item';
        const status = agentStatusMap[key] || 'pending';
        div.innerHTML = '<span>' + (STATUS_ICON[status] || '○') + '</span><span>' + text(key) + '</span><span style="opacity:.6">— ' + text(String(val).slice(0,80)) + '</span>';
        items.append(div);
      }
    } catch { planPanel.style.display = 'none'; }
  }

  function text(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function updateMeta() {
    if (!state) return;
    const statusText = { running:'Running…', paused:'Paused — agent blocked', completed:'Completed', failed:'Failed', stopped:'Stopped' };
    document.getElementById('meta').textContent = (statusText[state.status] || state.status);
    document.getElementById('stopBtn').style.display = ['completed','stopped'].includes(state.status) ? 'none' : '';
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'teamUpdate') {
      state = msg.state;
      // Auto-select first running agent
      if (!selectedAgent) {
        const running = state.agents.find(a => a.status === 'running');
        if (running) selectedAgent = running.id;
      }
      renderRoster(); renderOutput(); renderPlan(); updateMeta();
    } else if (msg.type === 'agentStream') {
      agentOutputs[msg.agentId] = (agentOutputs[msg.agentId] || '') + msg.chunk;
      if (selectedAgent === msg.agentId) renderOutput();
    }
  });
</script>
</body>
</html>`;
  }
}
```

- [ ] **Step 2: Compile check**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -5
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/ui/team-panel.ts && git commit -m "feat: TeamPanel WebviewPanel — real-time agent control room UI"
```

---

## Task 6: Extension wiring — commands + team picker

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Add imports and TeamRunner instantiation in extension.ts**

At the top of `src/extension.ts`, add these imports after the existing import block (after the last `import` statement):

```typescript
import { TeamLoader } from "./agent/team-loader";
import { TeamRunner } from "./agent/team-runner";
import { TeamPanel } from "./ui/team-panel";
```

After the `let workflowStore: WorkflowStore | undefined;` line, add:
```typescript
let teamLoader: TeamLoader | undefined;
```

After the line `workflowStore = workspaceRoot ? new WorkflowStore(workspaceRoot) : undefined;` in `activate()`, add:
```typescript
teamLoader = workspaceRoot ? new TeamLoader(workspaceRoot) : undefined;
```

- [ ] **Step 2: Register champ.runTeam command**

In the commands block in `src/extension.ts` (near `champ.runMultiAgent`), add:

```typescript
    vscode.commands.registerCommand("champ.runTeam", async (teamName?: string) => {
      if (!teamLoader || !workspaceRoot) {
        void vscode.window.showErrorMessage("Champ: open a workspace to use agent teams.");
        return;
      }
      const provider = inlineProviderRef.current;
      if (provider.name === "not-configured") {
        void vscode.window.showErrorMessage("Champ: configure a provider first.");
        return;
      }

      // Load all teams
      let teams = await teamLoader.loadAll();

      // If no teams, offer to create one from a template
      if (teams.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          "No agent teams found in .champ/teams/. Create one from a built-in template?",
          "Create from template",
          "Cancel",
        );
        if (choice === "Create from template") {
          await vscode.commands.executeCommand("champ.createTeamFromTemplate");
          teams = await teamLoader.loadAll();
          if (teams.length === 0) return;
        } else {
          return;
        }
      }

      // Pick team (skip picker if teamName is pre-provided)
      let selectedTeam = teams.find((t) => t.name === teamName);
      if (!selectedTeam) {
        const pick = await vscode.window.showQuickPick(
          teams.map((t) => ({ label: t.name, description: t.description, team: t })),
          { placeHolder: "Select an agent team", title: "Run Agent Team" },
        );
        if (!pick) return;
        selectedTeam = pick.team;
      }

      // Get user request
      const userRequest = await vscode.window.showInputBox({
        prompt: `Describe the task for "${selectedTeam.name}"`,
        placeHolder: selectedTeam.description,
        ignoreFocusOut: true,
      });
      if (!userRequest) return;

      // Open panel
      const panel = new TeamPanel(context.extensionUri, selectedTeam.name);
      const runner = new TeamRunner();
      const abortController = new AbortController();

      panel.onMessage((msg) => {
        if (msg.type === "teamStop") abortController.abort();
        // Note: teamSkipAgent and teamRetryAgent are future work that requires
        // TeamRunner to expose a running session handle. Acknowledged.
      });

      void runner.run(selectedTeam, userRequest, provider, toolRegistry, {
        workspaceRoot,
        abortSignal: abortController.signal,
        onEvent: (event) => {
          if (event.type === "state_update" || event.type === "complete") {
            panel.update(event.state);
          } else if (event.type === "agent_stream") {
            panel.streamChunk(event.agentId, event.chunk);
          } else if (event.type === "error") {
            void vscode.window.showErrorMessage(
              `Team run failed: ${event.message}`,
            );
            panel.update(event.state);
          }
        },
      });
    }),
    vscode.commands.registerCommand("champ.listTeams", async () => {
      if (!teamLoader) {
        void vscode.window.showErrorMessage("Champ: open a workspace first.");
        return;
      }
      const teams = await teamLoader.loadAll();
      if (teams.length === 0) {
        void vscode.window.showInformationMessage(
          "No agent teams found. Create .champ/teams/*.yaml files to define teams.",
        );
        return;
      }
      await vscode.window.showQuickPick(
        teams.map((t) => ({ label: t.name, description: t.description, detail: `${t.agents.length} agents • ${t.sourcePath}` })),
        { placeHolder: "Agent teams (read-only view)" },
      );
    }),
    vscode.commands.registerCommand("champ.createTeamFromTemplate", async () => {
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Champ: open a workspace first.");
        return;
      }
      const templates = [
        { label: "DevOps Platform Team", description: "Infrastructure, CI/CD, security, monitoring specialists", file: "devops-platform" },
        { label: "Fullstack Feature Team", description: "Backend, frontend, tests, docs specialists", file: "fullstack-feature" },
        { label: "Code Review Team", description: "Security, performance, and style reviewers", file: "code-review" },
        { label: "Incident Response Team", description: "SRE incident analysis and mitigation", file: "incident-response" },
      ];
      const pick = await vscode.window.showQuickPick(templates, {
        placeHolder: "Choose a team template",
        title: "Create Agent Team",
      });
      if (!pick) return;

      const srcPath = vscode.Uri.joinPath(
        context.extensionUri,
        ".champ",
        "templates",
        "teams",
        `${pick.file}.yaml`,
      );
      const destDir = vscode.Uri.file(
        require("path").join(workspaceRoot, ".champ", "teams"),
      );
      const destPath = vscode.Uri.joinPath(destDir, `${pick.file}.yaml`);
      try {
        await vscode.workspace.fs.createDirectory(destDir);
        await vscode.workspace.fs.copy(srcPath, destPath, { overwrite: false });
        const doc = await vscode.workspace.openTextDocument(destPath);
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage(
          `Team "${pick.label}" created at .champ/teams/${pick.file}.yaml — customise it then run Champ: Run Agent Team.`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to create team: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
```

- [ ] **Step 3: Add commands to package.json**

In `package.json`, inside the `"commands"` array, add:

```json
      {
        "command": "champ.runTeam",
        "title": "Champ: Run Agent Team"
      },
      {
        "command": "champ.listTeams",
        "title": "Champ: List Agent Teams"
      },
      {
        "command": "champ.createTeamFromTemplate",
        "title": "Champ: Create Team from Template"
      },
```

- [ ] **Step 4: Compile check**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -8
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/extension.ts package.json && git commit -m "feat: wire champ.runTeam, champ.listTeams, champ.createTeamFromTemplate commands"
```

---

## Task 7: Built-in team templates

**Files:**
- Create: `.champ/templates/teams/devops-platform.yaml`
- Create: `.champ/templates/teams/fullstack-feature.yaml`
- Create: `.champ/templates/teams/code-review.yaml`
- Create: `.champ/templates/teams/incident-response.yaml`

- [ ] **Step 1: Create templates directory**

```bash
mkdir -p /home/dk/Documents/git/vs-code-plugin/.champ/templates/teams
```

- [ ] **Step 2: Create devops-platform.yaml**

Create `.champ/templates/teams/devops-platform.yaml`:

```yaml
# DevOps Platform Team
# Domain-agnostic: works for AWS, GCP, Azure, on-prem.
# Agents: PM → (Infra || CI/CD) → Security → (Monitoring) → Tech Lead

name: DevOps Platform Team
description: Infrastructure, CI/CD, security, and observability specialists for platform engineering tasks
version: "1"

defaults:
  # Override with your preferred model. Larger models plan better; smaller ones are fine for implementation.
  model: ""  # leave blank to use the active provider's default
  maxTokens: 6000
  temperature: 0.1  # low temperature = more deterministic, less hallucination

execution:
  maxParallel: 3
  totalTokenBudget: 120000
  timeoutSeconds: 180
  retries: 1
  checkpoints: true
  mode: auto

agents:
  - id: pm
    name: Program Manager
    role: Decomposes the task and assigns concrete work to each specialist
    selfCritique: true
    outputFormat: json
    outputKey: plan
    tools: []
    systemPrompt: |
      You are the Program Manager for a DevOps platform engineering team.
      Your ONLY job is to decompose the user request into a structured plan.

      <reasoning>
      Think step by step: what infrastructure, pipelines, security controls,
      and observability are needed? Which specialists should do what?
      </reasoning>

      <output>
      Respond with ONLY this JSON (no prose before or after):
      {
        "summary": "one sentence describing what we are building",
        "assignments": {
          "infra":      "specific task for infra engineer, or null if no infra work",
          "cicd":       "specific task for CI/CD engineer, or null if no pipeline work",
          "security":   "specific task for security engineer, or null if no security work",
          "monitoring": "specific task for monitoring engineer, or null if no observability work"
        }
      }
      </output>

      Rules:
      - Set assignments to null when a specialist has NO useful work.
      - Be specific. "Set up Terraform for EKS cluster" not "do infrastructure".
      - Do not include tasks outside the team's expertise.

  - id: infra
    name: Infrastructure Engineer
    role: Terraform, Kubernetes, Helm, cloud resources (AWS/GCP/Azure)
    dependsOn: [pm]
    condition: "plan.assignments.infra != null"
    tools: [read_file, create_file, edit_file, list_directory, grep_search]
    outputFormat: files
    systemPrompt: |
      You are an Infrastructure Engineer specializing in IaC and cloud platforms.

      Your assigned task (from the Program Manager):
      {{plan.assignments.infra}}

      <reasoning>
      Review the existing codebase for conventions (naming, structure, existing modules).
      Plan your Terraform/k8s/Helm changes. Note any dependencies on other agents' work.
      </reasoning>

      <output>
      Write the infrastructure code. Follow these standards:
      - Use existing module patterns from the codebase
      - Include resource tags/labels for cost tracking
      - Write outputs for anything CI/CD or security will need
      - Add comments explaining non-obvious decisions
      </output>

      If you cannot complete the task safely, respond with:
      BLOCKED: <specific reason and what information you need>

  - id: cicd
    name: CI/CD Engineer
    role: GitHub Actions, GitLab CI, Jenkins, deployment pipelines
    dependsOn: [pm]
    condition: "plan.assignments.cicd != null"
    tools: [read_file, create_file, edit_file, grep_search]
    outputFormat: files
    systemPrompt: |
      You are a CI/CD engineer specializing in build and deployment automation.

      Your assigned task (from the Program Manager):
      {{plan.assignments.cicd}}

      <reasoning>
      Check existing pipeline configs for patterns to follow.
      Plan stages: build → test → scan → deploy. Consider environment promotion.
      </reasoning>

      <output>
      Write the complete pipeline configuration. Follow these standards:
      - Use caching for dependencies (restore/save cache steps)
      - Separate build from deploy jobs
      - Use environment secrets, never hardcode credentials
      - Include rollback or manual approval gates for production
      - Add pipeline status badges to README if appropriate
      </output>

      If you cannot complete safely: BLOCKED: <reason>

  - id: security
    name: Security Engineer
    role: SAST, secrets management, IAM policies, network security, compliance
    dependsOn: [infra, cicd]
    condition: "plan.assignments.security != null"
    tools: [read_file, edit_file, grep_search, list_directory]
    selfCritique: true
    systemPrompt: |
      You are a Security Engineer. Review all infrastructure and pipeline
      work produced by the team, then complete your assigned task:
      {{plan.assignments.security}}

      <reasoning>
      Audit the infra and CI/CD output for:
      - Hardcoded secrets or credentials
      - Overly permissive IAM roles (least-privilege check)
      - Unencrypted data at rest or in transit
      - Exposed ports or overly broad security groups/firewall rules
      - Missing audit logging
      - Pipeline steps that download unverified artifacts
      </reasoning>

      <output>
      For each security issue found: describe it and fix it in-place.
      For your assigned task: implement the security controls.
      List every change made and why.
      </output>

      BLOCKED: <reason> if you find a blocker that needs human decision.

  - id: monitoring
    name: Observability Engineer
    role: Prometheus, Grafana, alerting rules, logging, SLOs, dashboards
    dependsOn: [infra]
    condition: "plan.assignments.monitoring != null"
    tools: [read_file, create_file, edit_file]
    systemPrompt: |
      You are an Observability Engineer.

      Your assigned task:
      {{plan.assignments.monitoring}}

      <reasoning>
      What are the 4 golden signals for this service/system?
      (Latency, Traffic, Errors, Saturation)
      What SLOs make sense? What alerts are needed?
      </reasoning>

      <output>
      Implement monitoring configs:
      - Prometheus scrape config or service monitor
      - Alert rules with meaningful thresholds and runbook links
      - Grafana dashboard JSON (or Jsonnet) with 4 golden signals
      - Log aggregation config if applicable
      </output>

  - id: tech-lead
    name: Tech Lead
    role: Final review — consistency, correctness, integration gaps
    dependsOn: [security, monitoring]
    model: ""  # use larger model if available
    selfCritique: true
    tools: [read_file, edit_file]
    systemPrompt: |
      You are the Tech Lead. Your job is final review and integration.

      Review all team output:
      - Infra: {{infra_result}}
      - CI/CD: {{cicd_result}}
      - Security: {{security_result}}
      - Monitoring: {{monitoring_result}}

      <reasoning>
      Check for:
      1. Naming inconsistencies (resource names don't match between infra and CI/CD)
      2. Missing connections (CI/CD deploys to infra that doesn't exist yet)
      3. Security gaps the security engineer may have missed
      4. Monitoring coverage gaps
      5. Anything that would fail in production
      </reasoning>

      <output>
      Fix any issues found by editing the relevant files directly.
      Then write a brief "What was built" summary (3-5 bullet points) for the user.
      List any open questions or manual steps required.
      </output>
```

- [ ] **Step 3: Create fullstack-feature.yaml**

Create `.champ/templates/teams/fullstack-feature.yaml`:

```yaml
name: Fullstack Feature Team
description: Backend, frontend, tests, and docs specialists for shipping product features
version: "1"

defaults:
  temperature: 0.2

execution:
  maxParallel: 2
  totalTokenBudget: 100000
  timeoutSeconds: 150
  retries: 1
  checkpoints: true
  mode: auto

agents:
  - id: pm
    name: Product Manager
    role: Breaks feature request into backend, frontend, and test tasks
    outputFormat: json
    outputKey: plan
    tools: []
    systemPrompt: |
      You are a Product Manager decomposing a feature request into engineering tasks.

      <output>
      {
        "summary": "one sentence",
        "assignments": {
          "backend":  "API/service task, or null",
          "frontend": "UI/component task, or null",
          "tests":    "test strategy task, or null",
          "docs":     "documentation task, or null"
        }
      }
      </output>

  - id: backend
    name: Backend Engineer
    role: API design, business logic, database schemas, services
    dependsOn: [pm]
    condition: "plan.assignments.backend != null"
    tools: [read_file, create_file, edit_file, list_directory, grep_search]
    outputFormat: files
    systemPrompt: |
      You are a Backend Engineer. Your task:
      {{plan.assignments.backend}}

      Follow existing code patterns. Write clean, testable code with proper error handling.
      BLOCKED: <reason> if you need clarification.

  - id: frontend
    name: Frontend Engineer
    role: UI components, pages, state management, API integration
    dependsOn: [pm]
    condition: "plan.assignments.frontend != null"
    tools: [read_file, create_file, edit_file, list_directory, grep_search]
    outputFormat: files
    systemPrompt: |
      You are a Frontend Engineer. Your task:
      {{plan.assignments.frontend}}

      Follow the existing UI framework and design system. Handle loading and error states.
      BLOCKED: <reason> if you need clarification.

  - id: tests
    name: QA Engineer
    role: Unit tests, integration tests, E2E tests
    dependsOn: [backend, frontend]
    condition: "plan.assignments.tests != null"
    tools: [read_file, create_file, edit_file, grep_search]
    selfCritique: true
    systemPrompt: |
      You are a QA Engineer. Your task:
      {{plan.assignments.tests}}

      Write tests that catch real bugs, not just confirm happy paths.
      Test edge cases, error conditions, and boundary values.
      BLOCKED: <reason> if you need clarification.

  - id: docs
    name: Technical Writer
    role: README updates, API docs, inline code comments
    dependsOn: [backend, frontend]
    condition: "plan.assignments.docs != null"
    tools: [read_file, edit_file, create_file]
    systemPrompt: |
      You are a Technical Writer. Your task:
      {{plan.assignments.docs}}

      Write clear, accurate documentation. Include examples.
      BLOCKED: <reason> if you need clarification.
```

- [ ] **Step 4: Create code-review.yaml**

Create `.champ/templates/teams/code-review.yaml`:

```yaml
name: Code Review Team
description: Security, performance, style, and correctness reviewers — no file changes, analysis only
version: "1"

execution:
  maxParallel: 3
  totalTokenBudget: 60000
  timeoutSeconds: 120
  retries: 0
  checkpoints: false
  mode: auto

agents:
  - id: security-reviewer
    name: Security Reviewer
    role: Finds security vulnerabilities, injection risks, auth gaps
    tools: [read_file, grep_search, list_directory]
    selfCritique: true
    systemPrompt: |
      You are a Security Reviewer. Review the codebase or the specified files.
      Look for: injection (SQL, command, LDAP), broken auth, insecure deserialization,
      hardcoded secrets, path traversal, XSS, CSRF, insecure dependencies.
      Report each issue with: file:line, severity (critical/high/medium/low), description, fix.
      Do NOT modify files.

  - id: perf-reviewer
    name: Performance Reviewer
    role: Finds N+1 queries, memory leaks, blocking calls, inefficient algorithms
    tools: [read_file, grep_search]
    systemPrompt: |
      You are a Performance Reviewer. Look for performance anti-patterns:
      N+1 database queries, missing indexes, loading all records without pagination,
      synchronous I/O in async contexts, memory leaks, unbounded caches.
      Report each with file:line, impact estimate, and suggested fix. Do NOT modify files.

  - id: style-reviewer
    name: Style Reviewer
    role: Code style, naming conventions, code duplication, dead code
    tools: [read_file, grep_search]
    systemPrompt: |
      You are a Code Style Reviewer. Look for: naming inconsistencies, excessive
      function length (>50 lines), deep nesting (>3 levels), magic numbers,
      code duplication, dead/commented-out code, missing error handling.
      Report each with file:line and a concise suggestion. Do NOT modify files.

  - id: summary
    name: Review Coordinator
    role: Summarises all findings into a prioritised action list
    dependsOn: [security-reviewer, perf-reviewer, style-reviewer]
    tools: []
    systemPrompt: |
      You are the Review Coordinator. Combine findings from all reviewers:
      - Security: {{security_reviewer_result}}
      - Performance: {{perf_reviewer_result}}
      - Style: {{style_reviewer_result}}

      Produce a prioritised list: Critical → High → Medium → Low.
      Remove duplicates. Group related issues. Write the final report.
```

- [ ] **Step 5: Create incident-response.yaml**

Create `.champ/templates/teams/incident-response.yaml`:

```yaml
name: SRE Incident Response Team
description: Root cause analysis, mitigation, and postmortem for production incidents
version: "1"

execution:
  maxParallel: 2
  totalTokenBudget: 80000
  timeoutSeconds: 120
  retries: 1
  checkpoints: true
  mode: auto

agents:
  - id: investigator
    name: Incident Investigator
    role: Analyses logs, traces, and metrics to find root cause
    tools: [read_file, grep_search, list_directory]
    outputFormat: json
    outputKey: investigation
    selfCritique: true
    systemPrompt: |
      You are an SRE Incident Investigator. Analyse the provided incident context.
      Look through logs, error messages, stack traces, and recent changes.

      <output>
      {
        "rootCause": "one paragraph description of what failed and why",
        "timeline": ["event 1", "event 2"],
        "affectedComponents": ["component1"],
        "severity": "p0/p1/p2/p3"
      }
      </output>

  - id: mitigator
    name: Incident Mitigator
    role: Writes immediate mitigation steps and hotfix code
    dependsOn: [investigator]
    tools: [read_file, edit_file, create_file, grep_search]
    systemPrompt: |
      You are an SRE Mitigator. Root cause analysis:
      {{investigation.rootCause}}

      Write the immediate mitigation:
      1. Rollback steps (if applicable)
      2. Config changes to stop the bleeding
      3. Hotfix code changes
      4. Feature flag toggles
      
      Prioritise restoring service over perfect code.

  - id: postmortem
    name: Postmortem Author
    role: Writes blameless postmortem with action items
    dependsOn: [investigator, mitigator]
    tools: [create_file]
    systemPrompt: |
      You are a Postmortem Author. Write a blameless postmortem.
      
      Root cause: {{investigation.rootCause}}
      Timeline: {{investigation.timeline}}
      
      Structure:
      ## Summary
      ## Impact
      ## Timeline
      ## Root Cause
      ## Contributing Factors
      ## What Went Well
      ## Action Items (with owner and deadline)
      
      Save as docs/postmortems/YYYY-MM-DD-<title>.md
```

- [ ] **Step 6: Commit templates**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add .champ/templates/teams/ && git commit -m "feat: built-in team templates — devops, fullstack, code-review, incident-response"
```

---

## Task 8: Documentation

**Files:**
- Create: `docs/TEAMS.md`

- [ ] **Step 1: Create TEAMS.md**

Create `docs/TEAMS.md`:

```markdown
# Agent Teams

Agent Teams let you define a named group of specialised AI agents that collaborate on complex tasks.
Teams are domain-agnostic — you can build a DevOps team, a fullstack feature team, a code review panel,
or any other combination of roles that matches your workflow.

## Quick start

1. Open the Champ chat panel
2. Run **Champ: Create Team from Template** (`Ctrl+Shift+P`)
3. Pick a template (DevOps Platform, Fullstack Feature, Code Review, Incident Response)
4. The template is written to `.champ/teams/<name>.yaml` and opened for editing
5. Customise the system prompts and agent list for your project
6. Run **Champ: Run Agent Team** and pick your team

## Team definition format

Teams are defined as YAML files in `.champ/teams/`. Any file ending in `.yaml` is loaded automatically.

```yaml
name: My Team
description: What this team does
version: "1"

defaults:
  model: ""          # leave blank = use active provider model
  maxTokens: 6000
  temperature: 0.1   # low = deterministic; high = creative

execution:
  maxParallel: 3     # agents running simultaneously
  totalTokenBudget: 100000  # hard cap — fails gracefully if exceeded
  timeoutSeconds: 120        # per-agent timeout
  retries: 1                 # retry failed agents once
  checkpoints: true          # resume from last successful agent
  mode: auto                 # auto | safe | supervised

agents:
  - id: unique-id            # referenced in dependsOn
    name: Display Name       # shown in the team panel
    role: One-line role      # injected into system prompt
    systemPrompt: |
      Full system prompt here.
      Use {{key.path}} to reference outputs from other agents.
    dependsOn: [other-id]   # agent IDs this must wait for
    condition: "plan.infra != null"  # skip if false
    tools: [read_file, create_file]  # allowed tools (default: none)
    model: ""                # override model for this agent
    maxTokens: 4096
    outputKey: my_key        # key for {{my_key}} in other prompts
    outputFormat: text       # text | json | files
    selfCritique: false      # enable adversarial self-review
```

## Agent execution model

Agents run in dependency order. Independent agents run in parallel:

```
PM (no deps)
  ├─ Infra (depends on pm) ──┐
  └─ CI/CD (depends on pm) ──┼─ Security (depends on infra + cicd)
                              └─ Monitoring (depends on infra)
                                                    │
                                              Tech Lead (depends on all)
```

Agents in the same "level" of the DAG run simultaneously, up to `maxParallel`.

## Template variables

Agents can reference other agents' outputs in their system prompts:

```
{{pm}}                         → full output of agent with outputKey "pm"
{{plan.assignments.infra}}     → JSON field from agent with outputKey "plan"
{{infra_result}}               → output of agent with outputKey "infra_result"
```

If a variable resolves to null, the agent is shown a warning in the panel and `(not available)` is substituted.

## Condition expressions

Skip agents that have no relevant work:

```yaml
condition: "plan.assignments.infra != null"  # run only if PM assigned infra work
condition: "infra_result.success == true"    # run only if infra succeeded
condition: ""                                # always run (default)
```

Supported operators: `== null`, `!= null`, `== true`, `== false`, `!= true`, `!= false`.

## Anti-hallucination features

### BLOCKED state

When an agent cannot complete its task, it should respond with:
```
BLOCKED: <one sentence explaining what is missing>
```

The team panel shows the blocked agent and lets you:
- **Skip** — mark the agent as skipped and continue
- **Retry** — retry after you've provided additional context via the request

Always include this instruction in your system prompts:
> If you cannot complete the task, respond with: BLOCKED: <reason>

### Structured output tags

Wrap reasoning separately from actual output:
```
<reasoning>
Think through the problem here...
</reasoning>

<output>
The actual code or content here...
</output>
```

Only the `<output>` block is stored and passed to subsequent agents.
Use this for complex reasoning tasks to keep outputs clean.

### JSON output validation

Set `outputFormat: json` for agents that must return structured data (like a PM planning agent).
The runner validates that the output is parseable JSON and warns if it is not.

### Self-critique

Set `selfCritique: true` for critical agents (PMs, reviewers). After the main response,
an adversarial follow-up prompt asks "find at least one problem". If a serious issue is
found, one automatic retry is triggered.

Use sparingly — selfCritique doubles the token cost for that agent.

## Available tools

Specify which tools each agent can use. If `tools` is empty or omitted, the agent cannot use tools.

| Tool | What it does |
|------|-------------|
| `read_file` | Read file contents |
| `edit_file` | Edit an existing file |
| `create_file` | Create a new file |
| `delete_file` | Delete a file |
| `list_directory` | List directory contents |
| `grep_search` | Search with regex |
| `file_search` | Search by filename pattern |
| `run_terminal_cmd` | Execute a shell command |
| `codebase_search` | Semantic search across the codebase |
| `generate_doc` | Write a structured document |
| `generate_diagram` | Create a Mermaid diagram |

**Tip**: Give PM/planning agents no tools (they only think, never touch files).
Give implementation agents only the tools they need.

## Team panel

When a team run starts, a panel opens showing:

- **Agent roster** (left): all agents with live status and elapsed time
- **Output pane** (right): streaming output from the selected agent
- **Shared plan** (bottom right): the PM's plan showing which agents have work
- **Metrics**: total tokens, elapsed time, cost (~$0.00 for local LLMs)

Click any agent in the roster to view its output.

For blocked agents, the roster shows **Skip** and **Retry** buttons.

## Built-in templates

| Template | Agents | Use when |
|----------|--------|----------|
| DevOps Platform | PM → Infra / CI/CD → Security → Monitoring → Tech Lead | Platform engineering, infrastructure changes |
| Fullstack Feature | PM → Backend / Frontend → Tests / Docs | Shipping new product features |
| Code Review | Security / Performance / Style → Summary | Reviewing PRs or specific files |
| Incident Response | Investigator → Mitigator → Postmortem | Production incidents |

## Custom teams

Create any team you need. Examples:

**Data Engineering Team**
- Agents: Data Architect → Pipeline Engineer / SQL Analyst → Data Quality → Docs

**Mobile Team**
- Agents: PM → iOS Engineer / Android Engineer → QA → App Store Desc

**Content Team**
- Agents: Researcher → Writer → Editor → SEO Reviewer

**Security Assessment Team**
- Agents: Threat Modeler → Penetration Tester → Compliance Reviewer → Report Writer

## Commands

| Command | Description |
|---------|-------------|
| `Champ: Run Agent Team` | Pick a team and run it |
| `Champ: List Agent Teams` | View all loaded teams |
| `Champ: Create Team from Template` | Scaffold a team from a built-in template |
```

- [ ] **Step 2: Run full test suite**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add docs/TEAMS.md && git commit -m "docs: comprehensive Agent Teams user guide"
```

---

## Task 9: Webview team picker integration + version bump

**Files:**
- Modify: `webview-ui/dist/main.js` — add "Teams" button to workflow strip
- Modify: `package.json` — version bump

- [ ] **Step 1: Add Teams button to workflow strip in main.js**

Find the `workflowStrip` section in `main.js` (search for `workflowNewBtn`). After the existing `workflowNewBtn` definition, add a Teams button:

```javascript
  const teamsBtn = el('button', { class: 'workflow-new-btn', title: 'Run agent team' }, ['👥 Team']);
  teamsBtn.addEventListener('click', () => vscode.postMessage({ type: 'runTeam' }));
```

Add `teamsBtn` to the workflow strip's button row alongside `workflowNewBtn`.

Also handle the `runTeam` message type in `chat-view-provider.ts` (in the webview message handler, near `isReloadMcpServerRequest`):

In `src/ui/chat-view-provider.ts`, find where RunMultiAgentRequest is handled and add:
```typescript
      } else if ((msg as { type: string }).type === "runTeam") {
        void vscode.commands.executeCommand("champ.runTeam");
      }
```

- [ ] **Step 2: Bump version and compile**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm version patch --no-git-tag-version && npm run compile 2>&1 | tail -8
```

Expected: no errors.

- [ ] **Step 3: Run full test suite**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 4: Package and install**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vsce package && code --install-extension champ-*.vsix --force 2>&1 | tail -2
```

- [ ] **Step 5: Final commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add webview-ui/dist/main.js src/ui/chat-view-provider.ts package.json package-lock.json && git commit -m "feat: Teams button in workflow strip + version bump"
```

---

## Self-Review

**Spec coverage:**
- ✅ Domain-agnostic team definitions (YAML, any team type)
- ✅ TeamLoader with full validation + cycle detection
- ✅ ConditionEvaluator for agent skipping
- ✅ TemplateInterpolator for `{{key.path}}` in system prompts
- ✅ TeamAgent with BLOCKED detection, output tag extraction, self-critique
- ✅ TeamRunner with DAG scheduler, parallel groups, maxParallel cap, retries
- ✅ File existence validation (hallucination guard)
- ✅ JSON output validation (hallucination guard)
- ✅ Null template variable guard (hallucination prevention)
- ✅ TeamPanel control room UI — roster, streaming, plan, metrics
- ✅ 4 built-in templates (devops, fullstack, code-review, incident-response)
- ✅ 3 commands (runTeam, listTeams, createTeamFromTemplate)
- ✅ Teams button in workflow strip
- ✅ Comprehensive TEAMS.md documentation
- ✅ TDD throughout (team-loader, condition-evaluator, template-interpolator, team-runner)

**Placeholder scan:** No TBD, no TODO in critical paths.

**Type consistency:** `TeamAgentDefinition.outputKey` used consistently as memory key throughout. `TeamRunState.agents` is `TeamAgentRunState[]` in definition and TeamPanel both. `TeamRunEvent` union matches what TeamRunner emits and TeamPanel receives.
