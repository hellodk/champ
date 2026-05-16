# Incremental Preact Webview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Preact build pipeline alongside the existing vanilla JS webview, mounting new complex UI components (`DiffOverlayPanel`, `AgentGraphPanel`, `McpMarketplacePanel`) in a dedicated `<div id="champ-panels">` without touching `main.js` logic.

**Architecture:** New `esbuild.webview.mjs` compiles `webview-ui/src/index.tsx` to `webview-ui/dist/components.js`. `ChatViewProvider` injects this bundle alongside `main.js` in the chat HTML, mounting at `<div id="champ-panels">`. The two systems communicate through the existing `vscode.postMessage` protocol via `CustomEvent` dispatch from `main.js`.

**Tech Stack:** Preact 10, `@preact/signals`, TypeScript, esbuild.

---

## Task 1: Install Preact devDependencies

- [ ] Add to `package.json` `devDependencies`:

```json
"preact": "^10.25.0",
"@preact/signals": "^1.3.0",
"@testing-library/preact": "^3.2.4"
```

The additions go inside the existing `"devDependencies"` object alongside the other entries.

- [ ] Install:
  ```bash
  npm install --save-dev preact@^10 @preact/signals@^1 @testing-library/preact@^3
  ```
  Expected: `node_modules/preact/` and `node_modules/@preact/` directories created.

---

## Task 2: Create `esbuild.webview.mjs`

- [ ] Create `esbuild.webview.mjs` at the repository root (same level as `esbuild.mjs`):

```javascript
// esbuild.webview.mjs — builds the Preact webview bundle
import * as esbuild from "esbuild";

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: ["webview-ui/src/index.tsx"],
  bundle: true,
  outfile: "webview-ui/dist/components.js",
  format: "iife",
  globalName: "ChampPanels",
  platform: "browser",
  target: ["es2020"],
  alias: {
    react: "preact/compat",
    "react-dom": "preact/compat",
    "react-dom/test-utils": "preact/test-utils",
  },
  define: {
    "process.env.NODE_ENV": isProduction ? '"production"' : '"development"',
  },
  minify: isProduction,
  sourcemap: !isProduction,
  sourcesContent: false,
  logLevel: "info",
};

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild.webview] Watching for changes…");
} else {
  await esbuild.build(options);
  console.log("[esbuild.webview] Build complete →", options.outfile);
}
```

---

## Task 3: Update `package.json` scripts

- [ ] Update the scripts in `package.json`. Current `"compile"` is `"npm run check-types && node esbuild.mjs"`. New value:

```json
"compile": "npm run check-types && node esbuild.mjs && node esbuild.webview.mjs --production",
"build:webview": "node esbuild.webview.mjs --production",
"watch:webview": "node esbuild.webview.mjs --watch"
```

The existing `"watch"` script is `"npm-run-all -p watch:*"`. Adding `"watch:webview"` means it will automatically be picked up because `npm-run-all -p watch:*` runs all `watch:*` scripts in parallel. No change needed to the `"watch"` script itself.

- [ ] Verify the build works:
  ```bash
  node esbuild.webview.mjs --production 2>&1
  ```
  Expected output includes: `[esbuild.webview] Build complete → webview-ui/dist/components.js`
  Expected: `webview-ui/dist/components.js` is created (may be empty/minimal until source files exist).

---

## Task 4: Create shared types `webview-ui/src/types.ts`

- [ ] Create directory `webview-ui/src/` if it does not exist.

- [ ] Create `webview-ui/src/types.ts`:

```typescript
// webview-ui/src/types.ts
// Browser-safe types mirroring src/ui/messages.ts and src/agent/team-definition.ts
// No vscode imports, no Node.js imports.

/** Edit record for DiffOverlayPanel — mirrors EditSummaryMessage.edits. */
export interface EditSummary {
  path: string;
  oldContent: string;
  newContent: string;
}

/** Edit summary message sent from extension host. */
export interface EditSummaryMessage {
  type: "editSummary";
  edits: EditSummary[];
}

/** Agent status values — mirrors TeamAgentStatus in team-definition.ts. */
export type TeamAgentStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "blocked";

/** Live state of one agent during a team run. */
export interface TeamAgentRunState {
  id: string;
  name: string;
  status: TeamAgentStatus;
  output: string;
  startTime?: number;
  endTime?: number;
  tokenCount: number;
  blockedReason?: string;
  validationWarnings: string[];
  retryCount: number;
}

/** Full team run state sent via teamRunSnapshot message. */
export interface TeamRunState {
  runId: string;
  teamName: string;
  userRequest: string;
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  agents: TeamAgentRunState[];
  sharedMemorySnapshot: Record<string, string>;
  startTime: number;
  endTime?: number;
  totalTokens: number;
  tokenBudget?: number;
  filesChanged: string[];
  mode: "auto" | "safe" | "supervised";
}

/** MCP marketplace entry — mirrors McpMarketplaceEntry in mcp-marketplace-client.ts. */
export interface McpMarketplaceEntry {
  name: string;
  description: string;
  author: string;
  url: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  baseUrl?: string;
  tags: string[];
}

/** teamRunSnapshot message from extension host. */
export interface TeamRunSnapshotMessage {
  type: "teamRunSnapshot";
  state: TeamRunState;
}

/** mcpMarketplaceEntries message from extension host. */
export interface McpMarketplaceEntriesMessage {
  type: "mcpMarketplaceEntries";
  entries: McpMarketplaceEntry[];
}

/** mcpMarketplaceInstallComplete message from extension host. */
export interface McpMarketplaceInstallCompleteMessage {
  type: "mcpMarketplaceInstallComplete";
  name: string;
  success: boolean;
  errorMessage?: string;
}
```

---

## Task 5: Create `webview-ui/src/utils/diff.ts`

- [ ] Create `webview-ui/src/utils/diff.ts`. This is a pure TypeScript port of the LCS algorithm from `src/utils/diff-utils.ts`, adapted for the webview context (no VS Code API, no Node.js, browser-safe):

```typescript
// webview-ui/src/utils/diff.ts
// Pure diff logic for the Preact webview bundle.
// Ported from src/utils/diff-utils.ts — no DOM, no VS Code API.

export interface WebviewHunk {
  /** 0-based index in the file's hunk list. */
  index: number;
  /** Old lines removed in this hunk. */
  removedLines: string[];
  /** New lines added in this hunk. */
  addedLines: string[];
  /** 0-based start line in the new document (for Accept/Reject button placement). */
  newDocStartLine: number;
}

type EditType = "equal" | "insert" | "delete";
interface RawEdit {
  type: EditType;
  line: string;
}

function longestCommonSubsequence(
  a: string[],
  b: string[],
): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return pairs;
}

function computeRawEdits(a: string[], b: string[]): RawEdit[] {
  const lcs = longestCommonSubsequence(a, b);
  const edits: RawEdit[] = [];
  let ia = 0;
  let ib = 0;
  for (const [ai, bi] of lcs) {
    while (ia < ai) edits.push({ type: "delete", line: a[ia++] });
    while (ib < bi) edits.push({ type: "insert", line: b[ib++] });
    edits.push({ type: "equal", line: a[ia++] });
    ib++;
  }
  while (ia < a.length) edits.push({ type: "delete", line: a[ia++] });
  while (ib < b.length) edits.push({ type: "insert", line: b[ib++] });
  return edits;
}

/**
 * Split old and new file content into WebviewHunk objects.
 * Returns [] if content is identical.
 */
export function splitHunks(oldContent: string, newContent: string): WebviewHunk[] {
  if (oldContent === newContent) return [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const rawEdits = computeRawEdits(oldLines, newLines);

  const hunks: WebviewHunk[] = [];
  let newIdx = 0;
  let editI = 0;

  while (editI < rawEdits.length) {
    const edit = rawEdits[editI];
    if (edit.type === "equal") {
      newIdx++;
      editI++;
      continue;
    }

    const newDocStartLine = newIdx;
    const removedLines: string[] = [];
    const addedLines: string[] = [];

    while (editI < rawEdits.length && rawEdits[editI].type !== "equal") {
      const e = rawEdits[editI];
      if (e.type === "delete") {
        removedLines.push(e.line);
      } else {
        addedLines.push(e.line);
        newIdx++;
      }
      editI++;
    }

    hunks.push({
      index: hunks.length,
      removedLines,
      addedLines,
      newDocStartLine,
    });
  }

  return hunks;
}
```

---

## Task 6: Create `webview-ui/src/components/DiffOverlayPanel.tsx`

- [ ] Create `webview-ui/src/components/DiffOverlayPanel.tsx`:

```tsx
// webview-ui/src/components/DiffOverlayPanel.tsx
import { signal, computed } from "@preact/signals";
import { splitHunks, type WebviewHunk } from "../utils/diff";
import type { EditSummaryMessage, EditSummary } from "../types";

// Module-level signals — shared across all component instances.
export const editsSignal = signal<EditSummary[]>([]);
const isVisibleSignal = computed(() => editsSignal.value.length > 0);

// Listen for edit summary events dispatched by main.js bridge
window.addEventListener("champ:editSummary", (e: Event) => {
  const msg = (e as CustomEvent<EditSummaryMessage>).detail;
  if (Array.isArray(msg.edits)) {
    editsSignal.value = msg.edits;
  }
});

// Track per-hunk accept/reject state keyed by "filePath:hunkIndex"
const hunkResolutions = signal<Map<string, "accepted" | "rejected">>(new Map());

// VS Code API handle (acquireVsCodeApi called once per page — safe to call here
// only if this module loads after main.js which calls it first).
// We read it from window.vscode set by main.js, or call acquire ourselves.
function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (typeof (window as unknown as { vscode?: unknown }).vscode !== "undefined") {
    return (window as unknown as { vscode: { postMessage: (msg: unknown) => void } }).vscode;
  }
  // Fallback: acquire directly. Should not happen if main.js loaded first.
  return (
    window as unknown as {
      acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
    }
  ).acquireVsCodeApi();
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
              ⚡ Accept
            </button>
            <button
              onClick={handleReject}
              style="font-size:11px; padding:1px 6px; cursor:pointer;"
            >
              ✗ Reject
            </button>
          </>
        )}
        {resolution === "accepted" && (
          <span style="font-size:11px; color:var(--vscode-terminal-ansiGreen);">
            ✓ Accepted
          </span>
        )}
        {resolution === "rejected" && (
          <span style="font-size:11px; color:var(--vscode-editorError-foreground);">
            ↩ Rejected
          </span>
        )}
      </div>
      <pre style="margin:0; font-size:11px; overflow-x:auto;">
        {hunk.removedLines.map((l, i) => (
          <div key={`del-${i}`} style="color:var(--vscode-gitDecoration-deletedResourceForeground);">
            - {l}
          </div>
        ))}
        {hunk.addedLines.map((l, i) => (
          <div key={`add-${i}`} style="color:var(--vscode-gitDecoration-addedResourceForeground);">
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
        <button onClick={handleRevertFile} style="font-size:11px; padding:1px 6px; cursor:pointer;">
          ↩ Revert File
        </button>
      </div>
      {hunks.map((hunk) => (
        <HunkRow key={`${edit.path}:${hunk.index}`} edit={edit} hunk={hunk} />
      ))}
    </div>
  );
}

/** Main DiffOverlayPanel component. Renders nothing when no edits are pending. */
export function DiffOverlayPanel(): JSX.Element | null {
  if (!isVisibleSignal.value) return null;

  const edits = editsSignal.value;

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
      style="position:fixed; bottom:0; left:0; right:0; max-height:50vh; overflow-y:auto;
             background:var(--vscode-sideBar-background);
             border-top:1px solid var(--vscode-panel-border);
             z-index:50; box-shadow:0 -4px 12px rgba(0,0,0,0.3);"
    >
      <div
        style="display:flex; justify-content:space-between; align-items:center;
               padding:6px 12px; background:var(--vscode-titleBar-activeBackground);"
      >
        <span style="font-weight:600; font-size:13px;">
          Champ Edits ({edits.length} file{edits.length !== 1 ? "s" : ""})
        </span>
        <div style="display:flex; gap:8px;">
          <button
            onClick={handleAcceptAll}
            style="padding:3px 10px; cursor:pointer; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:2px;"
          >
            ✓ Accept All
          </button>
          <button
            onClick={handleRejectAll}
            style="padding:3px 10px; cursor:pointer;"
          >
            ↩ Reject All
          </button>
        </div>
      </div>
      <div style="padding:8px 12px;">
        {edits.map((edit) => (
          <FileSection key={edit.path} edit={edit} />
        ))}
      </div>
    </div>
  );
}
```

---

## Task 7: Create `webview-ui/src/components/AgentGraphPanel.tsx`

- [ ] Create `webview-ui/src/components/AgentGraphPanel.tsx`:

```tsx
// webview-ui/src/components/AgentGraphPanel.tsx
import { signal, computed } from "@preact/signals";
import type { TeamRunState, TeamAgentRunState, TeamAgentStatus } from "../types";

export const teamStateSignal = signal<TeamRunState | null>(null);
const isVisibleSignal = computed(() => teamStateSignal.value !== null);

// Listen for teamUpdate events dispatched by main.js bridge
window.addEventListener("champ:teamUpdate", (e: Event) => {
  const msg = (e as CustomEvent<{ state: TeamRunState }>).detail;
  if (msg.state) {
    teamStateSignal.value = msg.state;
  }
});

// VS Code API handle
function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (typeof (window as unknown as { vscode?: unknown }).vscode !== "undefined") {
    return (window as unknown as { vscode: { postMessage: (msg: unknown) => void } }).vscode;
  }
  return (
    window as unknown as {
      acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
    }
  ).acquireVsCodeApi();
}

// Layout constants
const NODE_WIDTH = 160;
const NODE_HEIGHT = 48;
const H_GAP = 40;
const V_GAP = 60;
const PADDING = 20;

function statusToFill(status: TeamAgentStatus): string {
  switch (status) {
    case "pending":  return "var(--vscode-badge-background)";
    case "running":  return "var(--vscode-progressBar-background)";
    case "done":     return "var(--vscode-terminal-ansiGreen)";
    case "failed":   return "var(--vscode-inputValidation-errorBackground)";
    case "skipped":  return "var(--vscode-disabledForeground)";
    case "blocked":  return "var(--vscode-inputValidation-warningBackground)";
    default:         return "var(--vscode-badge-background)";
  }
}

function statusToStroke(status: TeamAgentStatus): string {
  switch (status) {
    case "pending":  return "var(--vscode-badge-foreground)";
    case "running":  return "var(--vscode-focusBorder)";
    case "done":     return "var(--vscode-terminal-ansiGreen)";
    case "failed":   return "var(--vscode-inputValidation-errorBorder)";
    case "skipped":  return "var(--vscode-descriptionForeground)";
    case "blocked":  return "var(--vscode-inputValidation-warningBorder)";
    default:         return "var(--vscode-badge-foreground)";
  }
}

/**
 * Compute a simple top-to-bottom BFS layout for the DAG.
 * Returns a map of agentId → {x, y} center positions.
 */
function computeLayout(
  agents: TeamAgentRunState[],
  dependsOnMap: Map<string, string[]>,
): Map<string, { x: number; y: number }> {
  // BFS layering
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const idSet = new Set(agents.map((a) => a.id));

  for (const a of agents) {
    inDegree.set(a.id, 0);
    adj.set(a.id, []);
  }

  for (const a of agents) {
    for (const dep of dependsOnMap.get(a.id) ?? []) {
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
    const totalWidth = layer.length * NODE_WIDTH + (layer.length - 1) * H_GAP;
    layer.forEach((id, colIdx) => {
      const x = PADDING + colIdx * (NODE_WIDTH + H_GAP) + NODE_WIDTH / 2;
      positions.set(id, { x, y });
    });
    // Suppress unused variable warning
    void totalWidth;
  });

  return positions;
}

function AgentNode({
  agent,
  x,
  y,
}: {
  agent: TeamAgentRunState;
  x: number;
  y: number;
}): JSX.Element {
  const fill = statusToFill(agent.status);
  const stroke = statusToStroke(agent.status);

  function handleClick(): void {
    getVsCode().postMessage({ type: "focusTeamAgent", agentId: agent.id });
  }

  return (
    <g
      transform={`translate(${x - NODE_WIDTH / 2}, ${y - NODE_HEIGHT / 2})`}
      onClick={handleClick}
      style="cursor:pointer;"
    >
      <rect
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={6}
        ry={6}
        fill={fill}
        stroke={stroke}
        strokeWidth={2}
      />
      <text
        x={NODE_WIDTH / 2}
        y={NODE_HEIGHT * 0.42}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="var(--vscode-editor-foreground)"
        fontSize={12}
        fontWeight="600"
      >
        {agent.name.length > 18 ? agent.name.slice(0, 16) + "…" : agent.name}
      </text>
      <text
        x={NODE_WIDTH / 2}
        y={NODE_HEIGHT * 0.72}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="var(--vscode-descriptionForeground)"
        fontSize={10}
      >
        {agent.status}
        {agent.status === "running" ? " ●" : ""}
      </text>
    </g>
  );
}

function EdgeLine({
  fromPos,
  toPos,
}: {
  fromPos: { x: number; y: number };
  toPos: { x: number; y: number };
}): JSX.Element {
  const x1 = fromPos.x;
  const y1 = fromPos.y + NODE_HEIGHT / 2;
  const x2 = toPos.x;
  const y2 = toPos.y - NODE_HEIGHT / 2;
  const midY = (y1 + y2) / 2;

  return (
    <path
      d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
      fill="none"
      stroke="var(--vscode-descriptionForeground)"
      strokeWidth={1.5}
      opacity={0.6}
    />
  );
}

/** Main AgentGraphPanel component. Renders nothing when no team run is active. */
export function AgentGraphPanel(): JSX.Element | null {
  if (!isVisibleSignal.value) return null;

  const state = teamStateSignal.value!;

  // AgentGraphPanel does not have dependsOn info in TeamRunState.
  // We build a placeholder dependsOnMap (empty — layout falls back to flat rows).
  // A future sprint will include dependsOn in the snapshot.
  const dependsOnMap = new Map<string, string[]>();
  for (const agent of state.agents) {
    dependsOnMap.set(agent.id, []);
  }

  const positions = computeLayout(state.agents, dependsOnMap);

  // Compute SVG dimensions
  let maxX = 0;
  let maxY = 0;
  for (const { x, y } of positions.values()) {
    if (x + NODE_WIDTH / 2 + PADDING > maxX) maxX = x + NODE_WIDTH / 2 + PADDING;
    if (y + NODE_HEIGHT / 2 + PADDING > maxY) maxY = y + NODE_HEIGHT / 2 + PADDING;
  }
  const svgWidth = Math.max(maxX, 200);
  const svgHeight = Math.max(maxY, 120);

  function handleClose(): void {
    teamStateSignal.value = null;
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
        <span style="font-size:12px; font-weight:600;">
          {state.teamName} — {state.status}
        </span>
        <button
          onClick={handleClose}
          style="background:none; border:none; cursor:pointer; color:var(--vscode-icon-foreground); font-size:14px;"
          aria-label="Close agent graph"
        >
          ×
        </button>
      </div>
      <div style="overflow:auto; max-height:300px;">
        <svg
          width={svgWidth}
          height={svgHeight}
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Edges — drawn first so nodes appear above */}
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
          {/* Nodes */}
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
        {state.tokenBudget ? ` / ${state.tokenBudget.toLocaleString()} budget` : ""}
      </div>
    </div>
  );
}
```

---

## Task 8: Create `webview-ui/src/components/McpMarketplacePanel.tsx`

- [ ] Create `webview-ui/src/components/McpMarketplacePanel.tsx`:

```tsx
// webview-ui/src/components/McpMarketplacePanel.tsx
import { signal, computed } from "@preact/signals";
import type { McpMarketplaceEntry } from "../types";

export const isOpenSignal = signal(false);
export const entriesSignal = signal<McpMarketplaceEntry[]>([]);
const isLoadingSignal = signal(false);
const searchQuerySignal = signal("");
const installedNamesSignal = signal<Set<string>>(new Set());
const installErrorsSignal = signal<Map<string, string>>(new Map());

const filteredEntriesSignal = computed(() => {
  const q = searchQuerySignal.value.toLowerCase();
  if (!q) return entriesSignal.value;
  return entriesSignal.value.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
  );
});

// VS Code API handle
function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (typeof (window as unknown as { vscode?: unknown }).vscode !== "undefined") {
    return (window as unknown as { vscode: { postMessage: (msg: unknown) => void } }).vscode;
  }
  return (
    window as unknown as {
      acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
    }
  ).acquireVsCodeApi();
}

// Bridge event listeners
window.addEventListener("champ:mcpMarketplaceOpen", () => {
  isOpenSignal.value = true;
  isLoadingSignal.value = true;
  entriesSignal.value = [];
  installedNamesSignal.value = new Set();
  installErrorsSignal.value = new Map();
  searchQuerySignal.value = "";
  getVsCode().postMessage({ type: "fetchMcpMarketplace" });
});

window.addEventListener("champ:mcpMarketplaceEntries", (e: Event) => {
  const msg = (e as CustomEvent<{ entries: McpMarketplaceEntry[] }>).detail;
  if (Array.isArray(msg.entries)) {
    entriesSignal.value = msg.entries;
  }
  isLoadingSignal.value = false;
});

window.addEventListener("champ:mcpMarketplaceInstallComplete", (e: Event) => {
  const msg = (e as CustomEvent<{ name: string; success: boolean; errorMessage?: string }>).detail;
  if (msg.success) {
    const next = new Set(installedNamesSignal.value);
    next.add(msg.name);
    installedNamesSignal.value = next;
  } else {
    const next = new Map(installErrorsSignal.value);
    next.set(msg.name, msg.errorMessage ?? "Installation failed");
    installErrorsSignal.value = next;
  }
});

function TagChip({ tag }: { tag: string }): JSX.Element {
  return (
    <span
      style="display:inline-block; padding:1px 6px; margin:1px 2px; border-radius:10px;
             font-size:10px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground);"
    >
      {tag}
    </span>
  );
}

function ServerCard({ entry }: { entry: McpMarketplaceEntry }): JSX.Element {
  const isInstalled = installedNamesSignal.value.has(entry.name);
  const errorMsg = installErrorsSignal.value.get(entry.name);

  function handleInstall(): void {
    getVsCode().postMessage({ type: "mcpMarketplaceInstall", entry });
  }

  return (
    <div
      style="border:1px solid var(--vscode-panel-border); border-radius:6px;
             padding:10px 12px; background:var(--vscode-editor-background);
             display:flex; flex-direction:column; gap:6px;"
    >
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:13px; font-weight:600;">{entry.name}</span>
        <span
          style="font-size:10px; padding:1px 5px; border-radius:3px;
                 background:var(--vscode-badge-background); color:var(--vscode-badge-foreground);"
        >
          {entry.transport}
        </span>
      </div>
      <p style="margin:0; font-size:12px; color:var(--vscode-descriptionForeground); line-height:1.4;">
        {entry.description}
      </p>
      <div style="display:flex; flex-wrap:wrap; gap:2px;">
        {entry.tags.map((tag) => (
          <TagChip key={tag} tag={tag} />
        ))}
      </div>
      {errorMsg && (
        <p style="margin:0; font-size:11px; color:var(--vscode-inputValidation-errorForeground);">
          Error: {errorMsg}
        </p>
      )}
      <button
        onClick={isInstalled ? undefined : handleInstall}
        disabled={isInstalled}
        style={`margin-top:4px; padding:4px 10px; cursor:${isInstalled ? "default" : "pointer"};
                background:${isInstalled ? "transparent" : "var(--vscode-button-background)"};
                color:${isInstalled ? "var(--vscode-terminal-ansiGreen)" : "var(--vscode-button-foreground)"};
                border:${isInstalled ? "1px solid var(--vscode-terminal-ansiGreen)" : "none"};
                border-radius:3px; font-size:12px;`}
      >
        {isInstalled ? "Installed ✓" : "Install"}
      </button>
    </div>
  );
}

/** Main McpMarketplacePanel component. Renders nothing when closed. */
export function McpMarketplacePanel(): JSX.Element | null {
  if (!isOpenSignal.value) return null;

  function handleClose(): void {
    isOpenSignal.value = false;
  }

  function handleSearchInput(e: Event): void {
    searchQuerySignal.value = (e.target as HTMLInputElement).value;
  }

  const filtered = filteredEntriesSignal.value;

  return (
    <div
      style="position:fixed; inset:0; z-index:200;
             background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center;"
      onClick={(e: MouseEvent) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        style="background:var(--vscode-sideBar-background); border-radius:8px;
               width:min(640px,90vw); max-height:80vh; display:flex; flex-direction:column;
               overflow:hidden; box-shadow:0 8px 32px rgba(0,0,0,0.5);"
      >
        {/* Header */}
        <div
          style="display:flex; justify-content:space-between; align-items:center;
                 padding:12px 16px; background:var(--vscode-titleBar-activeBackground);
                 flex-shrink:0;"
        >
          <span style="font-size:14px; font-weight:700;">MCP Server Marketplace</span>
          <button
            onClick={handleClose}
            style="background:none; border:none; cursor:pointer;
                   color:var(--vscode-icon-foreground); font-size:18px; line-height:1;"
            aria-label="Close marketplace"
          >
            ×
          </button>
        </div>

        {/* Search */}
        <div style="padding:10px 16px; flex-shrink:0;">
          <input
            type="text"
            placeholder="Search servers…"
            value={searchQuerySignal.value}
            onInput={handleSearchInput}
            style="width:100%; box-sizing:border-box; padding:6px 10px;
                   background:var(--vscode-input-background); color:var(--vscode-input-foreground);
                   border:1px solid var(--vscode-input-border); border-radius:4px; font-size:13px;"
          />
        </div>

        {/* Content */}
        <div style="overflow-y:auto; padding:0 16px 16px; flex:1;">
          {isLoadingSignal.value && (
            <p style="text-align:center; color:var(--vscode-descriptionForeground); padding:24px 0;">
              Loading marketplace…
            </p>
          )}

          {!isLoadingSignal.value && filtered.length === 0 && (
            <p style="text-align:center; color:var(--vscode-descriptionForeground); padding:24px 0;">
              {searchQuerySignal.value
                ? "No servers match your search."
                : "No servers available."}
            </p>
          )}

          {!isLoadingSignal.value && filtered.length > 0 && (
            <div
              style="display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px;"
            >
              {filtered.map((entry) => (
                <ServerCard key={entry.name} entry={entry} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

---

## Task 9: Create `webview-ui/src/index.tsx`

- [ ] Create `webview-ui/src/index.tsx`:

```tsx
// webview-ui/src/index.tsx — Preact app entry point
import { render } from "preact";
import { DiffOverlayPanel } from "./components/DiffOverlayPanel";
import { AgentGraphPanel } from "./components/AgentGraphPanel";
import { McpMarketplacePanel } from "./components/McpMarketplacePanel";

function App(): JSX.Element {
  return (
    <>
      <DiffOverlayPanel />
      <AgentGraphPanel />
      <McpMarketplacePanel />
    </>
  );
}

const root = document.getElementById("champ-panels");
if (root) {
  render(<App />, root);
}
```

---

## Task 10: Build and verify `webview-ui/dist/components.js`

- [ ] Run the build:
  ```bash
  node esbuild.webview.mjs --production
  ```
  Expected output:
  ```
  [esbuild.webview] Build complete → webview-ui/dist/components.js
  ```

- [ ] Verify the file is non-empty:
  ```bash
  test -s webview-ui/dist/components.js && echo "OK: components.js is non-empty" || echo "FAIL: empty"
  ```
  Expected: `OK: components.js is non-empty`

---

## Task 11: Inject `components.js` into `ChatViewProvider.renderHtml()`

- [ ] Open `src/ui/chat-view-provider.ts`. In `renderHtml()`, find the block that computes `scriptUri`:

```typescript
    let scriptUri = "";
    let styleUri = "";
    let codiconUri = "";
    try {
      const scriptPath = vscode.Uri.joinPath(
        this.extensionUri,
        "webview-ui",
        "dist",
        "main.js",
      );
```

Add `componentsUri` computation inside the same `try` block, after `scriptUri` is set:

```typescript
      // (after scriptUri = webview.asWebviewUri(scriptPath).toString();)
      const componentsPath = vscode.Uri.joinPath(
        this.extensionUri,
        "webview-ui",
        "dist",
        "components.js",
      );
      const componentsUri = webview.asWebviewUri(componentsPath).toString();
```

- [ ] Update the HTML template string (currently ends with):

```typescript
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
```

Change to:

```typescript
<body>
  <div id="app"></div>
  <div id="champ-panels"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${componentsUri}"></script>
</body>
```

**Note:** `componentsUri` is declared inside the `try` block but used in the template string outside it. Move the `let componentsUri = "";` declaration before the `try` block (alongside `scriptUri`, `styleUri`, `codiconUri`) and assign inside the `try`.

The full updated variable declarations become:

```typescript
    let scriptUri = "";
    let styleUri = "";
    let codiconUri = "";
    let componentsUri = "";
    try {
      const scriptPath = vscode.Uri.joinPath(
        this.extensionUri, "webview-ui", "dist", "main.js",
      );
      const componentsPath = vscode.Uri.joinPath(
        this.extensionUri, "webview-ui", "dist", "components.js",
      );
      const stylePath = vscode.Uri.joinPath(
        this.extensionUri, "webview-ui", "dist", "main.css",
      );
      const codiconPath = vscode.Uri.joinPath(
        this.extensionUri, "webview-ui", "dist", "codicons", "codicon.css",
      );
      scriptUri = webview.asWebviewUri(scriptPath).toString();
      componentsUri = webview.asWebviewUri(componentsPath).toString();
      styleUri = webview.asWebviewUri(stylePath).toString();
      codiconUri = webview.asWebviewUri(codiconPath).toString();
    } catch {
      // Test environment — leave URIs empty.
    }
```

---

## Task 12: Add bridge dispatches to `webview-ui/dist/main.js`

The `editSummary` case is at line 1930 of `main.js`. The existing block ends at line 1995 with `break;`.

- [ ] In `main.js`, find the `case 'editSummary': {` block. The block currently ends with:

```javascript
        messagesWrapper.appendChild(panel);
        messagesWrapper.scrollTop = messagesWrapper.scrollHeight;
        break;
      }
```

Add the CustomEvent dispatch **after** the existing rendering code, before `break;`:

```javascript
        // Bridge to Preact DiffOverlayPanel
        window.dispatchEvent(new CustomEvent('champ:editSummary', { detail: msg }));
```

The updated end of the `case 'editSummary':` block:

```javascript
        messagesWrapper.appendChild(panel);
        messagesWrapper.scrollTop = messagesWrapper.scrollHeight;
        // Bridge to Preact DiffOverlayPanel
        window.dispatchEvent(new CustomEvent('champ:editSummary', { detail: msg }));
        break;
      }
```

- [ ] Add three new cases after `case 'autoContextNotice':` (around line 1996). Find the closing `}` of `case 'autoContextNotice':` and add immediately after:

```javascript
      case 'mcpMarketplaceOpen':
        window.dispatchEvent(new CustomEvent('champ:mcpMarketplaceOpen', { detail: msg }));
        break;
      case 'mcpMarketplaceEntries':
        window.dispatchEvent(new CustomEvent('champ:mcpMarketplaceEntries', { detail: msg }));
        break;
      case 'mcpMarketplaceInstallComplete':
        window.dispatchEvent(new CustomEvent('champ:mcpMarketplaceInstallComplete', { detail: msg }));
        break;
      case 'teamRunSnapshot':
        window.dispatchEvent(new CustomEvent('champ:teamUpdate', { detail: msg }));
        break;
```

---

## Task 13: Add new message types to `src/ui/messages.ts`

- [ ] Import `McpMarketplaceEntry` and `TeamRunState` at the top of `src/ui/messages.ts` (they are already defined in other files):

```typescript
import type { McpMarketplaceEntry } from "../marketplace/mcp-marketplace-client";
import type { TeamRunState } from "../agent/team-definition";
```

- [ ] Add 4 new extension-to-webview message interfaces after `AutoContextNoticeMessage`:

```typescript
export interface McpMarketplaceOpenMessage {
  type: "mcpMarketplaceOpen";
}

export interface McpMarketplaceEntriesMessage {
  type: "mcpMarketplaceEntries";
  entries: McpMarketplaceEntry[];
}

export interface McpMarketplaceInstallCompleteMessage {
  type: "mcpMarketplaceInstallComplete";
  name: string;
  success: boolean;
  errorMessage?: string;
}

export interface TeamRunSnapshotMessage {
  type: "teamRunSnapshot";
  state: TeamRunState;
}
```

- [ ] Add them to `ExtensionToWebviewMessage` union:

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
  | McpMarketplaceOpenMessage          // NEW
  | McpMarketplaceEntriesMessage       // NEW
  | McpMarketplaceInstallCompleteMessage // NEW
  | TeamRunSnapshotMessage;             // NEW
```

- [ ] Add 5 new webview-to-extension message interfaces after `RevertAllEditsRequest`:

```typescript
export interface FetchMcpMarketplaceRequest {
  type: "fetchMcpMarketplace";
}

export interface McpMarketplaceInstallRequest {
  type: "mcpMarketplaceInstall";
  entry: McpMarketplaceEntry;
}

export interface AcceptHunkAtLineRequest {
  type: "acceptHunkAtLine";
  filePath: string;
  line: number;
}

export interface RejectHunkAtLineRequest {
  type: "rejectHunkAtLine";
  filePath: string;
  line: number;
}

export interface FocusTeamAgentRequest {
  type: "focusTeamAgent";
  agentId: string;
}
```

- [ ] Add them to `WebviewToExtensionMessage` union:

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
  | RevertAllEditsRequest
  | FetchMcpMarketplaceRequest        // NEW
  | McpMarketplaceInstallRequest      // NEW
  | AcceptHunkAtLineRequest           // NEW
  | RejectHunkAtLineRequest           // NEW
  | FocusTeamAgentRequest;            // NEW
```

---

## Task 14: Handle new webview messages in `ChatViewProvider`

- [ ] In `src/ui/chat-view-provider.ts`, find `handleWebviewMessage()`. Add handlers for the new message types after the existing `case "revertAllEdits":`:

```typescript
case "fetchMcpMarketplace": {
  // Fetch the MCP manifest and send entries back to webview
  void (async () => {
    const { McpMarketplaceClient } = await import(
      "../marketplace/mcp-marketplace-client"
    );
    const client = new McpMarketplaceClient();
    const entries = await client.fetchManifest();
    this.postMessage({ type: "mcpMarketplaceEntries", entries });
  })();
  break;
}

case "mcpMarketplaceInstall": {
  // Delegate to champ.browseMcpServers install flow via command
  // The command handles QuickPick for install target + env vars.
  void vscode.commands.executeCommand("champ.browseMcpServers");
  break;
}

case "acceptHunkAtLine": {
  // Forward to DiffOverlayController if available
  const req = msg as import("../ui/messages").AcceptHunkAtLineRequest;
  (this as unknown as { diffOverlayController?: import("./diff-overlay-controller").DiffOverlayController }).diffOverlayController?.acceptHunkAtLine(req.filePath, req.line);
  break;
}

case "rejectHunkAtLine": {
  const req = msg as import("../ui/messages").RejectHunkAtLineRequest;
  (this as unknown as { diffOverlayController?: import("./diff-overlay-controller").DiffOverlayController }).diffOverlayController?.rejectHunkAtLine(req.filePath, req.line);
  break;
}

case "focusTeamAgent": {
  // No-op in Sprint 4 — wired to TeamPanel in Sprint 5+
  break;
}
```

---

## Task 15: Update `.vscodeignore`

- [ ] Open `.vscodeignore` and add:

```
webview-ui/src/**
```

This excludes the TypeScript source from the VSIX package — only the built `components.js` is needed.

---

## Task 16: Compile check, build, test

- [ ] TypeScript compile check (extension host only — no TS in webview-ui/src):
  ```bash
  npx tsc --noEmit 2>&1 | head -40
  ```
  Expected: zero errors.

- [ ] Full build (extension + webview):
  ```bash
  npm run compile
  ```
  Expected: both `dist/extension.js` and `webview-ui/dist/components.js` produced.

- [ ] Build pipeline smoke test:
  ```bash
  npm run build:webview && test -s webview-ui/dist/components.js && echo "PASS" || echo "FAIL"
  ```
  Expected: `PASS`

- [ ] Run vitest:
  ```bash
  npx vitest run
  ```
  Expected: all existing tests pass. (Preact component tests are deferred — see Task 17.)

---

## Task 17: Create Preact component tests

- [ ] Create `webview-ui/src/test/` directory.

- [ ] Create `webview-ui/src/test/components.test.tsx`:

```tsx
// webview-ui/src/test/components.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { h } from "preact";

// Mock vscode API
const mockPostMessage = vi.fn();
beforeEach(() => {
  (window as unknown as Record<string, unknown>).vscode = { postMessage: mockPostMessage };
  mockPostMessage.mockClear();
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).vscode;
});

// ─── splitHunks tests ────────────────────────────────────────────────────────

import { splitHunks } from "../utils/diff";

describe("splitHunks", () => {
  it("returns empty array for identical content", () => {
    expect(splitHunks("same\ncontent", "same\ncontent")).toEqual([]);
  });

  it("returns one hunk for a single-line change", () => {
    const hunks = splitHunks("line1\nold\nline3", "line1\nnew\nline3");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].removedLines).toEqual(["old"]);
    expect(hunks[0].addedLines).toEqual(["new"]);
  });

  it("removedLines contains old content, addedLines contains new content", () => {
    const hunks = splitHunks("a\nb", "a\nc");
    expect(hunks[0].removedLines).toContain("b");
    expect(hunks[0].addedLines).toContain("c");
  });

  it("two disjoint changes produce two hunks", () => {
    const hunks = splitHunks("a\nb\nc\nd\ne", "A\nb\nc\nd\nE");
    expect(hunks).toHaveLength(2);
  });
});

// ─── DiffOverlayPanel tests ──────────────────────────────────────────────────

import { DiffOverlayPanel, editsSignal } from "../components/DiffOverlayPanel";

describe("DiffOverlayPanel", () => {
  beforeEach(() => {
    editsSignal.value = [];
  });

  it("renders nothing when edits signal is empty", () => {
    const { container } = render(<DiffOverlayPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders file count label when edits has entries", () => {
    editsSignal.value = [
      { path: "src/foo.ts", oldContent: "old", newContent: "new" },
    ];
    render(<DiffOverlayPanel />);
    expect(screen.getByText(/Champ Edits \(1 file\)/)).toBeTruthy();
  });

  it("Accept All button calls vscode.postMessage with { type: 'acceptAllEdits' }", () => {
    editsSignal.value = [
      { path: "src/foo.ts", oldContent: "old", newContent: "new" },
    ];
    render(<DiffOverlayPanel />);
    const btn = screen.getByText(/Accept All/);
    fireEvent.click(btn);
    expect(mockPostMessage).toHaveBeenCalledWith({ type: "acceptAllEdits" });
  });

  it("Reject All button calls vscode.postMessage with { type: 'revertAllEdits' }", () => {
    editsSignal.value = [
      { path: "src/bar.ts", oldContent: "a\nb", newContent: "a\nc" },
    ];
    render(<DiffOverlayPanel />);
    const btn = screen.getByText(/Reject All/);
    fireEvent.click(btn);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "revertAllEdits" }),
    );
  });
});

// ─── AgentGraphPanel tests ───────────────────────────────────────────────────

import { AgentGraphPanel, teamStateSignal } from "../components/AgentGraphPanel";
import type { TeamRunState, TeamAgentRunState } from "../types";

const MOCK_AGENT: TeamAgentRunState = {
  id: "agent-1",
  name: "Test Agent",
  status: "running",
  output: "",
  tokenCount: 100,
  validationWarnings: [],
  retryCount: 0,
};

const MOCK_TEAM_STATE: TeamRunState = {
  runId: "run-1",
  teamName: "Test Team",
  userRequest: "Do something",
  status: "running",
  agents: [MOCK_AGENT],
  sharedMemorySnapshot: {},
  startTime: Date.now(),
  totalTokens: 100,
  filesChanged: [],
  mode: "auto",
};

describe("AgentGraphPanel", () => {
  beforeEach(() => {
    teamStateSignal.value = null;
  });

  it("renders nothing when teamState is null", () => {
    const { container } = render(<AgentGraphPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders SVG node for each agent when teamState is set", () => {
    teamStateSignal.value = MOCK_TEAM_STATE;
    const { container } = render(<AgentGraphPanel />);
    const svgEl = container.querySelector("svg");
    expect(svgEl).toBeTruthy();
    expect(screen.getByText("Test Agent")).toBeTruthy();
  });

  it("agent node shows 'running' status text", () => {
    teamStateSignal.value = MOCK_TEAM_STATE;
    render(<AgentGraphPanel />);
    // Status text includes "running" and possibly "●"
    const statusEl = screen.getByText(/running/);
    expect(statusEl).toBeTruthy();
  });

  it("clicking a node calls vscode.postMessage with { type: 'focusTeamAgent', agentId }", () => {
    teamStateSignal.value = MOCK_TEAM_STATE;
    const { container } = render(<AgentGraphPanel />);
    const nodeGroup = container.querySelector("g[style*='cursor:pointer']");
    if (nodeGroup) fireEvent.click(nodeGroup);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "focusTeamAgent", agentId: "agent-1" }),
    );
  });
});

// ─── McpMarketplacePanel tests ───────────────────────────────────────────────

import {
  McpMarketplacePanel,
  isOpenSignal,
  entriesSignal,
} from "../components/McpMarketplacePanel";
import type { McpMarketplaceEntry } from "../types";

const MOCK_ENTRY: McpMarketplaceEntry = {
  name: "sqlite",
  description: "Query SQLite databases",
  author: "anthropics",
  url: "https://example.com",
  transport: "stdio",
  command: "uvx",
  args: ["mcp-server-sqlite"],
  tags: ["database", "sql"],
};

describe("McpMarketplacePanel", () => {
  beforeEach(() => {
    isOpenSignal.value = false;
    entriesSignal.value = [];
  });

  it("renders nothing when isOpen is false", () => {
    const { container } = render(<McpMarketplacePanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders after champ:mcpMarketplaceOpen event fires", () => {
    isOpenSignal.value = true;
    entriesSignal.value = [MOCK_ENTRY];
    render(<McpMarketplacePanel />);
    expect(screen.getByText("MCP Server Marketplace")).toBeTruthy();
  });

  it("Install button calls vscode.postMessage with { type: 'mcpMarketplaceInstall', entry }", () => {
    isOpenSignal.value = true;
    entriesSignal.value = [MOCK_ENTRY];
    render(<McpMarketplacePanel />);
    const installBtn = screen.getByText("Install");
    fireEvent.click(installBtn);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mcpMarketplaceInstall", entry: MOCK_ENTRY }),
    );
  });

  it("search query filters entries by name", () => {
    isOpenSignal.value = true;
    entriesSignal.value = [
      MOCK_ENTRY,
      {
        name: "postgres",
        description: "PostgreSQL queries",
        author: "anthropics",
        url: "https://example.com",
        transport: "stdio",
        command: "npx",
        args: [],
        tags: ["database"],
      },
    ];
    render(<McpMarketplacePanel />);
    const searchInput = screen.getByPlaceholderText("Search servers…");
    fireEvent.input(searchInput, { target: { value: "sqlite" } });
    // Only sqlite should be visible
    expect(screen.queryByText("postgres")).toBeNull();
    expect(screen.getByText("sqlite")).toBeTruthy();
  });

  it("search query filters entries by tag", () => {
    isOpenSignal.value = true;
    entriesSignal.value = [
      MOCK_ENTRY,
      {
        name: "brave-search",
        description: "Web search",
        author: "anthropics",
        url: "https://example.com",
        transport: "stdio",
        command: "npx",
        args: [],
        tags: ["search", "web"],
      },
    ];
    render(<McpMarketplacePanel />);
    const searchInput = screen.getByPlaceholderText("Search servers…");
    fireEvent.input(searchInput, { target: { value: "web" } });
    expect(screen.queryByText("sqlite")).toBeNull();
    expect(screen.getByText("brave-search")).toBeTruthy();
  });
});
```

- [ ] Add vitest config to handle `.tsx` files. Check `vitest.config.ts` or `vitest.config.mts` at root. If the test environment is `jsdom`, it should work. If not, add a `webview-ui/vitest.config.ts`:

```typescript
// webview-ui/vitest.config.ts
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "jsdom",
    include: ["src/test/**/*.test.tsx"],
  },
});
```

- [ ] Run Preact component tests:
  ```bash
  npx vitest run --config webview-ui/vitest.config.ts
  ```
  Expected: all 17 tests pass (4 splitHunks + 4 DiffOverlayPanel + 4 AgentGraphPanel + 5 McpMarketplacePanel).

---

## Task 18: Version bump, full package, commit

- [ ] Version bump:
  ```bash
  npm version patch --no-git-tag-version
  ```

- [ ] Full compile (extension + webview):
  ```bash
  npm run compile
  ```

- [ ] Package VSIX:
  ```bash
  npx vsce package --no-dependencies
  ```
  Expected: `champ-*.vsix` produced without errors.

- [ ] Commit:
  ```bash
  git add \
    esbuild.webview.mjs \
    webview-ui/src/types.ts \
    webview-ui/src/index.tsx \
    webview-ui/src/utils/diff.ts \
    webview-ui/src/components/DiffOverlayPanel.tsx \
    webview-ui/src/components/AgentGraphPanel.tsx \
    webview-ui/src/components/McpMarketplacePanel.tsx \
    webview-ui/src/test/components.test.tsx \
    webview-ui/dist/components.js \
    src/ui/chat-view-provider.ts \
    src/ui/messages.ts \
    webview-ui/dist/main.js \
    package.json \
    package-lock.json \
    .vscodeignore

  git commit -m "feat: incremental Preact webview — DiffOverlayPanel, AgentGraphPanel, McpMarketplacePanel alongside vanilla JS"
  ```

---

## Key Decisions

1. **`acquireVsCodeApi()` is only called once per webview** — `main.js` calls it first and sets `window.vscode`. The Preact components read from `window.vscode` rather than calling `acquireVsCodeApi()` again. This avoids the "can only be called once" VS Code restriction.

2. **Module-level signals** — `editsSignal`, `teamStateSignal`, `isOpenSignal`, `entriesSignal` are declared at module scope (not inside components). This is the correct pattern for `@preact/signals` — signals live outside the component tree and components subscribe reactively.

3. **`components.js` uses `iife` format with `globalName: "ChampPanels"`** — this avoids module system conflicts with `main.js` (which is also an IIFE). The global name is available for debugging but not required by the application.

4. **The `editSummary` bridge dispatch is ADDITIVE** — the existing vanilla-JS rendering in `main.js` is NOT removed. Both render in parallel (vanilla in `#app`, Preact in `#champ-panels`). The spec states "existing handling remains in place" for Sprint 4. Full removal of vanilla rendering is Sprint 5+.

5. **`webview-ui/src/` TypeScript does NOT go through `tsconfig.json`** — it is compiled exclusively by `esbuild.webview.mjs`. If the root `tsconfig.json` includes `webview-ui/src/**`, it must be excluded to avoid type errors from Preact JSX in the extension host compilation. Add `"exclude": ["webview-ui/src/**"]` to `tsconfig.json` if needed.

6. **`TeamRunState.agents` in the webview does not include `dependsOn`** — `TeamAgentRunState` has no `dependsOn` field. The `AgentGraphPanel` builds an empty `dependsOnMap` and falls back to flat horizontal layout. Including `dependsOn` in the snapshot is a Sprint 5 concern.

7. **`mcpMarketplaceInstall` from the webview delegating to `champ.browseMcpServers`** — the command shows QuickPicks for the install target and env vars. A cleaner Sprint 5 improvement would be to pass the pre-selected entry and skip the server-selection QuickPick. For Sprint 4, the delegation is sufficient.
