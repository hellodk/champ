# Sprint P: Visual Team Builder & Rules Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visual drag-and-drop team builder, a rules editor panel, and a static DAG preview mode to Champ's team authoring workflow.

**Architecture:** TeamBuilderPanel is a new VS Code WebviewPanel (registered as `champ.openTeamBuilder`) hosting a Preact component. The canvas uses absolute-positioned div nodes with SVG overlay for edges — no external graph library. Nodes represent `TeamAgentDefinition`s; edges represent `dependsOn` relationships. On save, the panel serializes to YAML and writes to `.champ/teams/<name>.yaml`. RulesEditorPanel is similar, listing `.champ/rules/*.md` files and allowing inline edit of rule content and type. A new "Design" tab on `AgentGraphPanel` shows the DAG statically from a loaded `TeamDefinition` JSON without running any agent. A template gallery is embedded in `TeamBuilderPanel` so users can scaffold from a known team definition in one click.

**Tech Stack:** Preact TSX (webview), TypeScript (extension), js-yaml (already bundled), CSS absolute-positioning + SVG (node canvas), Vitest (tests)

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `src/ui/messages.ts` | Add 8 new message types for builder + rules protocols |
| Create | `src/ui/team-builder-panel.ts` | VS Code WebviewPanel that hosts the team builder; reads/writes `.champ/teams/*.yaml` |
| Create | `src/ui/rules-editor-panel.ts` | VS Code WebviewPanel that hosts the rules editor; reads/writes `.champ/rules/*.md` |
| Modify | `src/extension.ts` | Register `champ.openTeamBuilder` and `champ.openRulesEditor` commands; add to `package.json` contributions |
| Modify | `package.json` | Add two command entries under `contributes.commands` |
| Create | `webview-ui/src/components/TeamBuilderPanel.tsx` | Preact component: node canvas, sidebar form, template gallery, save |
| Create | `webview-ui/src/components/RulesEditorPanel.tsx` | Preact component: rules list, add/edit/delete form |
| Modify | `webview-ui/src/components/AgentGraphPanel.tsx` | Add "Design" tab that accepts a `TeamDefinition` JSON and renders the DAG statically |
| Modify | `webview-ui/src/index.tsx` | Mount `TeamBuilderPanel` and `RulesEditorPanel` alongside existing panels |
| Create | `src/ui/__tests__/team-builder-panel.test.ts` | Unit tests for `TeamBuilderPanel` (extension-side serialisation, file writes) |

---

## Edge Cases & Design Decisions

### Node canvas — no external graph library
Nodes are `<div>` elements with `position:absolute; left:{x}px; top:{y}px`. A single `<svg>` sits behind them with `position:absolute; inset:0` and `pointer-events:none`. Edges are cubic bezier `<path>` elements drawn in SVG coordinates. This reuses the same `computeLayout` + `EdgeLine` logic already in `AgentGraphPanel.tsx` (converted from SVG `<g>` to HTML `<div>` nodes).

### Drag-to-move
Pointer events (`onPointerDown`, `onPointerMove`, `onPointerUp`) on each node div update a `Map<id, {x,y}>` signal. Edge SVG re-renders automatically because it reads from the same signal.

### Drag-to-connect (dependsOn)
Shift+drag from a node starts an "edge draw" mode. On pointer-up over a different node, that node's `dependsOn` gains the source id. Cycle detection runs immediately (using Kahn's algorithm from `TeamLoader`); if a cycle would form, the edge is rejected with an inline red flash message.

### Save to YAML
The extension-side handler receives a `TeamBuilderSaveRequest` message containing the full `TeamDefinition` JSON. It uses `js-yaml.dump()` to produce YAML and writes to `.champ/teams/<name>.yaml` via `fs.writeFile`. If the file already exists, the user is asked to confirm overwrite via `vscode.window.showWarningMessage`.

### Rules frontmatter
Each rule is written back as a `.md` file with YAML frontmatter:
```
---
name: rule-name
type: always
glob: "**/*.ts"
---
Rule content here.
```
The `glob` line is omitted when `type !== "auto-attached"`.

### AgentGraphPanel "Design" tab
The existing panel currently renders only during a live `TeamRunState`. The new "Design" tab adds a second rendering path that accepts a `TeamDefinition` JSON (with all agents shown as `"pending"` status). The toggle between "Live" and "Design" is a tab bar at the top of the floating panel. Live tab is hidden when there is no active run.

### Template gallery
Five built-in templates are defined as a constant array in `TeamBuilderPanel.tsx`. When a template is clicked, `agents` and `defaults` signals are initialised from the template. The user can then drag, connect, and edit before saving.

---

## Task 1: Add message types to `src/ui/messages.ts`

**Files:**
- Modify: `src/ui/messages.ts`

These eight new types cover the full builder + rules protocol. They slot into the existing discriminated-union pattern used throughout the file.

- [ ] **Step 1: Add types to `src/ui/messages.ts`**

Open `src/ui/messages.ts`. After the `TeamRunSnapshotMessage` interface (around line 255) add the following block. Then add all new types to both `ExtensionToWebviewMessage` and `WebviewToExtensionMessage` unions, and add type-guards alongside the existing ones.

```typescript
// ---------------------------------------------------------------------------
// Team Builder — Extension Host -> Webview
// ---------------------------------------------------------------------------

/** Sent when champ.openTeamBuilder opens; passes the definition to display. */
export interface TeamBuilderLoadMessage {
  type: "teamBuilderLoad";
  /** Serialized TeamDefinition JSON, or null when opening a blank canvas. */
  team: import("../agent/team-definition").TeamDefinition | null;
  /** All available team names already on disk (for overwrite detection). */
  existingNames: string[];
}

/** Sent after a successful save to notify the webview. */
export interface TeamBuilderSaveAckMessage {
  type: "teamBuilderSaveAck";
  savedPath: string;
}

/** Sent when champ.openRulesEditor opens. */
export interface RulesListMessage {
  type: "rulesList";
  rules: Array<{
    name: string;
    content: string;
    type: "always" | "auto-attached" | "agent-requested";
    glob?: string;
  }>;
}

/** Sent after a successful rule save or delete. */
export interface RulesListAckMessage {
  type: "rulesListAck";
  rules: Array<{
    name: string;
    content: string;
    type: "always" | "auto-attached" | "agent-requested";
    glob?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Team Builder — Webview -> Extension Host
// ---------------------------------------------------------------------------

/** The user clicked Save in the team builder. */
export interface TeamBuilderSaveRequest {
  type: "teamBuilderSave";
  team: {
    name: string;
    description: string;
    version: string;
    agents: Array<{
      id: string;
      name: string;
      role: string;
      systemPrompt: string;
      dependsOn: string[];
      condition: string;
      tools: string[];
      model: string;
      maxTokens: number;
      outputKey: string;
      outputFormat: "text" | "json" | "files";
      selfCritique: boolean;
      subscribes: string[];
    }>;
    defaults: { model?: string; maxTokens?: number; temperature?: number };
    execution: {
      maxParallel: number;
      totalTokenBudget: number;
      timeoutSeconds: number;
      retries: number;
      checkpoints: boolean;
      mode: "auto" | "safe" | "supervised";
    };
  };
}

/** The user clicked "Add Rule" or "Save Rule" in the rules editor. */
export interface RuleAddRequest {
  type: "ruleAdd";
  rule: {
    name: string;
    content: string;
    type: "always" | "auto-attached" | "agent-requested";
    glob?: string;
  };
}

/** The user clicked "Delete" on a rule. */
export interface RuleDeleteRequest {
  type: "ruleDelete";
  name: string;
}
```

- [ ] **Step 2: Add new types to the union and add type-guards**

In the `ExtensionToWebviewMessage` union (after `TeamRunSnapshotMessage`), add:
```typescript
  | TeamBuilderLoadMessage
  | TeamBuilderSaveAckMessage
  | RulesListMessage
  | RulesListAckMessage
```

In the `WebviewToExtensionMessage` union (after `FocusTeamAgentRequest`), add:
```typescript
  | TeamBuilderSaveRequest
  | RuleAddRequest
  | RuleDeleteRequest
```

After the existing type guards at the bottom of the file, add:

```typescript
export function isTeamBuilderSaveRequest(
  msg: WebviewToExtensionMessage,
): msg is TeamBuilderSaveRequest {
  return msg.type === "teamBuilderSave";
}

export function isRuleAddRequest(
  msg: WebviewToExtensionMessage,
): msg is RuleAddRequest {
  return msg.type === "ruleAdd";
}

export function isRuleDeleteRequest(
  msg: WebviewToExtensionMessage,
): msg is RuleDeleteRequest {
  return msg.type === "ruleDelete";
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors related to the new types. (Existing pre-existing errors, if any, are not regressions from this task.)

- [ ] **Step 4: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/ui/messages.ts
git commit -m "feat(sprint-p): add TeamBuilder and RulesEditor message types"
```

---

## Task 2: Create `src/ui/team-builder-panel.ts` — extension-side WebviewPanel

**Files:**
- Create: `src/ui/team-builder-panel.ts`
- Test: `src/ui/__tests__/team-builder-panel.test.ts`

This panel is responsible for:
1. Generating the webview HTML (same pattern as `TeamPanel`)
2. Sending `teamBuilderLoad` on open
3. Handling `teamBuilderSave` → serialize to YAML → write file
4. Handling `teamBuilderSaveAck` back to webview

- [ ] **Step 1: Write the failing test**

Create `src/ui/__tests__/team-builder-panel.test.ts`:

```typescript
// src/ui/__tests__/team-builder-panel.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTeamYaml, parseAgentPositions } from "../team-builder-panel";
import type { TeamBuilderSaveRequest } from "../messages";

describe("buildTeamYaml", () => {
  it("serializes a minimal team to valid YAML", () => {
    const req: TeamBuilderSaveRequest["team"] = {
      name: "Test Team",
      description: "A test team",
      version: "1",
      agents: [
        {
          id: "planner",
          name: "Planner",
          role: "Plans the work",
          systemPrompt: "You are a planner.",
          dependsOn: [],
          condition: "",
          tools: [],
          model: "",
          maxTokens: 4096,
          outputKey: "planner",
          outputFormat: "text",
          selfCritique: false,
          subscribes: [],
        },
      ],
      defaults: {},
      execution: {
        maxParallel: 3,
        totalTokenBudget: 100000,
        timeoutSeconds: 120,
        retries: 1,
        checkpoints: true,
        mode: "auto",
      },
    };

    const yaml = buildTeamYaml(req);
    expect(yaml).toContain("name: Test Team");
    expect(yaml).toContain("description: A test team");
    expect(yaml).toContain("id: planner");
    expect(yaml).toContain("role: Plans the work");
  });

  it("omits empty optional fields (condition, tools, model)", () => {
    const req: TeamBuilderSaveRequest["team"] = {
      name: "Lean Team",
      description: "desc",
      version: "1",
      agents: [
        {
          id: "a1",
          name: "Agent One",
          role: "Does stuff",
          systemPrompt: "prompt",
          dependsOn: [],
          condition: "",
          tools: [],
          model: "",
          maxTokens: 4096,
          outputKey: "a1",
          outputFormat: "text",
          selfCritique: false,
          subscribes: [],
        },
      ],
      defaults: {},
      execution: {
        maxParallel: 3,
        totalTokenBudget: 100000,
        timeoutSeconds: 120,
        retries: 1,
        checkpoints: true,
        mode: "auto",
      },
    };

    const yaml = buildTeamYaml(req);
    expect(yaml).not.toContain("condition:");
    expect(yaml).not.toContain("tools:");
    expect(yaml).not.toContain("model:");
  });

  it("serializes dependsOn as a YAML sequence", () => {
    const req: TeamBuilderSaveRequest["team"] = {
      name: "Dep Team",
      description: "desc",
      version: "1",
      agents: [
        {
          id: "a",
          name: "A",
          role: "First",
          systemPrompt: "p",
          dependsOn: [],
          condition: "",
          tools: [],
          model: "",
          maxTokens: 4096,
          outputKey: "a",
          outputFormat: "text",
          selfCritique: false,
          subscribes: [],
        },
        {
          id: "b",
          name: "B",
          role: "Second",
          systemPrompt: "p",
          dependsOn: ["a"],
          condition: "",
          tools: [],
          model: "",
          maxTokens: 4096,
          outputKey: "b",
          outputFormat: "text",
          selfCritique: false,
          subscribes: [],
        },
      ],
      defaults: {},
      execution: {
        maxParallel: 3,
        totalTokenBudget: 100000,
        timeoutSeconds: 120,
        retries: 1,
        checkpoints: true,
        mode: "auto",
      },
    };

    const yaml = buildTeamYaml(req);
    expect(yaml).toContain("dependsOn:");
    expect(yaml).toContain("- a");
  });
});

describe("parseAgentPositions", () => {
  it("returns empty map for empty agents", () => {
    const result = parseAgentPositions([]);
    expect(result.size).toBe(0);
  });

  it("assigns a position to each agent", () => {
    const agents = [
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
    ];
    const result = parseAgentPositions(agents);
    expect(result.has("a")).toBe(true);
    expect(result.has("b")).toBe(true);
    const posA = result.get("a")!;
    const posB = result.get("b")!;
    // b should be below a (higher y) because it depends on a
    expect(posB.y).toBeGreaterThan(posA.y);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/team-builder-panel.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../team-builder-panel'`

- [ ] **Step 3: Create `src/ui/team-builder-panel.ts`**

```typescript
// src/ui/team-builder-panel.ts
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as yaml from "js-yaml";
import { TeamLoader } from "../agent/team-loader";
import type { TeamDefinition } from "../agent/team-definition";
import type {
  TeamBuilderSaveRequest,
  TeamBuilderLoadMessage,
  TeamBuilderSaveAckMessage,
} from "./messages";
import {
  isTeamBuilderSaveRequest,
} from "./messages";

// ---------------------------------------------------------------------------
// Exported helpers (also used by tests)
// ---------------------------------------------------------------------------

/** Layout constants matching AgentGraphPanel.tsx */
const NODE_WIDTH = 160;
const NODE_HEIGHT = 48;
const H_GAP = 40;
const V_GAP = 60;
const PADDING = 20;

/**
 * Assigns x/y positions to each agent using a layered DAG layout
 * (identical algorithm to AgentGraphPanel.computeLayout, duplicated here
 * so it can be tested without a DOM).
 */
export function parseAgentPositions(
  agents: Array<{ id: string; dependsOn: string[] }>,
): Map<string, { x: number; y: number }> {
  if (agents.length === 0) return new Map();

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const idSet = new Set(agents.map((a) => a.id));

  for (const a of agents) {
    inDegree.set(a.id, 0);
    adj.set(a.id, []);
  }
  for (const a of agents) {
    for (const dep of a.dependsOn) {
      if (idSet.has(dep)) {
        adj.get(dep)!.push(a.id);
        inDegree.set(a.id, (inDegree.get(a.id) ?? 0) + 1);
      }
    }
  }

  const layers: string[][] = [];
  let frontier = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id);

  while (frontier.length > 0) {
    layers.push(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighborId of adj.get(id) ?? []) {
        const newDeg = (inDegree.get(neighborId) ?? 0) - 1;
        inDegree.set(neighborId, newDeg);
        if (newDeg === 0) next.push(neighborId);
      }
    }
    frontier = next;
  }

  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, layerIdx) => {
    const y = PADDING + layerIdx * (NODE_HEIGHT + V_GAP) + NODE_HEIGHT / 2;
    layer.forEach((id, colIdx) => {
      const x = PADDING + colIdx * (NODE_WIDTH + H_GAP) + NODE_WIDTH / 2;
      positions.set(id, { x, y });
    });
  });

  return positions;
}

/**
 * Serializes a team definition (from TeamBuilderSaveRequest) to YAML,
 * omitting empty optional fields so the output stays clean.
 */
export function buildTeamYaml(team: TeamBuilderSaveRequest["team"]): string {
  const doc: Record<string, unknown> = {
    name: team.name,
    description: team.description,
    version: team.version,
    agents: team.agents.map((a) => {
      const node: Record<string, unknown> = {
        id: a.id,
        name: a.name,
        role: a.role,
        systemPrompt: a.systemPrompt,
      };
      if (a.dependsOn.length > 0) node.dependsOn = a.dependsOn;
      if (a.condition) node.condition = a.condition;
      if (a.tools.length > 0) node.tools = a.tools;
      if (a.model) node.model = a.model;
      if (a.maxTokens !== 4096) node.maxTokens = a.maxTokens;
      if (a.outputKey !== a.id) node.outputKey = a.outputKey;
      if (a.outputFormat !== "text") node.outputFormat = a.outputFormat;
      if (a.selfCritique) node.selfCritique = true;
      if (a.subscribes.length > 0) node.subscribes = a.subscribes;
      return node;
    }),
  };

  // Only emit defaults/execution fields that differ from the TeamLoader defaults
  const defaults: Record<string, unknown> = {};
  if (team.defaults.model) defaults.model = team.defaults.model;
  if (team.defaults.maxTokens) defaults.maxTokens = team.defaults.maxTokens;
  if (team.defaults.temperature !== undefined)
    defaults.temperature = team.defaults.temperature;
  if (Object.keys(defaults).length > 0) doc.defaults = defaults;

  const exec: Record<string, unknown> = {};
  if (team.execution.maxParallel !== 3) exec.maxParallel = team.execution.maxParallel;
  if (team.execution.totalTokenBudget !== 100000)
    exec.totalTokenBudget = team.execution.totalTokenBudget;
  if (team.execution.timeoutSeconds !== 120)
    exec.timeoutSeconds = team.execution.timeoutSeconds;
  if (team.execution.retries !== 1) exec.retries = team.execution.retries;
  if (!team.execution.checkpoints) exec.checkpoints = false;
  if (team.execution.mode !== "auto") exec.mode = team.execution.mode;
  if (Object.keys(exec).length > 0) doc.execution = exec;

  return yaml.dump(doc, { lineWidth: 120, quotingType: '"', forceQuotes: false });
}

// ---------------------------------------------------------------------------
// VS Code WebviewPanel
// ---------------------------------------------------------------------------

export class TeamBuilderPanel {
  private panel: vscode.WebviewPanel;
  private _disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceRoot: string,
    teamToEdit?: TeamDefinition,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "champ.teamBuilder",
      "Champ: Team Builder",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => {
      this._disposed = true;
    });

    this.panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      await this.handleMessage(msg);
    });

    // Send the initial load message once the webview is ready
    void this.sendLoadMessage(teamToEdit ?? null);
  }

  private async sendLoadMessage(team: TeamDefinition | null): Promise<void> {
    const loader = new TeamLoader(this.workspaceRoot);
    const all = await loader.loadAll();
    const existingNames = all.map((t) => t.name);

    const msg: TeamBuilderLoadMessage = {
      type: "teamBuilderLoad",
      team,
      existingNames,
    };
    void this.panel.webview.postMessage(msg);
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type: string };

    if (isTeamBuilderSaveRequest(m as ReturnType<typeof Object.assign>)) {
      await this.handleSave((m as TeamBuilderSaveRequest));
    }
  }

  private async handleSave(req: TeamBuilderSaveRequest): Promise<void> {
    const teamsDir = path.join(this.workspaceRoot, ".champ", "teams");
    await fs.mkdir(teamsDir, { recursive: true });

    const safeName = req.team.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const filePath = path.join(teamsDir, `${safeName}.yaml`);

    // Check for overwrite
    let exists = false;
    try {
      await fs.access(filePath);
      exists = true;
    } catch {
      /* file does not exist — fine */
    }

    if (exists) {
      const choice = await vscode.window.showWarningMessage(
        `"${safeName}.yaml" already exists. Overwrite?`,
        { modal: true },
        "Overwrite",
      );
      if (choice !== "Overwrite") return;
    }

    const yamlContent = buildTeamYaml(req.team);
    await fs.writeFile(filePath, yamlContent, "utf-8");

    const ack: TeamBuilderSaveAckMessage = {
      type: "teamBuilderSaveAck",
      savedPath: filePath,
    };
    void this.panel.webview.postMessage(ack);
    void vscode.window.showInformationMessage(
      `Team saved to ${path.relative(this.workspaceRoot, filePath)}`,
    );
  }

  dispose(): void {
    this._disposed = true;
    this.panel.dispose();
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  private renderHtml(): string {
    const nonce =
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);
    const cspSource = this.panel.webview.cspSource ?? "vscode-resource:";
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist", "components.js"),
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src 'unsafe-inline'; img-src ${cspSource} data:;">
<style>
html,body{margin:0;padding:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px}
#champ-teambuilder{height:100%}
</style>
</head>
<body>
<div id="champ-teambuilder"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.vscode = vscode;
  if (window.ChampPanels && window.ChampPanels.mountTeamBuilder) {
    window.ChampPanels.mountTeamBuilder(document.getElementById('champ-teambuilder'));
  }
</script>
</body>
</html>`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/team-builder-panel.test.ts 2>&1 | tail -20
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/ui/team-builder-panel.ts src/ui/__tests__/team-builder-panel.test.ts
git commit -m "feat(sprint-p): TeamBuilderPanel extension-side host + YAML serializer"
```

---

## Task 3: Create `src/ui/rules-editor-panel.ts` — extension-side rules panel

**Files:**
- Create: `src/ui/rules-editor-panel.ts`

Pattern mirrors `TeamBuilderPanel`. Reads `.champ/rules/*.md`, parses frontmatter, sends `rulesList`. Handles `ruleAdd` (write new `.md` file with frontmatter) and `ruleDelete` (delete file).

- [ ] **Step 1: Write the failing test**

Append to `src/ui/__tests__/team-builder-panel.test.ts` (same test file, different describe block — no need for a new file):

```typescript
import { buildRuleMarkdown } from "../rules-editor-panel";

describe("buildRuleMarkdown", () => {
  it("writes always rule without glob", () => {
    const md = buildRuleMarkdown({
      name: "no-console",
      content: "Never use console.log in production code.",
      type: "always",
    });
    expect(md).toContain("name: no-console");
    expect(md).toContain("type: always");
    expect(md).not.toContain("glob:");
    expect(md).toContain("Never use console.log in production code.");
  });

  it("writes auto-attached rule with glob", () => {
    const md = buildRuleMarkdown({
      name: "ts-style",
      content: "Prefer const over let.",
      type: "auto-attached",
      glob: "**/*.ts",
    });
    expect(md).toContain('glob: "**/*.ts"');
    expect(md).toContain("type: auto-attached");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/team-builder-panel.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../rules-editor-panel'`

- [ ] **Step 3: Create `src/ui/rules-editor-panel.ts`**

```typescript
// src/ui/rules-editor-panel.ts
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { RulesEngine } from "../rules/rules-engine";
import type {
  RulesListMessage,
  RulesListAckMessage,
  RuleAddRequest,
  RuleDeleteRequest,
} from "./messages";
import { isRuleAddRequest, isRuleDeleteRequest } from "./messages";

// ---------------------------------------------------------------------------
// Exported helper (also used by tests)
// ---------------------------------------------------------------------------

export function buildRuleMarkdown(rule: {
  name: string;
  content: string;
  type: "always" | "auto-attached" | "agent-requested";
  glob?: string;
}): string {
  let frontmatter = `---\nname: ${rule.name}\ntype: ${rule.type}`;
  if (rule.type === "auto-attached" && rule.glob) {
    frontmatter += `\nglob: "${rule.glob}"`;
  }
  frontmatter += "\n---\n";
  return frontmatter + rule.content;
}

// ---------------------------------------------------------------------------
// VS Code WebviewPanel
// ---------------------------------------------------------------------------

export class RulesEditorPanel {
  private panel: vscode.WebviewPanel;
  private _disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceRoot: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "champ.rulesEditor",
      "Champ: Rules Editor",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => {
      this._disposed = true;
    });

    this.panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      await this.handleMessage(msg);
    });

    void this.sendRulesList();
  }

  private rulesDir(): string {
    return path.join(this.workspaceRoot, ".champ", "rules");
  }

  private async sendRulesList(): Promise<void> {
    const engine = new RulesEngine(this.workspaceRoot);
    const loaded = await engine.loadRulesFromDirectory(this.rulesDir());
    const msg: RulesListMessage = {
      type: "rulesList",
      rules: loaded.map((r) => ({
        name: r.name,
        content: r.content,
        type: r.type,
        glob: r.glob,
      })),
    };
    void this.panel.webview.postMessage(msg);
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type: string };

    if (isRuleAddRequest(m as ReturnType<typeof Object.assign>)) {
      await this.handleAdd(m as RuleAddRequest);
    } else if (isRuleDeleteRequest(m as ReturnType<typeof Object.assign>)) {
      await this.handleDelete(m as RuleDeleteRequest);
    }
  }

  private async handleAdd(req: RuleAddRequest): Promise<void> {
    const dir = this.rulesDir();
    await fs.mkdir(dir, { recursive: true });

    const safeName = req.rule.name
      .replace(/[^a-z0-9_-]/gi, "_")
      .toLowerCase();
    const filePath = path.join(dir, `${safeName}.md`);

    let exists = false;
    try {
      await fs.access(filePath);
      exists = true;
    } catch { /* not found */ }

    if (exists) {
      const choice = await vscode.window.showWarningMessage(
        `Rule "${safeName}" already exists. Overwrite?`,
        { modal: true },
        "Overwrite",
      );
      if (choice !== "Overwrite") return;
    }

    const content = buildRuleMarkdown(req.rule);
    await fs.writeFile(filePath, content, "utf-8");
    void vscode.window.showInformationMessage(
      `Rule saved: .champ/rules/${safeName}.md`,
    );
    await this.broadcastRulesList();
  }

  private async handleDelete(req: RuleDeleteRequest): Promise<void> {
    const dir = this.rulesDir();
    const safeName = req.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const filePath = path.join(dir, `${safeName}.md`);

    const choice = await vscode.window.showWarningMessage(
      `Delete rule "${req.name}"? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") return;

    try {
      await fs.unlink(filePath);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to delete rule: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    void vscode.window.showInformationMessage(`Rule "${req.name}" deleted.`);
    await this.broadcastRulesList();
  }

  private async broadcastRulesList(): Promise<void> {
    const engine = new RulesEngine(this.workspaceRoot);
    const loaded = await engine.loadRulesFromDirectory(this.rulesDir());
    const ack: RulesListAckMessage = {
      type: "rulesListAck",
      rules: loaded.map((r) => ({
        name: r.name,
        content: r.content,
        type: r.type,
        glob: r.glob,
      })),
    };
    void this.panel.webview.postMessage(ack);
  }

  dispose(): void {
    this._disposed = true;
    this.panel.dispose();
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  private renderHtml(): string {
    const nonce =
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);
    const cspSource = this.panel.webview.cspSource ?? "vscode-resource:";
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "webview-ui",
        "dist",
        "components.js",
      ),
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src 'unsafe-inline'; img-src ${cspSource} data:;">
<style>
html,body{margin:0;padding:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px}
#champ-ruleseditor{height:100%}
</style>
</head>
<body>
<div id="champ-ruleseditor"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.vscode = vscode;
  if (window.ChampPanels && window.ChampPanels.mountRulesEditor) {
    window.ChampPanels.mountRulesEditor(document.getElementById('champ-ruleseditor'));
  }
</script>
</body>
</html>`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/team-builder-panel.test.ts 2>&1 | tail -20
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/ui/rules-editor-panel.ts src/ui/__tests__/team-builder-panel.test.ts
git commit -m "feat(sprint-p): RulesEditorPanel extension-side host + markdown serializer"
```

---

## Task 4: Register commands in `src/extension.ts` and `package.json`

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Add imports near the top of extension.ts**

In `src/extension.ts`, add two import lines after the `TeamPanel` import (around line 77):

```typescript
import { TeamBuilderPanel } from "./ui/team-builder-panel";
import { RulesEditorPanel } from "./ui/rules-editor-panel";
```

- [ ] **Step 2: Register commands in extension.ts**

Find the block where `champ.runTeam` is registered (around line 1946). After the closing `)` of the `champ.listTeamRuns` command registration, add:

```typescript
    vscode.commands.registerCommand(
      "champ.openTeamBuilder",
      async (teamName?: string) => {
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage(
            "Champ: open a workspace to use the team builder.",
          );
          return;
        }
        let teamToEdit: import("./agent/team-definition").TeamDefinition | undefined;
        if (teamName && teamLoader) {
          const all = await teamLoader.loadAll();
          teamToEdit = all.find((t) => t.name === teamName);
        }
        new TeamBuilderPanel(context.extensionUri, workspaceRoot, teamToEdit);
      },
    ),

    vscode.commands.registerCommand(
      "champ.openRulesEditor",
      () => {
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage(
            "Champ: open a workspace to use the rules editor.",
          );
          return;
        }
        new RulesEditorPanel(context.extensionUri, workspaceRoot);
      },
    ),
```

Both `registerCommand` calls must be wrapped in `context.subscriptions.push(...)` along with the surrounding commands. Find the nearest `context.subscriptions.push(` that groups similar team commands and add the two new registrations inside that same push call.

- [ ] **Step 3: Add commands to package.json**

In `package.json`, find the block with `"command": "champ.listTeams"` (around line 156). After the closing `}` of that entry, add:

```json
      {
        "command": "champ.openTeamBuilder",
        "title": "Champ: Open Team Builder"
      },
      {
        "command": "champ.openRulesEditor",
        "title": "Champ: Open Rules Editor"
      },
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/extension.ts package.json
git commit -m "feat(sprint-p): register champ.openTeamBuilder and champ.openRulesEditor commands"
```

---

## Task 5: Create `webview-ui/src/components/TeamBuilderPanel.tsx` — node canvas + sidebar

**Files:**
- Create: `webview-ui/src/components/TeamBuilderPanel.tsx`

This is the main visual editor. It renders:
- A **canvas area** (scrollable div with absolute-positioned nodes + SVG edge overlay)
- A **sidebar** with a form to edit the selected node or team-level fields
- A **toolbar** with Save, Add Agent, and Template Gallery buttons

- [ ] **Step 1: Create the component**

Create `webview-ui/src/components/TeamBuilderPanel.tsx`:

```tsx
// webview-ui/src/components/TeamBuilderPanel.tsx
import { signal, computed } from "@preact/signals";
import { useRef, useEffect } from "preact/hooks";
import type { TeamBuilderLoadMessage, TeamBuilderSaveAckMessage } from "../../../src/ui/messages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentNode {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  dependsOn: string[];
  condition: string;
  tools: string[];
  model: string;
  maxTokens: number;
  outputKey: string;
  outputFormat: "text" | "json" | "files";
  selfCritique: boolean;
  subscribes: string[];
}

interface NodePos {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_W = 160;
const NODE_H = 48;
const H_GAP = 40;
const V_GAP = 60;
const PAD = 20;

const BUILT_IN_TEMPLATES: Array<{
  label: string;
  description: string;
  agents: AgentNode[];
}> = [
  {
    label: "Plan → Code → Review",
    description: "Three-agent pipeline: planner, coder, reviewer",
    agents: [
      { id: "planner", name: "Planner", role: "Decomposes the task into a step-by-step plan", systemPrompt: "You are a senior engineer. Produce a numbered implementation plan only. No code.", dependsOn: [], condition: "", tools: [], model: "", maxTokens: 4096, outputKey: "planner", outputFormat: "text", selfCritique: false, subscribes: [] },
      { id: "coder", name: "Coder", role: "Implements the plan", systemPrompt: "You are an expert programmer. Follow the plan in {{planner}} exactly. Write production-quality code.", dependsOn: ["planner"], condition: "", tools: ["edit_file", "create_file", "read_file"], model: "", maxTokens: 8192, outputKey: "coder", outputFormat: "files", selfCritique: false, subscribes: [] },
      { id: "reviewer", name: "Reviewer", role: "Reviews the implementation for correctness and style", systemPrompt: "You are a meticulous code reviewer. Review the files changed by {{coder}} and list any issues.", dependsOn: ["coder"], condition: "", tools: ["read_file", "grep_search"], model: "", maxTokens: 4096, outputKey: "reviewer", outputFormat: "text", selfCritique: true, subscribes: [] },
    ],
  },
  {
    label: "Research → Draft → Edit",
    description: "Writing pipeline: researcher, drafter, editor",
    agents: [
      { id: "researcher", name: "Researcher", role: "Gathers context and facts", systemPrompt: "You are a research assistant. Gather all relevant information for the user request.", dependsOn: [], condition: "", tools: ["grep_search", "codebase_search", "read_file"], model: "", maxTokens: 4096, outputKey: "researcher", outputFormat: "text", selfCritique: false, subscribes: [] },
      { id: "drafter", name: "Drafter", role: "Writes the first draft", systemPrompt: "Using the research in {{researcher}}, write a complete first draft.", dependsOn: ["researcher"], condition: "", tools: [], model: "", maxTokens: 8192, outputKey: "drafter", outputFormat: "text", selfCritique: false, subscribes: [] },
      { id: "editor", name: "Editor", role: "Polishes and fact-checks the draft", systemPrompt: "Edit {{drafter}} for clarity, concision, and accuracy.", dependsOn: ["drafter"], condition: "", tools: [], model: "", maxTokens: 4096, outputKey: "editor", outputFormat: "text", selfCritique: true, subscribes: [] },
    ],
  },
  {
    label: "Audit → Fix → Verify",
    description: "Quality pipeline: auditor, fixer, verifier",
    agents: [
      { id: "auditor", name: "Auditor", role: "Finds all issues in the codebase", systemPrompt: "You are a code auditor. Find every bug, security issue, and code smell. Output a JSON array of issues.", dependsOn: [], condition: "", tools: ["grep_search", "read_file", "codebase_search"], model: "", maxTokens: 4096, outputKey: "auditor", outputFormat: "json", selfCritique: false, subscribes: [] },
      { id: "fixer", name: "Fixer", role: "Fixes all issues found by the auditor", systemPrompt: "Fix every issue listed in {{auditor}}.", dependsOn: ["auditor"], condition: "", tools: ["edit_file", "read_file"], model: "", maxTokens: 8192, outputKey: "fixer", outputFormat: "files", selfCritique: false, subscribes: [] },
      { id: "verifier", name: "Verifier", role: "Confirms all fixes are applied correctly", systemPrompt: "Verify that every issue in {{auditor}} has been fixed by {{fixer}}.", dependsOn: ["fixer"], condition: "", tools: ["read_file", "grep_search"], model: "", maxTokens: 4096, outputKey: "verifier", outputFormat: "text", selfCritique: true, subscribes: [] },
    ],
  },
  {
    label: "Parallel Analysis",
    description: "Two independent analysts then a merger",
    agents: [
      { id: "analyst-a", name: "Analyst A", role: "Analyses from a performance perspective", systemPrompt: "Analyse the codebase for performance bottlenecks.", dependsOn: [], condition: "", tools: ["grep_search", "read_file"], model: "", maxTokens: 4096, outputKey: "analyst-a", outputFormat: "text", selfCritique: false, subscribes: [] },
      { id: "analyst-b", name: "Analyst B", role: "Analyses from a security perspective", systemPrompt: "Analyse the codebase for security vulnerabilities.", dependsOn: [], condition: "", tools: ["grep_search", "read_file"], model: "", maxTokens: 4096, outputKey: "analyst-b", outputFormat: "text", selfCritique: false, subscribes: [] },
      { id: "merger", name: "Merger", role: "Combines both analyses into a unified report", systemPrompt: "Combine {{analyst-a}} and {{analyst-b}} into a prioritised action list.", dependsOn: ["analyst-a", "analyst-b"], condition: "", tools: [], model: "", maxTokens: 4096, outputKey: "merger", outputFormat: "text", selfCritique: false, subscribes: [] },
    ],
  },
  {
    label: "Single Agent",
    description: "One agent — simplest possible team",
    agents: [
      { id: "agent", name: "Agent", role: "Completes the task", systemPrompt: "You are a capable AI agent. Complete the user's request.", dependsOn: [], condition: "", tools: ["edit_file", "create_file", "read_file", "grep_search"], model: "", maxTokens: 8192, outputKey: "agent", outputFormat: "text", selfCritique: false, subscribes: [] },
    ],
  },
];

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const teamNameSignal = signal("My Team");
const teamDescSignal = signal("A new agent team");
const agentsSignal = signal<AgentNode[]>([]);
const positionsSignal = signal<Map<string, NodePos>>(new Map());
const selectedIdSignal = signal<string | null>(null);
const showGallerySignal = signal(false);
const saveAckSignal = signal<string | null>(null);
const existingNamesSignal = signal<string[]>([]);

// Re-compute dragging state per-pointer event (not a signal — ephemeral)
let dragging: { id: string; startX: number; startY: number; origX: number; origY: number } | null = null;
let edgeDraw: { fromId: string; curX: number; curY: number } | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (typeof (window as unknown as { vscode?: unknown }).vscode !== "undefined") {
    return (window as unknown as { vscode: { postMessage: (msg: unknown) => void } }).vscode;
  }
  return (window as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }).acquireVsCodeApi();
}

function computeInitialPositions(agents: AgentNode[]): Map<string, NodePos> {
  if (agents.length === 0) return new Map();
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const idSet = new Set(agents.map((a) => a.id));
  for (const a of agents) { inDegree.set(a.id, 0); adj.set(a.id, []); }
  for (const a of agents) {
    for (const dep of a.dependsOn) {
      if (idSet.has(dep)) {
        adj.get(dep)!.push(a.id);
        inDegree.set(a.id, (inDegree.get(a.id) ?? 0) + 1);
      }
    }
  }
  const layers: string[][] = [];
  let frontier = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  while (frontier.length > 0) {
    layers.push(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const nid of adj.get(id) ?? []) {
        const nd = (inDegree.get(nid) ?? 0) - 1;
        inDegree.set(nid, nd);
        if (nd === 0) next.push(nid);
      }
    }
    frontier = next;
  }
  const pos = new Map<string, NodePos>();
  layers.forEach((layer, li) => {
    const y = PAD + li * (NODE_H + V_GAP) + NODE_H / 2;
    layer.forEach((id, ci) => {
      const x = PAD + ci * (NODE_W + H_GAP) + NODE_W / 2;
      pos.set(id, { x, y });
    });
  });
  return pos;
}

function hasCycle(agents: AgentNode[]): boolean {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const a of agents) { inDeg.set(a.id, 0); adj.set(a.id, []); }
  for (const a of agents) {
    for (const dep of a.dependsOn) {
      adj.get(dep)?.push(a.id);
      inDeg.set(a.id, (inDeg.get(a.id) ?? 0) + 1);
    }
  }
  const q = [...inDeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let processed = 0;
  while (q.length > 0) {
    const n = q.shift()!;
    processed++;
    for (const nb of adj.get(n) ?? []) {
      const nd = (inDeg.get(nb) ?? 0) - 1;
      inDeg.set(nb, nd);
      if (nd === 0) q.push(nb);
    }
  }
  return processed !== agents.length;
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type: string };
  if (msg.type === "teamBuilderLoad") {
    const m = msg as TeamBuilderLoadMessage;
    existingNamesSignal.value = m.existingNames;
    if (m.team) {
      teamNameSignal.value = m.team.name;
      teamDescSignal.value = m.team.description;
      agentsSignal.value = m.team.agents.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        systemPrompt: a.systemPrompt,
        dependsOn: a.dependsOn ?? [],
        condition: a.condition ?? "",
        tools: a.tools ?? [],
        model: a.model ?? "",
        maxTokens: a.maxTokens ?? 4096,
        outputKey: a.outputKey ?? a.id,
        outputFormat: a.outputFormat ?? "text",
        selfCritique: a.selfCritique ?? false,
        subscribes: a.subscribes ?? [],
      }));
      positionsSignal.value = computeInitialPositions(agentsSignal.value);
    }
  } else if (msg.type === "teamBuilderSaveAck") {
    const m = msg as TeamBuilderSaveAckMessage;
    saveAckSignal.value = `Saved to ${m.savedPath}`;
    setTimeout(() => { saveAckSignal.value = null; }, 3000);
  }
});

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NodeCard({ agent }: { agent: AgentNode }): JSX.Element {
  const pos = positionsSignal.value.get(agent.id) ?? { x: PAD + NODE_W / 2, y: PAD + NODE_H / 2 };
  const isSelected = selectedIdSignal.value === agent.id;

  function onPointerDown(e: PointerEvent): void {
    if (e.shiftKey) {
      // Start edge draw
      edgeDraw = { fromId: agent.id, curX: e.clientX, curY: e.clientY };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.stopPropagation();
      return;
    }
    selectedIdSignal.value = agent.id;
    dragging = { id: agent.id, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  }

  function onPointerMove(e: PointerEvent): void {
    if (dragging && dragging.id === agent.id) {
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;
      const newPos = new Map(positionsSignal.value);
      newPos.set(agent.id, { x: dragging.origX + dx, y: dragging.origY + dy });
      positionsSignal.value = newPos;
    }
    if (edgeDraw && edgeDraw.fromId === agent.id) {
      edgeDraw.curX = e.clientX;
      edgeDraw.curY = e.clientY;
    }
  }

  function onPointerUp(e: PointerEvent): void {
    dragging = null;
    if (edgeDraw && edgeDraw.fromId !== agent.id) {
      // Dropped on this node — add edge
      const updated = agentsSignal.value.map((a) =>
        a.id === agent.id && !a.dependsOn.includes(edgeDraw!.fromId)
          ? { ...a, dependsOn: [...a.dependsOn, edgeDraw!.fromId] }
          : a,
      );
      if (!hasCycle(updated)) {
        agentsSignal.value = updated;
      }
    }
    edgeDraw = null;
  }

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={`
        position:absolute;
        left:${pos.x - NODE_W / 2}px;
        top:${pos.y - NODE_H / 2}px;
        width:${NODE_W}px;
        height:${NODE_H}px;
        border-radius:6px;
        border:2px solid ${isSelected ? "var(--vscode-focusBorder)" : "var(--vscode-panel-border)"};
        background:${isSelected ? "var(--vscode-list-activeSelectionBackground)" : "var(--vscode-editor-background)"};
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        cursor:grab;
        user-select:none;
        box-shadow:${isSelected ? "0 0 0 2px var(--vscode-focusBorder)" : "none"};
        touch-action:none;
      `}
    >
      <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:90%;text-align:center;">
        {agent.name.length > 18 ? agent.name.slice(0, 16) + "…" : agent.name}
      </div>
      <div style="font-size:10px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:90%;text-align:center;">
        {agent.role.length > 22 ? agent.role.slice(0, 20) + "…" : agent.role}
      </div>
    </div>
  );
}

function EdgesSvg(): JSX.Element {
  const agents = agentsSignal.value;
  const positions = positionsSignal.value;
  let maxX = 400;
  let maxY = 300;
  for (const { x, y } of positions.values()) {
    if (x + NODE_W / 2 + PAD > maxX) maxX = x + NODE_W / 2 + PAD;
    if (y + NODE_H / 2 + PAD > maxY) maxY = y + NODE_H / 2 + PAD;
  }

  const paths: JSX.Element[] = [];
  for (const agent of agents) {
    for (const depId of agent.dependsOn) {
      const from = positions.get(depId);
      const to = positions.get(agent.id);
      if (!from || !to) continue;
      const x1 = from.x;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y - NODE_H / 2;
      const midY = (y1 + y2) / 2;
      paths.push(
        <path
          key={`${depId}->${agent.id}`}
          d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
          fill="none"
          stroke="var(--vscode-descriptionForeground)"
          strokeWidth={1.5}
          opacity={0.7}
          markerEnd="url(#arrow)"
        />,
      );
    }
  }

  return (
    <svg
      style="position:absolute;inset:0;pointer-events:none;overflow:visible;"
      width={maxX}
      height={maxY}
    >
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill="var(--vscode-descriptionForeground)" opacity={0.7} />
        </marker>
      </defs>
      {paths}
    </svg>
  );
}

function AgentSidebar(): JSX.Element | null {
  const selectedId = selectedIdSignal.value;
  if (!selectedId) {
    return (
      <div style="padding:16px;color:var(--vscode-descriptionForeground);font-size:12px;">
        Click a node to edit it. Shift+drag from one node to another to add a dependency.
      </div>
    );
  }

  const agent = agentsSignal.value.find((a) => a.id === selectedId);
  if (!agent) return null;

  function update(field: keyof AgentNode, value: unknown): void {
    agentsSignal.value = agentsSignal.value.map((a) =>
      a.id === selectedId ? { ...a, [field]: value } : a,
    );
  }

  function removeDepOn(depId: string): void {
    update("dependsOn", agent!.dependsOn.filter((d) => d !== depId));
  }

  function deleteAgent(): void {
    agentsSignal.value = agentsSignal.value
      .filter((a) => a.id !== selectedId)
      .map((a) => ({ ...a, dependsOn: a.dependsOn.filter((d) => d !== selectedId) }));
    const newPos = new Map(positionsSignal.value);
    newPos.delete(selectedId);
    positionsSignal.value = newPos;
    selectedIdSignal.value = null;
  }

  const inputStyle = "width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px 6px;font-size:12px;margin-bottom:8px;";
  const labelStyle = "font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:2px;display:block;";

  return (
    <div style="padding:12px;overflow-y:auto;height:100%;box-sizing:border-box;">
      <div style="font-size:12px;font-weight:700;margin-bottom:10px;">Edit Agent</div>

      <label style={labelStyle}>ID (immutable)</label>
      <div style="font-size:12px;font-family:monospace;background:var(--vscode-textCodeBlock-background);padding:3px 6px;border-radius:3px;margin-bottom:8px;">{agent.id}</div>

      <label style={labelStyle}>Name</label>
      <input style={inputStyle} value={agent.name} onInput={(e) => update("name", (e.target as HTMLInputElement).value)} />

      <label style={labelStyle}>Role</label>
      <input style={inputStyle} value={agent.role} onInput={(e) => update("role", (e.target as HTMLInputElement).value)} />

      <label style={labelStyle}>System Prompt</label>
      <textarea
        style={`${inputStyle}height:100px;resize:vertical;font-family:var(--vscode-editor-font-family,monospace);`}
        value={agent.systemPrompt}
        onInput={(e) => update("systemPrompt", (e.target as HTMLTextAreaElement).value)}
      />

      <label style={labelStyle}>Model (blank = team default)</label>
      <input style={inputStyle} value={agent.model} onInput={(e) => update("model", (e.target as HTMLInputElement).value)} />

      <label style={labelStyle}>Output Format</label>
      <select
        style={inputStyle}
        value={agent.outputFormat}
        onChange={(e) => update("outputFormat", (e.target as HTMLSelectElement).value as "text" | "json" | "files")}
      >
        <option value="text">text</option>
        <option value="json">json</option>
        <option value="files">files</option>
      </select>

      <label style={labelStyle}>Max Tokens</label>
      <input
        type="number"
        style={inputStyle}
        value={agent.maxTokens}
        onInput={(e) => update("maxTokens", Number((e.target as HTMLInputElement).value))}
      />

      <label style={labelStyle}>Self-Critique</label>
      <input
        type="checkbox"
        checked={agent.selfCritique}
        onChange={(e) => update("selfCritique", (e.target as HTMLInputElement).checked)}
        style="margin-bottom:8px;"
      />

      {agent.dependsOn.length > 0 && (
        <div>
          <label style={labelStyle}>Depends On</label>
          {agent.dependsOn.map((depId) => (
            <div key={depId} style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
              <span style="font-size:11px;font-family:monospace;background:var(--vscode-textCodeBlock-background);padding:2px 5px;border-radius:3px;">{depId}</span>
              <button
                onClick={() => removeDepOn(depId)}
                style="background:none;border:none;cursor:pointer;color:var(--vscode-errorForeground);font-size:11px;padding:0;"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={deleteAgent}
        style="width:100%;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);color:var(--vscode-errorForeground);padding:5px;border-radius:3px;cursor:pointer;font-size:11px;margin-top:8px;"
      >
        Delete Agent
      </button>
    </div>
  );
}

function TemplateGallery(): JSX.Element {
  function applyTemplate(tpl: typeof BUILT_IN_TEMPLATES[0]): void {
    agentsSignal.value = tpl.agents;
    positionsSignal.value = computeInitialPositions(tpl.agents);
    showGallerySignal.value = false;
    selectedIdSignal.value = null;
  }

  return (
    <div
      style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center;"
      onClick={() => { showGallerySignal.value = false; }}
    >
      <div
        style="background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:8px;width:480px;max-height:80vh;overflow-y:auto;padding:16px;"
        onClick={(e) => e.stopPropagation()}
      >
        <div style="font-size:14px;font-weight:700;margin-bottom:14px;">Template Gallery</div>
        {BUILT_IN_TEMPLATES.map((tpl) => (
          <div
            key={tpl.label}
            onClick={() => applyTemplate(tpl)}
            style="border:1px solid var(--vscode-panel-border);border-radius:5px;padding:10px 12px;margin-bottom:8px;cursor:pointer;transition:background .1s;"
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--vscode-list-hoverBackground)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}
          >
            <div style="font-size:12px;font-weight:600;">{tpl.label}</div>
            <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px;">{tpl.description}</div>
            <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px;opacity:.7;">{tpl.agents.map((a) => a.name).join(" → ")}</div>
          </div>
        ))}
        <button
          onClick={() => { showGallerySignal.value = false; }}
          style="width:100%;background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);padding:6px;border-radius:3px;cursor:pointer;font-size:11px;margin-top:4px;"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TeamBuilderPanel(): JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);

  function addAgent(): void {
    const newId = `agent-${Date.now()}`;
    const newAgent: AgentNode = {
      id: newId,
      name: "New Agent",
      role: "Describe this agent's role",
      systemPrompt: "You are a helpful AI agent.",
      dependsOn: [],
      condition: "",
      tools: [],
      model: "",
      maxTokens: 4096,
      outputKey: newId,
      outputFormat: "text",
      selfCritique: false,
      subscribes: [],
    };
    agentsSignal.value = [...agentsSignal.value, newAgent];
    const newPos = new Map(positionsSignal.value);
    const x = PAD + agentsSignal.value.length * (NODE_W + H_GAP) + NODE_W / 2;
    const y = PAD + NODE_H / 2;
    newPos.set(newId, { x, y });
    positionsSignal.value = newPos;
    selectedIdSignal.value = newId;
  }

  function save(): void {
    getVsCode().postMessage({
      type: "teamBuilderSave",
      team: {
        name: teamNameSignal.value,
        description: teamDescSignal.value,
        version: "1",
        agents: agentsSignal.value,
        defaults: {},
        execution: {
          maxParallel: 3,
          totalTokenBudget: 100000,
          timeoutSeconds: 120,
          retries: 1,
          checkpoints: true,
          mode: "auto",
        },
      },
    });
  }

  // Determine canvas dimensions
  let canvasW = 600;
  let canvasH = 400;
  for (const { x, y } of positionsSignal.value.values()) {
    if (x + NODE_W / 2 + PAD > canvasW) canvasW = x + NODE_W / 2 + PAD;
    if (y + NODE_H / 2 + PAD > canvasH) canvasH = y + NODE_H / 2 + PAD;
  }

  const btnStyle = "padding:5px 12px;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;font-size:11px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);";
  const inputStyle = "background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px 6px;font-size:12px;";

  return (
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      {/* Toolbar */}
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBarSectionHeader-background);flex-shrink:0;">
        <input
          style={`${inputStyle}width:180px;font-weight:600;`}
          value={teamNameSignal.value}
          onInput={(e) => { teamNameSignal.value = (e.target as HTMLInputElement).value; }}
          placeholder="Team name"
        />
        <input
          style={`${inputStyle}flex:1;`}
          value={teamDescSignal.value}
          onInput={(e) => { teamDescSignal.value = (e.target as HTMLInputElement).value; }}
          placeholder="Team description"
        />
        <button style={btnStyle} onClick={() => { showGallerySignal.value = true; }}>Templates</button>
        <button style={btnStyle} onClick={addAgent}>+ Agent</button>
        <button
          style={`${btnStyle}background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent;`}
          onClick={save}
        >
          Save YAML
        </button>
        {saveAckSignal.value && (
          <span style="font-size:11px;color:var(--vscode-terminal-ansiGreen);">{saveAckSignal.value}</span>
        )}
      </div>

      {/* Body */}
      <div style="display:flex;flex:1;overflow:hidden;">
        {/* Canvas */}
        <div
          ref={canvasRef}
          style="flex:1;overflow:auto;position:relative;"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("[data-node]") === null) {
              selectedIdSignal.value = null;
            }
          }}
        >
          <div style={`position:relative;width:${canvasW}px;height:${canvasH}px;min-width:100%;min-height:100%;`}>
            <EdgesSvg />
            {agentsSignal.value.map((agent) => (
              <div key={agent.id} data-node="true">
                <NodeCard agent={agent} />
              </div>
            ))}
            {agentsSignal.value.length === 0 && (
              <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);font-size:13px;pointer-events:none;">
                Click "+ Agent" or "Templates" to get started
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div style="width:280px;flex-shrink:0;border-left:1px solid var(--vscode-panel-border);overflow:hidden;display:flex;flex-direction:column;">
          <AgentSidebar />
        </div>
      </div>

      {showGallerySignal.value && <TemplateGallery />}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles (webview side)**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx tsc --project webview-ui/tsconfig.json --noEmit 2>&1 | head -30
```

Expected: no errors (or only pre-existing ones).

- [ ] **Step 3: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add webview-ui/src/components/TeamBuilderPanel.tsx
git commit -m "feat(sprint-p): TeamBuilderPanel Preact component with node canvas and template gallery"
```

---

## Task 6: Create `webview-ui/src/components/RulesEditorPanel.tsx`

**Files:**
- Create: `webview-ui/src/components/RulesEditorPanel.tsx`

- [ ] **Step 1: Create the component**

Create `webview-ui/src/components/RulesEditorPanel.tsx`:

```tsx
// webview-ui/src/components/RulesEditorPanel.tsx
import { signal } from "@preact/signals";
import type { RulesListMessage, RulesListAckMessage } from "../../../src/ui/messages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RuleEntry {
  name: string;
  content: string;
  type: "always" | "auto-attached" | "agent-requested";
  glob?: string;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const rulesSignal = signal<RuleEntry[]>([]);
const editingRuleSignal = signal<RuleEntry | null>(null);
const isNewRuleSignal = signal(false);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (typeof (window as unknown as { vscode?: unknown }).vscode !== "undefined") {
    return (window as unknown as { vscode: { postMessage: (msg: unknown) => void } }).vscode;
  }
  return (window as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }).acquireVsCodeApi();
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type: string };
  if (msg.type === "rulesList") {
    rulesSignal.value = (msg as RulesListMessage).rules;
  } else if (msg.type === "rulesListAck") {
    rulesSignal.value = (msg as RulesListAckMessage).rules;
    editingRuleSignal.value = null;
    isNewRuleSignal.value = false;
  }
});

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RuleForm(): JSX.Element | null {
  const rule = editingRuleSignal.value;
  if (!rule) return null;

  const isNew = isNewRuleSignal.value;

  function update(field: keyof RuleEntry, value: unknown): void {
    editingRuleSignal.value = { ...editingRuleSignal.value!, [field]: value };
  }

  function save(): void {
    if (!editingRuleSignal.value) return;
    getVsCode().postMessage({ type: "ruleAdd", rule: editingRuleSignal.value });
  }

  function cancel(): void {
    editingRuleSignal.value = null;
    isNewRuleSignal.value = false;
  }

  const inputStyle = "width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px 6px;font-size:12px;margin-bottom:8px;";
  const labelStyle = "font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:2px;display:block;";

  return (
    <div style="padding:14px;border-left:1px solid var(--vscode-panel-border);width:320px;flex-shrink:0;overflow-y:auto;box-sizing:border-box;">
      <div style="font-size:12px;font-weight:700;margin-bottom:12px;">{isNew ? "New Rule" : `Edit: ${rule.name}`}</div>

      {isNew && (
        <>
          <label style={labelStyle}>Name (filename without .md)</label>
          <input
            style={inputStyle}
            value={rule.name}
            onInput={(e) => update("name", (e.target as HTMLInputElement).value)}
            placeholder="e.g. no-console"
          />
        </>
      )}

      <label style={labelStyle}>Type</label>
      <select
        style={inputStyle}
        value={rule.type}
        onChange={(e) => update("type", (e.target as HTMLSelectElement).value)}
      >
        <option value="always">always — injected into every prompt</option>
        <option value="auto-attached">auto-attached — injected when file matches glob</option>
        <option value="agent-requested">agent-requested — fetched on demand</option>
      </select>

      {rule.type === "auto-attached" && (
        <>
          <label style={labelStyle}>Glob pattern</label>
          <input
            style={inputStyle}
            value={rule.glob ?? ""}
            onInput={(e) => update("glob", (e.target as HTMLInputElement).value || undefined)}
            placeholder="e.g. **/*.ts"
          />
        </>
      )}

      <label style={labelStyle}>Content</label>
      <textarea
        style={`${inputStyle}height:200px;resize:vertical;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;`}
        value={rule.content}
        onInput={(e) => update("content", (e.target as HTMLTextAreaElement).value)}
        placeholder="Rule content (plain text or Markdown)"
      />

      <div style="display:flex;gap:8px;">
        <button
          onClick={save}
          style="flex:1;padding:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;cursor:pointer;font-size:11px;"
        >
          Save Rule
        </button>
        <button
          onClick={cancel}
          style="flex:1;padding:6px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;font-size:11px;"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function RuleTypeTag({ type }: { type: RuleEntry["type"] }): JSX.Element {
  const colors: Record<RuleEntry["type"], string> = {
    "always": "var(--vscode-terminal-ansiGreen)",
    "auto-attached": "var(--vscode-progressBar-background)",
    "agent-requested": "var(--vscode-descriptionForeground)",
  };
  return (
    <span style={`font-size:9px;padding:1px 5px;border-radius:10px;background:${colors[type]}22;color:${colors[type]};border:1px solid ${colors[type]}44;`}>
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RulesEditorPanel(): JSX.Element {
  function openNew(): void {
    editingRuleSignal.value = { name: "", content: "", type: "always" };
    isNewRuleSignal.value = true;
  }

  function openEdit(rule: RuleEntry): void {
    editingRuleSignal.value = { ...rule };
    isNewRuleSignal.value = false;
  }

  function deleteRule(name: string): void {
    getVsCode().postMessage({ type: "ruleDelete", name });
  }

  const rules = rulesSignal.value;

  return (
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      {/* Toolbar */}
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBarSectionHeader-background);flex-shrink:0;">
        <span style="font-size:13px;font-weight:700;flex:1;">Rules Editor</span>
        <button
          onClick={openNew}
          style="padding:5px 12px;border:none;border-radius:3px;cursor:pointer;font-size:11px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);"
        >
          + New Rule
        </button>
      </div>

      {/* Body */}
      <div style="display:flex;flex:1;overflow:hidden;">
        {/* List */}
        <div style="flex:1;overflow-y:auto;">
          {rules.length === 0 && (
            <div style="padding:20px;color:var(--vscode-descriptionForeground);font-size:12px;">
              No rules yet. Create one with "+ New Rule" or add a <code>.md</code> file to <code>.champ/rules/</code>.
            </div>
          )}
          {rules.map((rule) => (
            <div
              key={rule.name}
              style="padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:flex-start;gap:10px;cursor:pointer;transition:background .1s;"
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--vscode-list-hoverBackground)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}
              onClick={() => openEdit(rule)}
            >
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
                  <span style="font-size:12px;font-weight:600;font-family:monospace;">{rule.name}</span>
                  <RuleTypeTag type={rule.type} />
                  {rule.glob && (
                    <span style="font-size:10px;color:var(--vscode-descriptionForeground);font-family:monospace;opacity:.7;">{rule.glob}</span>
                  )}
                </div>
                <div style="font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  {rule.content.slice(0, 80)}{rule.content.length > 80 ? "…" : ""}
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); deleteRule(rule.name); }}
                style="padding:3px 8px;background:none;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;font-size:10px;color:var(--vscode-errorForeground);flex-shrink:0;"
              >
                Delete
              </button>
            </div>
          ))}
        </div>

        {/* Edit form */}
        {editingRuleSignal.value && <RuleForm />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx tsc --project webview-ui/tsconfig.json --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add webview-ui/src/components/RulesEditorPanel.tsx
git commit -m "feat(sprint-p): RulesEditorPanel Preact component with list, add, edit, delete"
```

---

## Task 7: Add "Design" tab to `AgentGraphPanel.tsx`

**Files:**
- Modify: `webview-ui/src/components/AgentGraphPanel.tsx`

The existing panel renders the live DAG only when `teamStateSignal` is non-null. This task adds a "Design" tab that can be activated by a `teamBuilderLoad` message — it shows the DAG from a static `TeamDefinition` JSON (all agents shown as `"pending"`) without any active run.

- [ ] **Step 1: Read existing AgentGraphPanel.tsx**

Already read earlier (lines 1-301). Proceed.

- [ ] **Step 2: Add design mode signals and message listener**

At the top of `webview-ui/src/components/AgentGraphPanel.tsx`, after the existing signal declarations (after line 10), add:

```typescript
import type { TeamBuilderLoadMessage } from "../../../src/ui/messages";
import type { TeamAgentDefinition } from "../../../src/agent/team-definition";

// Design-mode state — populated when a teamBuilderLoad message arrives
const designTeamSignal = signal<{
  name: string;
  agents: Array<{ id: string; name: string; dependsOn: string[] }>;
} | null>(null);
const activeTabSignal = signal<"live" | "design">("live");

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type: string };
  if (msg.type === "teamBuilderLoad") {
    const m = msg as TeamBuilderLoadMessage;
    if (m.team) {
      designTeamSignal.value = {
        name: m.team.name,
        agents: m.team.agents.map((a) => ({
          id: a.id,
          name: a.name,
          dependsOn: a.dependsOn ?? [],
        })),
      };
      activeTabSignal.value = "design";
    }
  }
});
```

- [ ] **Step 3: Add the design-mode render path inside `AgentGraphPanel`**

Replace the `export function AgentGraphPanel(): JSX.Element | null {` function body with the following. The original live-run rendering is preserved; a tab bar switches between "Live" and "Design" when both modes are available.

```typescript
export function AgentGraphPanel(): JSX.Element | null {
  const hasLive = isVisibleSignal.value;
  const hasDesign = designTeamSignal.value !== null;

  if (!hasLive && !hasDesign) return null;

  // If only one mode is active, force that tab
  const tab =
    hasLive && !hasDesign
      ? "live"
      : !hasLive && hasDesign
      ? "design"
      : activeTabSignal.value;

  function handleClose(): void {
    if (tab === "live") {
      teamStateSignal.value = null;
    } else {
      designTeamSignal.value = null;
    }
  }

  // ── Design mode rendering ──────────────────────────────────────────────
  if (tab === "design") {
    const dt = designTeamSignal.value!;
    const dependsOnMap = new Map<string, string[]>(
      dt.agents.map((a) => [a.id, a.dependsOn]),
    );

    // Build fake TeamAgentRunState[] for reuse of computeLayout
    const fakeAgents = dt.agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: "pending" as const,
      output: "",
      tokenCount: 0,
      validationWarnings: [],
      retryCount: 0,
    }));

    const positions = computeLayout(fakeAgents, dependsOnMap);

    let maxX = 0;
    let maxY = 0;
    for (const { x, y } of positions.values()) {
      if (x + NODE_WIDTH / 2 + PADDING > maxX) maxX = x + NODE_WIDTH / 2 + PADDING;
      if (y + NODE_HEIGHT / 2 + PADDING > maxY) maxY = y + NODE_HEIGHT / 2 + PADDING;
    }

    return (
      <div
        style="position:fixed; top:48px; right:12px; width:340px;
               background:var(--vscode-sideBar-background);
               border:1px solid var(--vscode-panel-border);
               border-radius:6px; z-index:60; box-shadow:0 4px 16px rgba(0,0,0,0.3);
               overflow:hidden;"
      >
        <div
          style="display:flex; justify-content:space-between; align-items:center;
                 padding:6px 10px; background:var(--vscode-titleBar-activeBackground);"
        >
          <div style="display:flex; gap:4px;">
            {hasLive && (
              <button
                onClick={() => { activeTabSignal.value = "live"; }}
                style={`background:none; border:none; cursor:pointer; font-size:11px; font-weight:600; padding:2px 6px; border-radius:3px; ${tab === "live" ? "color:var(--vscode-foreground); background:var(--vscode-panel-border);" : "color:var(--vscode-descriptionForeground);"}`}
              >
                Live
              </button>
            )}
            {hasDesign && (
              <button
                onClick={() => { activeTabSignal.value = "design"; }}
                style={`background:none; border:none; cursor:pointer; font-size:11px; font-weight:600; padding:2px 6px; border-radius:3px; ${tab === "design" ? "color:var(--vscode-foreground); background:var(--vscode-panel-border);" : "color:var(--vscode-descriptionForeground);"}`}
              >
                Design
              </button>
            )}
            <span style="font-size:12px; font-weight:600; margin-left:4px;">{dt.name}</span>
          </div>
          <button
            onClick={handleClose}
            style="background:none; border:none; cursor:pointer; color:var(--vscode-icon-foreground); font-size:14px;"
            aria-label="Close design preview"
          >
            x
          </button>
        </div>
        <div style="overflow:auto; max-height:300px;">
          <svg
            width={Math.max(maxX, 200)}
            height={Math.max(maxY, 120)}
            xmlns="http://www.w3.org/2000/svg"
          >
            {fakeAgents.map((agent) =>
              (dependsOnMap.get(agent.id) ?? []).map((depId) => {
                const fromPos = positions.get(depId);
                const toPos = positions.get(agent.id);
                if (!fromPos || !toPos) return null;
                return (
                  <EdgeLine
                    key={`${depId}->${agent.id}`}
                    fromPos={fromPos}
                    toPos={toPos}
                  />
                );
              }),
            )}
            {fakeAgents.map((agent) => {
              const pos = positions.get(agent.id);
              if (!pos) return null;
              return (
                <AgentNode key={agent.id} agent={agent} x={pos.x} y={pos.y} />
              );
            })}
          </svg>
        </div>
        <div
          style="padding:4px 10px; font-size:10px; color:var(--vscode-descriptionForeground);
                 border-top:1px solid var(--vscode-panel-border);"
        >
          {fakeAgents.length} agent{fakeAgents.length !== 1 ? "s" : ""} — design preview
        </div>
      </div>
    );
  }

  // ── Live mode rendering (original code) ────────────────────────────────
  const state = teamStateSignal.value!;

  const dependsOnMap = new Map<string, string[]>();
  for (const agent of state.agents) {
    dependsOnMap.set(agent.id, []);
  }

  const positions = computeLayout(state.agents, dependsOnMap);

  let maxX = 0;
  let maxY = 0;
  for (const { x, y } of positions.values()) {
    if (x + NODE_WIDTH / 2 + PADDING > maxX) maxX = x + NODE_WIDTH / 2 + PADDING;
    if (y + NODE_HEIGHT / 2 + PADDING > maxY) maxY = y + NODE_HEIGHT / 2 + PADDING;
  }
  const svgWidth = Math.max(maxX, 200);
  const svgHeight = Math.max(maxY, 120);

  return (
    <div
      style="position:fixed; top:48px; right:12px; width:340px;
             background:var(--vscode-sideBar-background);
             border:1px solid var(--vscode-panel-border);
             border-radius:6px; z-index:60; box-shadow:0 4px 16px rgba(0,0,0,0.3);
             overflow:hidden;"
    >
      <div
        style="display:flex; justify-content:space-between; align-items:center;
               padding:6px 10px; background:var(--vscode-titleBar-activeBackground);"
      >
        <div style="display:flex; gap:4px; align-items:center;">
          {hasDesign && (
            <button
              onClick={() => { activeTabSignal.value = "design"; }}
              style="background:none; border:none; cursor:pointer; font-size:11px; font-weight:600; padding:2px 6px; border-radius:3px; color:var(--vscode-descriptionForeground);"
            >
              Design
            </button>
          )}
          <span style="font-size:12px; font-weight:600;">
            {state.teamName} — {state.status}
          </span>
        </div>
        <button
          onClick={handleClose}
          style="background:none; border:none; cursor:pointer; color:var(--vscode-icon-foreground); font-size:14px;"
          aria-label="Close agent graph"
        >
          x
        </button>
      </div>
      <div style="overflow:auto; max-height:300px;">
        <svg
          width={svgWidth}
          height={svgHeight}
          xmlns="http://www.w3.org/2000/svg"
        >
          {state.agents.map((agent) =>
            (dependsOnMap.get(agent.id) ?? []).map((depId) => {
              const fromPos = positions.get(depId);
              const toPos = positions.get(agent.id);
              if (!fromPos || !toPos) return null;
              return (
                <EdgeLine
                  key={`${depId}->${agent.id}`}
                  fromPos={fromPos}
                  toPos={toPos}
                />
              );
            }),
          )}
          {state.agents.map((agent) => {
            const pos = positions.get(agent.id);
            if (!pos) return null;
            return (
              <AgentNode key={agent.id} agent={agent} x={pos.x} y={pos.y} />
            );
          })}
        </svg>
      </div>
      <div
        style="padding:4px 10px; font-size:10px; color:var(--vscode-descriptionForeground);
               border-top:1px solid var(--vscode-panel-border);"
      >
        {state.totalTokens.toLocaleString()} tokens
        {state.tokenBudget
          ? ` / ${state.tokenBudget.toLocaleString()} budget`
          : ""}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx tsc --project webview-ui/tsconfig.json --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add webview-ui/src/components/AgentGraphPanel.tsx
git commit -m "feat(sprint-p): AgentGraphPanel Design tab — static DAG preview from TeamDefinition"
```

---

## Task 8: Update `webview-ui/src/index.tsx` to mount new panels

**Files:**
- Modify: `webview-ui/src/index.tsx`

The existing `index.tsx` mounts three components into a single `#champ-panels` div. The new panels get their own mount points because they live in separate WebviewPanels with separate HTML. However, `TeamBuilderPanel` and `RulesEditorPanel` are mounted by `mountTeamBuilder` and `mountRulesEditor` functions that are exported on `window.ChampPanels`. The `#champ-panels` div (main chat) still mounts the existing three.

- [ ] **Step 1: Modify `webview-ui/src/index.tsx`**

Replace the entire file content:

```tsx
// webview-ui/src/index.tsx — Preact app entry point
import { render } from "preact";
import { DiffOverlayPanel } from "./components/DiffOverlayPanel";
import { AgentGraphPanel } from "./components/AgentGraphPanel";
import { McpMarketplacePanel } from "./components/McpMarketplacePanel";
import { TeamBuilderPanel } from "./components/TeamBuilderPanel";
import { RulesEditorPanel } from "./components/RulesEditorPanel";

function App(): JSX.Element {
  return (
    <>
      <DiffOverlayPanel />
      <AgentGraphPanel />
      <McpMarketplacePanel />
    </>
  );
}

// Main chat view — always mounted
const root = document.getElementById("champ-panels");
if (root) {
  render(<App />, root);
}

// Team builder view — mounted by team-builder-panel.ts
function mountTeamBuilder(container: HTMLElement): void {
  render(<TeamBuilderPanel />, container);
}

// Rules editor view — mounted by rules-editor-panel.ts
function mountRulesEditor(container: HTMLElement): void {
  render(<RulesEditorPanel />, container);
}

// Expose mount functions for the separate WebviewPanel HTML scripts
declare global {
  interface Window {
    ChampPanels: {
      mountTeamBuilder: (container: HTMLElement) => void;
      mountRulesEditor: (container: HTMLElement) => void;
    };
  }
}

// The bundle is compiled as an IIFE with globalName "ChampPanels" by
// esbuild.webview.mjs — so we attach to `window.ChampPanels` directly.
// The IIFE wrapping means the exports are already on `window.ChampPanels`
// if esbuild is configured with `globalName: "ChampPanels"`.
// We supplement with the two new mount functions here.
Object.assign(window.ChampPanels ?? {}, { mountTeamBuilder, mountRulesEditor });
```

- [ ] **Step 2: Build the webview bundle**

```bash
cd /home/dk/Documents/git/vs-code-plugin && node esbuild.webview.mjs 2>&1
```

Expected: `[esbuild.webview] Build complete → webview-ui/dist/components.js`

- [ ] **Step 3: Validate the output bundle**

```bash
node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/components.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`

- [ ] **Step 4: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add webview-ui/src/index.tsx webview-ui/dist/components.js
git commit -m "feat(sprint-p): mount TeamBuilderPanel and RulesEditorPanel in webview bundle"
```

---

## Task 9: `TeamBuilderPanel` sends `teamBuilderLoad` to `AgentGraphPanel` on open

**Files:**
- Modify: `src/ui/team-builder-panel.ts`

When `champ.openTeamBuilder` is called with an existing `teamToEdit`, the extension should also broadcast a `teamBuilderLoad` event to the main chat view so that the `AgentGraphPanel` "Design" tab activates. This happens via the `ChatViewProvider` posting a message to its webview.

The cleanest approach: `TeamBuilderPanel` emits a VS Code event that `extension.ts` listens to and forwards to the chat webview.

- [ ] **Step 1: Add a VS Code EventEmitter to TeamBuilderPanel**

In `src/ui/team-builder-panel.ts`, add to the `TeamBuilderPanel` class:

```typescript
  /** Fires whenever a team is loaded so the chat view can show the Design tab. */
  readonly onTeamLoaded: vscode.Event<import("../agent/team-definition").TeamDefinition | null>;
  private _onTeamLoaded = new vscode.EventEmitter<import("../agent/team-definition").TeamDefinition | null>();
```

In the constructor, initialize it before `sendLoadMessage`:

```typescript
    this.onTeamLoaded = this._onTeamLoaded.event;
```

In `sendLoadMessage`, after setting `msg`, emit the event:

```typescript
    this._onTeamLoaded.fire(team);
```

In `dispose`, add:

```typescript
    this._onTeamLoaded.dispose();
```

- [ ] **Step 2: Subscribe in `extension.ts`**

In `extension.ts`, inside the `champ.openTeamBuilder` command handler, after `new TeamBuilderPanel(...)`:

```typescript
        const builderPanel = new TeamBuilderPanel(context.extensionUri, workspaceRoot, teamToEdit);
        builderPanel.onTeamLoaded((team) => {
          if (chatViewProvider && team) {
            chatViewProvider.postMessage({
              type: "teamBuilderLoad",
              team,
              existingNames: [],
            });
          }
        });
```

Note: `chatViewProvider` is the module-level singleton already declared in `extension.ts`. `chatViewProvider.postMessage` is available if `ChatViewProvider` exposes a `postMessage` method — check if it does.

- [ ] **Step 3: Verify ChatViewProvider has postMessage**

```bash
grep -n "postMessage\|public post" /home/dk/Documents/git/vs-code-plugin/src/ui/chat-view-provider.ts | head -10
```

If it does not have a `postMessage` method, add one to `ChatViewProvider`:

```typescript
  postMessage(msg: unknown): void {
    void this._view?.webview.postMessage(msg);
  }
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/ui/team-builder-panel.ts src/extension.ts src/ui/chat-view-provider.ts
git commit -m "feat(sprint-p): TeamBuilderPanel fires onTeamLoaded to activate Design tab in chat view"
```

---

## Task 10: Version bump, build verification, and full test run

**Files:**
- Modify: `package.json` (version bump via npm)

- [ ] **Step 1: Run the full test suite**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm test 2>&1 | tail -30
```

Expected: all existing tests pass + the 7 new tests in `team-builder-panel.test.ts` pass.

- [ ] **Step 2: Bump patch version**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm version patch 2>&1
```

Expected: version bumped from `1.6.111` to `1.6.112`.

- [ ] **Step 3: Rebuild the extension**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -10
```

Expected: build completes with no errors.

- [ ] **Step 4: Rebuild the webview bundle**

```bash
cd /home/dk/Documents/git/vs-code-plugin && node esbuild.webview.mjs 2>&1
```

Expected: `[esbuild.webview] Build complete → webview-ui/dist/components.js`

- [ ] **Step 5: Validate the webview bundle**

```bash
node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/components.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`

- [ ] **Step 6: Final commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add package.json package-lock.json webview-ui/dist/components.js
git commit -m "chore: bump to 1.6.112 — Sprint P complete"
```

---

## Task 11: Smoke test checklist (manual)

These steps cannot be automated (they require VS Code UI interaction) but are required before considering Sprint P complete.

- [ ] **Open the command palette (`Ctrl+Shift+P`) and run `Champ: Open Team Builder`**
  - Expected: a new editor tab opens titled "Champ: Team Builder"
  - Expected: the canvas is empty with a "Click + Agent or Templates to get started" message

- [ ] **Click "Templates" and pick "Plan → Code → Review"**
  - Expected: the gallery modal appears with 5 templates
  - Expected: after picking, three nodes appear on the canvas connected by edges (Planner → Coder → Reviewer)

- [ ] **Click "Save YAML" with team name "Test Team"**
  - Expected: `.champ/teams/test_team.yaml` is created
  - Expected: the file contains valid YAML readable by `TeamLoader`

- [ ] **Run `Champ: Open Team Builder` again and click the same team's "Edit" (or call `champ.openTeamBuilder` with the team name)**
  - Expected: the existing team definition is loaded into the canvas

- [ ] **Open command palette and run `Champ: Open Rules Editor`**
  - Expected: a new editor tab opens titled "Champ: Rules Editor"
  - Expected: any existing `.champ/rules/*.md` files are listed

- [ ] **Click "+ New Rule", fill in name "no-console", type "always", content "Never use console.log in production."**
  - Expected: `.champ/rules/no-console.md` is created with correct frontmatter

- [ ] **Click "Delete" on the rule just created**
  - Expected: confirmation dialog appears; after confirming, the rule is removed from the list and the file is deleted

- [ ] **Open a team in the Team Builder and observe the AgentGraphPanel "Design" tab in the main chat view**
  - Expected: the floating graph panel shows a "Design" tab with the static DAG

---

## Summary of Gaps Addressed

| Gap | Addressed By |
|-----|-------------|
| Team authoring requires YAML | Task 5 — `TeamBuilderPanel.tsx` visual canvas + Task 2 — `TeamBuilderPanel.ts` YAML serializer |
| No rules editor | Task 6 — `RulesEditorPanel.tsx` + Task 3 — `RulesEditorPanel.ts` |
| No static DAG preview before running | Task 7 — "Design" tab on `AgentGraphPanel.tsx` |
| No template gallery | Task 5 — `BUILT_IN_TEMPLATES` constant with 5 built-in templates in `TeamBuilderPanel.tsx` |
