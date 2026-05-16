# Spec: Incremental Preact

**Date**: 2026-05-16
**Sprint**: 4

---

## Goal

Introduce a Preact build pipeline alongside the existing vanilla JS webview, mounting three new panel components (`<DiffOverlayPanel>`, `<AgentGraphPanel>`, `<McpMarketplacePanel>`) in a dedicated `<div id="champ-panels">` that is isolated from the vanilla JS `#app` div.

---

## Architecture

The webview runs two JavaScript runtimes side by side:

- **Vanilla JS** (`webview-ui/dist/main.js`): owns the `#app` div, handles all existing chat flow, approval, streaming, and MCP panel logic. This file is not restructured in this sprint. All existing message handlers in `main.js` remain in place.
- **Preact** (`webview-ui/dist/components.js`): owns the `#champ-panels` div. Handles new complex panel UIs that require reactive state and component composition. Loaded via a second `<script>` tag after `main.js`.

**Communication boundary**: The two runtimes communicate exclusively through the existing `vscode.postMessage` protocol (extension host ↔ webview). They do not share JavaScript state, module instances, or direct DOM references across the `#app` / `#champ-panels` boundary. When `main.js` needs to notify the Preact app of a new message from the extension host, it dispatches a `CustomEvent` on `window`. The Preact app listens with `window.addEventListener`. This is a thin, one-directional bridge — Preact may also call `vscode.postMessage()` directly without routing through `main.js`.

No shared state objects. No direct DOM manipulation of `#champ-panels` by `main.js`. No direct DOM manipulation of `#app` by Preact components.

---

## Build Pipeline

### New File: `esbuild.webview.mjs`

Located at repository root (`/home/dk/Documents/git/vs-code-plugin/esbuild.webview.mjs`).

```javascript
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

### npm Scripts

Add to `package.json`'s `"scripts"` object:

```json
"build:webview": "node esbuild.webview.mjs --production",
"watch:webview": "node esbuild.webview.mjs --watch"
```

Update the existing `"compile"` script to include the webview build. Current `compile` script (assumed to be `"node esbuild.mjs --production"`) becomes:

```json
"compile": "node esbuild.mjs --production && node esbuild.webview.mjs --production"
```

The existing `esbuild.mjs` (which bundles the extension host to `dist/extension.js`) is not modified.

### DevDependencies to Add

Add to `package.json`'s `"devDependencies"`:

```json
"preact": "^10.25.0",
"@preact/signals": "^1.3.0",
"@testing-library/preact": "^3.2.4"
```

Install command: `npm install --save-dev preact@^10 @preact/signals@^1 @testing-library/preact@^3`

### Directory Structure (new files only)

```
webview-ui/
  src/
    index.tsx                         ← Preact app entry point
    components/
      DiffOverlayPanel.tsx
      AgentGraphPanel.tsx
      McpMarketplacePanel.tsx
    utils/
      diff.ts                         ← Pure diff logic (no DOM)
  dist/
    components.js                     ← Built output (gitignored or committed per current convention)
esbuild.webview.mjs                   ← New build script
```

---

## HTML Integration

### Changes to `ChatViewProvider.renderHtml()`

Two additions to the HTML string returned by the `renderHtml()` method in `src/ui/chat-view-provider.ts`:

**1. Add `<div id="champ-panels"></div>` before `</body>`:**

```html
    <div id="champ-panels"></div>
    <script nonce="${nonce}" src="${componentsUri}"></script>
  </body>
```

**2. Compute `componentsUri`** — add this line alongside the existing `scriptUri` computation:

```typescript
const componentsUri = webview.asWebviewUri(
  vscode.Uri.joinPath(this._extensionUri, "webview-ui", "dist", "components.js"),
);
```

`localResourceRoots` already includes `vscode.Uri.joinPath(this._extensionUri, ...)` so no change is needed there.

### Preact App Mount (`webview-ui/src/index.tsx`)

```tsx
import { render } from "preact";
import { DiffOverlayPanel } from "./components/DiffOverlayPanel";
import { AgentGraphPanel } from "./components/AgentGraphPanel";
import { McpMarketplacePanel } from "./components/McpMarketplacePanel";

function App() {
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

All three components are always mounted but render nothing until they receive a relevant `CustomEvent` via `window.addEventListener`. They self-show/hide based on their internal signal state.

---

## Message Bridge

`main.js` receives messages from the extension host via `window.addEventListener("message", handler)`. For three specific message types, `main.js` dispatches a `CustomEvent` on `window` in addition to (or instead of) its existing handling. These are one-line additions per event type in the existing `message` event handler switch/if-block.

### Bridge additions to `webview-ui/dist/main.js`

In the `case "editSummary":` handler, after the existing handling code, add:

```javascript
window.dispatchEvent(new CustomEvent("champ:editSummary", { detail: message }));
```

Add a new `case "mcpMarketplaceOpen":` that only dispatches (no existing handling):

```javascript
case "mcpMarketplaceOpen":
  window.dispatchEvent(new CustomEvent("champ:mcpMarketplaceOpen", { detail: message }));
  break;
```

Add a new `case "mcpMarketplaceEntries":` that only dispatches:

```javascript
case "mcpMarketplaceEntries":
  window.dispatchEvent(new CustomEvent("champ:mcpMarketplaceEntries", { detail: message }));
  break;
```

**Note**: `main.js` is the compiled output in `webview-ui/dist/main.js`. Its source (if separate) must be updated instead. If `main.js` is a build artifact from a separate source file, the bridge additions go in that source file. If `main.js` is hand-written, edit it directly.

**`teamUpdate` for `<AgentGraphPanel>`**: `teamUpdate` messages are sent by `TeamPanel` (a separate `vscode.WebviewPanel`) to the team panel's own webview — not to the chat sidebar webview. To deliver `TeamRunState` to `<AgentGraphPanel>` in the chat sidebar, the extension host must forward a copy of each `TeamRunState` snapshot to the chat webview as a new message type `teamRunSnapshot`. `ChatViewProvider` receives team run events via `TeamRunner.runWithMemory()`'s `onEvent` callback and sends `{ type: "teamRunSnapshot", state: TeamRunState }` to its own webview. `main.js` then bridges this to the Preact app:

```javascript
case "teamRunSnapshot":
  window.dispatchEvent(new CustomEvent("champ:teamUpdate", { detail: message }));
  break;
```

`teamRunSnapshot` is added to `src/ui/messages.ts` as a new `ExtensionToWebviewMessage` type:

```typescript
export interface TeamRunSnapshotMessage {
  type: "teamRunSnapshot";
  state: TeamRunState;  // imported from src/agent/team-definition.ts
}
```

---

## Component 1 — `<DiffOverlayPanel>`

**File**: `webview-ui/src/components/DiffOverlayPanel.tsx`

### Data Flow

Receives `editSummary` messages via `window` event `"champ:editSummary"`. The message shape matches `EditSummaryMessage` from `src/ui/messages.ts`:

```typescript
interface EditSummaryMessage {
  type: "editSummary";
  edits: Array<{ path: string; oldContent: string; newContent: string }>;
}
```

### State (using `@preact/signals`)

```typescript
import { signal, computed } from "@preact/signals";

const edits = signal<EditSummaryMessage["edits"]>([]);
const isVisible = computed(() => edits.value.length > 0);
```

### Rendering

When `isVisible` is `true`, renders a panel below the chat:

```
┌──────────────────────────────────────────────────┐
│ Champ Edits (N files)          [Accept All] [Reject All] │
├──────────────────────────────────────────────────┤
│ src/foo.ts                                        │
│   Hunk 1/2  [Accept] [Reject]                    │
│   - old line                                     │
│   + new line                                     │
│ src/bar.ts                                       │
│   ...                                            │
└──────────────────────────────────────────────────┘
```

Per-hunk controls call `splitHunks()` from `webview-ui/src/utils/diff.ts`.

### Actions

- "Accept All" button → `vscode.postMessage({ type: "acceptAllEdits" })` (existing message type in `src/ui/messages.ts`: `AcceptAllEditsRequest`)
- "Reject All" button → `vscode.postMessage({ type: "revertAllEdits" })` (existing: `RevertAllEditsRequest`)
- Per-hunk "Accept" → `vscode.postMessage({ type: "acceptHunkAtLine", filePath, line })` (new message type, added to `messages.ts`)
- Per-hunk "Reject" → `vscode.postMessage({ type: "rejectHunkAtLine", filePath, line })` (new message type)

### Replaces existing `editSummary` handler in `main.js`

The existing `case "editSummary":` code in `main.js` renders the edit summary into the `#app` div. After the bridge dispatch is added, that rendering code becomes a no-op (it is wrapped in `if (false)` or removed, so the Preact component exclusively owns the editSummary display). The dispatch line remains.

### `webview-ui/src/utils/diff.ts`

Pure TypeScript module — no DOM, no VS Code API, no Preact imports.

```typescript
export interface WebviewHunk {
  index: number;
  removedLines: string[];
  addedLines: string[];
  /** 0-based start line in the new document. */
  newDocStartLine: number;
}

export function splitHunks(oldContent: string, newContent: string): WebviewHunk[];
```

`splitHunks` implements the same Myers diff algorithm as `computeHunks` in `src/ui/diff-overlay-controller.ts`. This is a copy-paste-and-adapt — it is pure TypeScript with no VS Code types, so it can run in both the webview and unit tests.

---

## Component 2 — `<AgentGraphPanel>`

**File**: `webview-ui/src/components/AgentGraphPanel.tsx`

### Data Flow

Receives `champ:teamUpdate` CustomEvents dispatched by the `main.js` bridge when the extension host sends a `teamRunSnapshot` message. The message carries `TeamRunState` (matching `src/agent/team-definition.ts: TeamRunState`) serialized as JSON. The extension host sends `teamRunSnapshot` from `ChatViewProvider` by forwarding team run events received via `TeamRunner.runWithMemory()`'s `onEvent` callback.

### State

```typescript
const teamState = signal<TeamRunState | null>(null);
const isVisible = computed(() => teamState.value !== null);
```

### Rendering

Renders a live DAG using Preact + inline SVG. Layout algorithm: top-to-bottom BFS layering (same level = same group). Node width: 160px. Node height: 48px. Horizontal gap: 40px. Vertical gap: 60px. SVG dimensions computed from node count and layout.

Each node renders as a `<rect>` + `<text>` pair inside the SVG:

```tsx
<rect
  width={160} height={48}
  rx={6} ry={6}
  fill={statusToFill(agent.status)}
  stroke={statusToStroke(agent.status)}
/>
<text x={80} y={20} textAnchor="middle" fill="var(--vscode-editor-foreground)">
  {agent.name}
</text>
<text x={80} y={36} textAnchor="middle" fontSize={11} fill="var(--vscode-descriptionForeground)">
  {agent.status}
</text>
```

### Status Color Mapping

```typescript
function statusToFill(status: TeamAgentStatus): string {
  switch (status) {
    case "pending":  return "var(--vscode-badge-background)";
    case "running":  return "var(--vscode-progressBar-background)";
    case "done":     return "var(--vscode-terminal-ansiGreen)";
    case "failed":   return "var(--vscode-inputValidation-errorBackground)";
    case "skipped":  return "var(--vscode-disabledForeground)";
    case "blocked":  return "var(--vscode-inputValidation-warningBackground)";
  }
}

function statusToStroke(status: TeamAgentStatus): string {
  // Same as fill but 15% darker — achieved by using the corresponding border CSS variable:
  switch (status) {
    case "pending":  return "var(--vscode-badge-foreground)";
    case "running":  return "var(--vscode-focusBorder)";
    case "done":     return "var(--vscode-terminal-ansiGreen)";
    case "failed":   return "var(--vscode-inputValidation-errorBorder)";
    case "skipped":  return "var(--vscode-descriptionForeground)";
    case "blocked":  return "var(--vscode-inputValidation-warningBorder)";
  }
}
```

### Node Click

Clicking a node dispatches `vscode.postMessage({ type: "focusTeamAgent", agentId: agent.id })`. The extension host handles this by focusing that agent's output in the team panel (wiring to `TeamPanel` is Sprint 3+; for this sprint, the message is registered in `messages.ts` and the handler is a no-op in `extension.ts`).

### Long-term relationship with `renderDag()` in `team-panel.ts`

This component does NOT replace `renderDag()` in Sprint 4. The existing `renderDag()` function in `src/ui/team-panel.ts` remains active. The Preact `<AgentGraphPanel>` is wired to receive `teamUpdate` events but renders in `#champ-panels`, not in the team panel's own view. Full replacement of `renderDag()` is deferred to Sprint 5+.

---

## Component 3 — `<McpMarketplacePanel>`

**File**: `webview-ui/src/components/McpMarketplacePanel.tsx`

### Data Flow

Opens in response to `"champ:mcpMarketplaceOpen"` event (dispatched by `main.js` bridge from `mcpMarketplaceOpen` message from extension host). Sends `{ type: "fetchMcpMarketplace" }` to request entries. Receives entries via `"champ:mcpMarketplaceEntries"` event.

### State

```typescript
const isOpen = signal(false);
const entries = signal<McpMarketplaceEntry[]>([]);
const searchQuery = signal("");
const isLoading = signal(false);

const filteredEntries = computed(() => {
  const q = searchQuery.value.toLowerCase();
  if (!q) return entries.value;
  return entries.value.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
  );
});
```

`McpMarketplaceEntry` in the webview context is the same shape as `McpMarketplaceEntry` defined in `src/marketplace/mcp-marketplace-client.ts`, declared locally in `McpMarketplacePanel.tsx` (not imported from the extension host — webview has no access to host modules).

### Open Flow

1. `"champ:mcpMarketplaceOpen"` event fires → `isOpen.value = true`, `isLoading.value = true`.
2. Component sends `vscode.postMessage({ type: "fetchMcpMarketplace" })`.
3. Extension host fetches manifest and sends `{ type: "mcpMarketplaceEntries", entries: McpMarketplaceEntry[] }`.
4. `"champ:mcpMarketplaceEntries"` event fires → `entries.value = event.detail.entries`, `isLoading.value = false`.

### Rendering

A full-panel overlay (positioned fixed, covers `#champ-panels`) that renders:

```
┌──────────────────────────────────────────────────┐
│ MCP Server Marketplace              [×  Close]   │
│ ┌──────────────────────────────────────────────┐ │
│ │ 🔍 Search servers…                           │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ ┌────────────┐ ┌────────────┐ ┌────────────┐    │
│ │ sqlite     │ │ filesystem │ │ postgres   │    │
│ │ database   │ │ local      │ │ database   │    │
│ │ [Install]  │ │ [Install]  │ │ [Install]  │    │
│ └────────────┘ └────────────┘ └────────────┘    │
└──────────────────────────────────────────────────┘
```

Each card shows `entry.name`, `entry.description`, `entry.tags` as chips, `entry.transport` label, and an "Install" button.

### Install Action

Clicking "Install" sends:

```typescript
vscode.postMessage({
  type: "mcpMarketplaceInstall",
  entry: entry,  // full McpMarketplaceEntry object
});
```

The extension host handles `mcpMarketplaceInstall` in `ChatViewProvider` by delegating to the `champ.browseMcpServers` install flow (skipping the fetch step, starting at the QuickPick target-selection step). After install completes, the extension host sends `{ type: "mcpMarketplaceInstallComplete", name: entry.name, success: boolean, errorMessage?: string }` back to the webview. On success, the card shows a "Installed" badge. On failure, an error message appears below the card.

---

## New Message Types in `src/ui/messages.ts`

### Extension Host → Webview (add to `ExtensionToWebviewMessage` union)

```typescript
export interface McpMarketplaceOpenMessage {
  type: "mcpMarketplaceOpen";
}

export interface McpMarketplaceEntriesMessage {
  type: "mcpMarketplaceEntries";
  entries: McpMarketplaceEntry[];  // McpMarketplaceEntry imported from mcp-marketplace-client.ts
}

export interface McpMarketplaceInstallCompleteMessage {
  type: "mcpMarketplaceInstallComplete";
  name: string;
  success: boolean;
  errorMessage?: string;
}

/**
 * Forwarded snapshot of TeamRunState, sent by ChatViewProvider to the chat
 * sidebar webview. This is how <AgentGraphPanel> receives live team data —
 * the TeamPanel's own WebviewPanel is a separate webview and cannot share
 * messages with the chat sidebar directly.
 */
export interface TeamRunSnapshotMessage {
  type: "teamRunSnapshot";
  state: TeamRunState;  // imported from src/agent/team-definition.ts
}
```

### Webview → Extension Host (add to `WebviewToExtensionMessage` union)

```typescript
export interface FetchMcpMarketplaceRequest {
  type: "fetchMcpMarketplace";
}

export interface McpMarketplaceInstallRequest {
  type: "mcpMarketplaceInstall";
  entry: McpMarketplaceEntry;  // imported from mcp-marketplace-client.ts
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

All new types must be added to their respective discriminated union types (`ExtensionToWebviewMessage` and `WebviewToExtensionMessage`) in `src/ui/messages.ts`.

---

## Testing

### Unit Tests for Preact Components

New test file: `webview-ui/src/test/components.test.tsx`

Uses `@testing-library/preact`. Tests run via `npm test` (Jest or Vitest, whichever is already configured in the project).

**`<DiffOverlayPanel>`:**
1. Renders nothing when `edits` signal is empty.
2. Renders file count label when `edits` has entries.
3. "Accept All" button calls `vscode.postMessage` with `{ type: "acceptAllEdits" }`.
4. "Reject All" button calls `vscode.postMessage` with `{ type: "revertAllEdits" }`.

**`<AgentGraphPanel>`:**
5. Renders nothing when `teamState` is null.
6. Renders SVG node for each agent when `teamState` is set.
7. Agent node fill color matches `statusToFill("running")` when agent status is `"running"`.
8. Clicking a node calls `vscode.postMessage` with `{ type: "focusTeamAgent", agentId: ... }`.

**`<McpMarketplacePanel>`:**
9. Renders nothing when `isOpen` is `false`.
10. Renders after `"champ:mcpMarketplaceOpen"` event fires.
11. "Install" button calls `vscode.postMessage` with `{ type: "mcpMarketplaceInstall", entry: ... }`.
12. Search query filters entries by name.
13. Search query filters entries by tag.

**`splitHunks()` in `webview-ui/src/utils/diff.ts`:**
14. Returns empty array for identical content.
15. Returns one hunk for a single-line change.
16. `removedLines` contains old content, `addedLines` contains new content.
17. Two disjoint changes produce two hunks.

### Build Pipeline Test

Add to the CI/test script:

```bash
npm run build:webview && test -s webview-ui/dist/components.js
```

`test -s` asserts the file exists and is non-empty. This verifies the pipeline produces output without checking its contents.

---

## `.vscodeignore` Update

Add the following line to `.vscodeignore` to exclude Preact source from the VSIX package (only the built `components.js` is needed):

```
webview-ui/src/**
```

---

## Files

| File | Status | Change |
|---|---|---|
| `esbuild.webview.mjs` | New | esbuild config for Preact bundle |
| `webview-ui/src/index.tsx` | New | Preact app entry point, mounts all 3 components into `#champ-panels` |
| `webview-ui/src/components/DiffOverlayPanel.tsx` | New | Reactive edit review panel using `@preact/signals` |
| `webview-ui/src/components/AgentGraphPanel.tsx` | New | Live DAG visualizer using inline SVG |
| `webview-ui/src/components/McpMarketplacePanel.tsx` | New | Searchable MCP server grid with install flow |
| `webview-ui/src/utils/diff.ts` | New | Pure `splitHunks()` function, no DOM or VS Code API dependencies |
| `webview-ui/src/test/components.test.tsx` | New | Unit tests for all 3 components and `splitHunks()` |
| `src/ui/chat-view-provider.ts` | Modified | Add `componentsUri`, second `<script>` tag, `<div id="champ-panels">` in `renderHtml()` |
| `src/ui/messages.ts` | Modified | Add 5 new webview→host request types, 3 new host→webview message types (`McpMarketplaceOpenMessage`, `McpMarketplaceEntriesMessage`, `McpMarketplaceInstallCompleteMessage`), and `TeamRunSnapshotMessage`; add all to union types |
| `webview-ui/dist/main.js` | Modified | Add 4 `CustomEvent` dispatches in message handler (editSummary, mcpMarketplaceOpen, mcpMarketplaceEntries, teamUpdate) |
| `package.json` | Modified | Add `preact`, `@preact/signals`, `@testing-library/preact` to devDependencies; add `build:webview`, `watch:webview` scripts; update `compile` script |
| `.vscodeignore` | Modified | Add `webview-ui/src/**` |
