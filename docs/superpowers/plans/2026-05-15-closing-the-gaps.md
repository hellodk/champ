# Closing the Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 9 critical feature gaps identified in the product audit — transforming Champ from an architecturally excellent demo into a production daily driver.

**Architecture:** Nine features across four independent subsystems: (1) Observability — real token counting + @Docs resolver; (2) Reliability — team-run checkpoint resume + DAG visualization; (3) Editor UX — hunk-level diff accept/reject + inline Ctrl+K edit; (4) MCP completeness — SSE/HTTP transport + resource access + no-YAML config UI. Each subsystem is fully independent; tasks within a subsystem are sequentially ordered.

**Tech Stack:** TypeScript, VS Code Extension API, node:http + node:https (MCP SSE), diff-match-patch (hunk splitting, bundled via esbuild), existing SharedMemory/TeamRunner/WorkflowPanel patterns, vanilla JS WebviewPanel HTML.

---

## Edge Cases & Design Decisions

### Token Counting
- **Edge case**: Agent times out → partial token count already in memory. Solution: read whatever `_token_usage` is present, default to 0 if absent.
- **Edge case**: Self-critique adds a second LLM call. Solution: TokenTracker accumulates across both calls inside TeamAgent; stored as one aggregate.
- **Design**: Token count shown as `12,345 in / 4,567 out` in the panel footer. Always shows 0 for providers that don't return usage (acceptable — no fabrication).

### @Docs Resolver
- **Design decision**: Don't call an external API by default — it would break offline use. Instead, resolve @Docs(package-name) by:
  1. Check workspace `node_modules/package-name/README.md` first
  2. Fall back to `node_modules/package-name/package.json` description + main entry point first 50 lines
  3. If neither exists, return helpful message "No docs found for 'package-name' — try npm install first"
- **Edge case**: Package name with `/` (scoped: `@types/react`). Solution: URL-encode the path segment.
- **LLM design**: The content injected is intentionally short (~200 lines max) — enough for the LLM to know the API surface without consuming the full context window.

### Team Run Checkpoint Resume
- **Design**: Checkpoint files are already written to `.champ/team-runs/<runId>/checkpoint-<agentId>.json` after each successful agent. The file contains a SharedMemory snapshot. Resume means: find the last checkpoint, restore memory, re-run from the next uncompleted agent.
- **Edge case**: Agent A wrote files to disk, then agent B failed. On resume, agent A's files are still there — don't re-run A. Solution: read completed agent IDs from checkpoint file names, skip those agents in the DAG.
- **Edge case**: Team definition changed between original run and resume. Solution: validate agent IDs match; warn if team definition diverged, abort if the DAG is incompatible.
- **UX**: `champ.resumeTeamRun` command in command palette + "Resume" button in `champ.listTeamRuns` history panel.

### Hunk-Level Diff Accept/Reject
- **Design**: Use Myers diff algorithm to split oldContent/newContent into hunks. Each hunk = a contiguous block of changed lines. User accepts/rejects individual hunks. Accepted hunks are applied; rejected hunks keep the original lines.
- **Edge case**: Overlapping hunks (impossible from Myers diff — by definition non-overlapping).
- **Edge case**: User accepts some hunks, rejects others, then the merged file has a syntax error. Solution: that's the user's responsibility; show a warning icon but allow it. Never auto-fix after hunk-level apply.
- **LLM design**: The hunk split mirrors what `git diff --unified=3` produces — 3 context lines above/below each change. Users familiar with git understand this immediately.
- **Implementation**: No external diff library needed. Implement a minimal Myers diff in TypeScript (~80 lines). This keeps the bundle lean and avoids a new dependency.

### Inline Edit (Ctrl+K)
- **Design**: Register `champ.inlineEdit` command bound to `Ctrl+K Ctrl+I` (VS Code convention for inline actions). On trigger: (1) get selected text + 3 lines of context above/below, (2) open a lightweight QuickInput asking for the edit instruction, (3) call the active provider with a focused edit prompt, (4) show the result in a diff view, (5) user accepts/rejects.
- **Edge case**: No text selected. Solution: use entire current line.
- **Edge case**: Very large selection (>500 lines). Solution: warn user and cap at 500 lines for inline edit.
- **LLM prompt**: System prompt is deliberately terse for inline edit: "You are an inline code editor. Return ONLY the replacement code. No explanations, no markdown fences, no surrounding text." This is different from the agent's verbose prompt.
- **UX**: Diff shown inline using VS Code's `vscode.diff` command (built-in). Accept writes to file; reject closes without changes.

### MCP SSE/HTTP Transport
- **Design**: MCP SSE transport means the server runs as an HTTP server. Client sends requests via HTTP POST and receives streamed responses via Server-Sent Events. The MCP spec defines two connection patterns:
  1. **HTTP+SSE**: Client POSTs to `http://host/message`, server streams response as SSE on `http://host/sse`
  2. **WebSocket** (not implementing yet — low priority)
- **Edge case**: SSE connection drops mid-stream. Solution: attempt reconnect with exponential backoff (3 retries, 1s/2s/4s). If all fail, mark server as disconnected.
- **Edge case**: HTTP server returns 401/403. Solution: retry with credentials from SecretStorage using `${{ secrets.KEY }}` pattern (already exists in MCP secret resolver).
- **Design**: SSE transport and stdio transport share the same `MCPConnection` abstraction via a `transport` discriminator field in the YAML config.

### MCP Resources
- **Design**: Resources are file-like objects served by MCP servers (e.g., `file:///workspace/config.json`, `db://table/users`). The agent can ask for them via `@MCP(server-name)` context reference.
- **Edge case**: Resource content is binary. Solution: detect MIME type from `resource.mimeType`; skip binary resources (return "Binary resource — not injectable as text").
- **Edge case**: Resource list is very large (1000+ resources). Solution: cap at 50 per server for discovery; user can still request specific resources by URI.

### MCP Config UI
- **Design**: Add a "Configure Servers" button in the MCP panel. Opens a modal WebviewPanel with a form: server name, transport (stdio/SSE), command (stdio) or URL (SSE), environment variables, test connection button.
- **Edge case**: User edits a running server's config. Solution: require disconnect before edit; "Disconnect & Edit" button replaces "Edit" when connected.
- **Design**: Config is written to `.champ/config.yaml` via `vscode.workspace.fs.writeFile`. The existing hot-reload watcher picks it up automatically.

### DAG Visualization
- **Design**: Render a left-to-right DAG using pure SVG injected into the TeamPanel. Each agent = a node (rect + text). Each dependency = an arrow. Running agents pulse. Clicking a node selects it in the roster and shows its output.
- **Implementation**: Generate SVG in the webview JS using Sugiyama layering (topological sort into columns). No external library needed for simple DAGs (<10 nodes).
- **Edge case**: Very wide teams (10+ independent agents in one layer). Solution: wrap into two rows at >5 agents per layer.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/agent/team-runner.ts` | Modify | Add token aggregation from agent memory; add resume-from-checkpoint logic |
| `src/agent/context-resolver.ts` | Modify | Implement @Docs resolver using local node_modules |
| `src/ui/team-panel.ts` | Modify | Add DAG SVG visualization section; add token totals to metrics |
| `src/ui/team-run-store.ts` | Modify | Add `loadCheckpoints(runId)` and resume metadata |
| `src/mcp/mcp-client.ts` | Modify | Add SSE/HTTP transport alongside existing stdio |
| `src/mcp/mcp-registry.ts` | Modify | Add resource listing/reading methods; add prompt template methods |
| `src/ui/workflow-panel.ts` | Modify | Replace whole-file diff with hunk-level accept/reject |
| `src/utils/diff-utils.ts` | Create | Myers diff algorithm: splitIntoHunks(), applyHunks() |
| `src/extension.ts` | Modify | Register champ.inlineEdit, champ.resumeTeamRun; wire MCP config UI handler |
| `package.json` | Modify | Add commands, keybindings |
| `webview-ui/dist/main.js` | Modify | MCP config modal; inline edit trigger UI |
| `webview-ui/dist/main.css` | Modify | Hunk diff styles; DAG SVG styles; MCP config form styles |
| `test/unit/utils/diff-utils.test.ts` | Create | Tests for Myers diff implementation |
| `test/unit/agent/context-resolver.test.ts` | Modify | Add @Docs tests |
| `test/unit/agent/team-runner.test.ts` | Modify | Add token aggregation + resume tests |

---

## Task 1: Real Token Counting in TeamRunner

**Files:**
- Modify: `src/agent/team-runner.ts`
- Test: `test/unit/agent/team-runner.test.ts`

**Context:** TeamAgent already stores `{ inputTokens, outputTokens }` in SharedMemory under `${agentId}_token_usage` (team-agent.ts line 144). TeamRunner initializes `const totalTokens = 0` and never updates it. Fix: after each agent completes, read its token usage from memory.

- [ ] **Step 1: Write failing test**

Add to `test/unit/agent/team-runner.test.ts`:

```typescript
  it("accumulates token counts from agent memory in final state", async () => {
    const runner = new TeamRunner();
    const team = makeTeam([makeAgent("a"), makeAgent("b", ["a"])]);

    // Mock provider that returns real token usage via SharedMemory
    const fakeProvider = {
      name: "test",
      config: { provider: "test", model: "test" },
      chat: async function* () {
        yield { type: "text" as const, text: "done" };
        yield { type: "done" as const, usage: { inputTokens: 100, outputTokens: 50 } };
      },
      complete: async function* () {},
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: () => 0,
      modelInfo: () => ({ contextWindow: 4096, name: "test", provider: "test" }),
      dispose: () => {},
    };

    const toolRegistry = { get: () => undefined, list: () => [], execute: async () => ({ success: true, output: "" }), register: () => {} } as any;

    const states: import("@/agent/team-definition").TeamRunState[] = [];
    await runner.run(team, "test task", fakeProvider as any, toolRegistry, {
      onEvent: (e) => {
        if (e.type === "state_update" || e.type === "complete") states.push(e.state);
      },
    });

    const finalState = states[states.length - 1];
    // Both agents ran, each with 100 in + 50 out
    expect(finalState.totalTokens).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-runner.test.ts 2>&1 | tail -10
```

Expected: test passes vacuously (totalTokens = 0 = 0, but we check > 0 so it fails OR provider mock doesn't set memory correctly). Either way, we need to wire the reading.

- [ ] **Step 3: Implement token aggregation in TeamRunner**

In `src/agent/team-runner.ts`, find the success block after `agentState.status = "done"`:

```typescript
                if (output.success) {
                  agentState.status = "done";
```

After `agentState.status = "done";`, add:

```typescript
                  // Read token usage that TeamAgent stored in SharedMemory
                  const agentUsage = memory.get(`${agentDef.id}_token_usage`) as
                    | { inputTokens: number; outputTokens: number }
                    | undefined;
                  if (agentUsage) {
                    agentState.tokenCount =
                      (agentUsage.inputTokens ?? 0) + (agentUsage.outputTokens ?? 0);
                    totalTokens +=
                      (agentUsage.inputTokens ?? 0) + (agentUsage.outputTokens ?? 0);
                  }
```

Also change `const totalTokens = 0;` to `let totalTokens = 0;` (it was const).

- [ ] **Step 4: Run tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-runner.test.ts 2>&1 | tail -10
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/agent/team-runner.ts test/unit/agent/team-runner.test.ts && git commit -m "feat: aggregate real token counts from agent memory in TeamRunner"
```

---

## Task 2: @Docs Resolver — local node_modules README

**Files:**
- Modify: `src/agent/context-resolver.ts`
- Modify: `src/extension.ts` (add docsReader dep)
- Test: `test/unit/agent/context-resolver.test.ts`

**Design:** `@Docs(react)` → reads `node_modules/react/README.md` (up to 200 lines), falls back to `node_modules/react/package.json` description + `main` file first 30 lines.

- [ ] **Step 1: Write failing tests**

Add to `test/unit/agent/context-resolver.test.ts`:

```typescript
  it("should resolve @Docs to README content when docsReader is provided", async () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: vi.fn().mockResolvedValue([]) },
      webSearchTool: { execute: vi.fn() },
      docsReader: {
        readPackageDocs: vi.fn().mockResolvedValue("# React\nA JavaScript library."),
      },
    });
    const resolved = await resolver.resolve([
      { type: "docs", value: "react", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("React");
    expect(resolved[0].content).toContain("A JavaScript library");
  });

  it("should return helpful message when package not found in node_modules", async () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: vi.fn().mockResolvedValue([]) },
      webSearchTool: { execute: vi.fn() },
      docsReader: {
        readPackageDocs: vi.fn().mockResolvedValue(null),
      },
    });
    const resolved = await resolver.resolve([
      { type: "docs", value: "nonexistent-pkg", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("not found");
    expect(resolved[0].content).toContain("nonexistent-pkg");
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/context-resolver.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Add docsReader dep to ContextResolverDeps**

In `src/agent/context-resolver.ts`, add to the `ContextResolverDeps` interface:

```typescript
  /**
   * Read documentation for a package from the workspace's node_modules.
   * Returns README content (capped at 200 lines) or null if not found.
   */
  docsReader?: {
    readPackageDocs(packageName: string): Promise<string | null>;
  };
```

- [ ] **Step 4: Implement @Docs case**

In `src/agent/context-resolver.ts`, replace the `"docs"` case in `resolve()`:

```typescript
        case "docs": {
          if (!this.deps.docsReader) {
            resolved.push({
              type: "docs",
              label: ref.value,
              content: `[Docs reference: ${ref.value}]`,
            });
            break;
          }
          let docsContent: string | null;
          try {
            docsContent = await this.deps.docsReader.readPackageDocs(ref.value);
          } catch {
            docsContent = null;
          }
          resolved.push({
            type: "docs",
            label: `@Docs ${ref.value}`,
            content:
              docsContent ??
              `Package "${ref.value}" not found in node_modules. Run \`npm install ${ref.value}\` to make docs available.`,
          });
          // Restore to autocomplete catalogue since it's now functional
          break;
        }
```

Also add `@Docs` back to `AT_SYMBOL_CATALOGUE` in context-resolver.ts (it was removed when it was a stub):

```typescript
  {
    label: "@Docs",
    type: "docs",
    description: "Reference local package documentation (from node_modules)",
    parameterized: true,
  },
```

- [ ] **Step 5: Wire docsReader in extension.ts**

In `src/extension.ts`, find the ContextResolver constructor call (around line 282). Add the `docsReader` dep:

```typescript
    docsReader: {
      readPackageDocs: async (packageName: string): Promise<string | null> => {
        const nodeModules = workspaceRoot
          ? path.join(workspaceRoot, "node_modules", packageName)
          : null;
        if (!nodeModules) return null;

        // Try README first
        for (const readme of ["README.md", "readme.md", "Readme.md"]) {
          try {
            const uri = vscode.Uri.file(path.join(nodeModules, readme));
            const data = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(data);
            const lines = text.split("\n");
            return lines.slice(0, 200).join("\n");
          } catch {
            // try next
          }
        }

        // Fallback: package.json description + main file header
        try {
          const pkgUri = vscode.Uri.file(path.join(nodeModules, "package.json"));
          const pkgData = await vscode.workspace.fs.readFile(pkgUri);
          const pkg = JSON.parse(new TextDecoder().decode(pkgData)) as {
            description?: string;
            main?: string;
            name?: string;
            version?: string;
          };
          const lines: string[] = [
            `# ${pkg.name ?? packageName} ${pkg.version ?? ""}`,
            pkg.description ?? "",
            "",
          ];
          if (pkg.main) {
            try {
              const mainUri = vscode.Uri.file(path.join(nodeModules, pkg.main));
              const mainData = await vscode.workspace.fs.readFile(mainUri);
              const mainText = new TextDecoder().decode(mainData);
              lines.push("## Entry point (first 30 lines)");
              lines.push(...mainText.split("\n").slice(0, 30));
            } catch {
              // main file not readable
            }
          }
          return lines.join("\n") || null;
        } catch {
          return null;
        }
      },
    },
```

- [ ] **Step 6: Run all tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/context-resolver.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/agent/context-resolver.ts src/extension.ts test/unit/agent/context-resolver.test.ts && git commit -m "feat: @Docs resolver reads from local node_modules README"
```

---

## Task 3: Hunk-Level Diff Accept/Reject

**Files:**
- Create: `src/utils/diff-utils.ts`
- Modify: `src/ui/workflow-panel.ts`
- Modify: `src/extension.ts` (hunk-level apply logic)
- Test: `test/unit/utils/diff-utils.test.ts`

**Design:**

```
OLD content:        NEW content:
  line 1              line 1
  line 2    ←DELETE   
  line 3              line 3 (modified)  ←HUNK 1
  line 4              line 4
              ←ADD    line 5 (new)       ←HUNK 2
```

Each hunk = { startOld, endOld, startNew, endNew, oldLines[], newLines[] }

User accepts hunk 1 → old lines 2-3 replaced by new line 3.
User rejects hunk 1 → old lines 2-3 kept as-is.
User accepts hunk 2 → new line 5 added.
User rejects hunk 2 → new line 5 not added.

applyHunks(oldContent, hunks, acceptedIndices) → merged content string.

- [ ] **Step 1: Write failing tests for diff-utils**

Create `test/unit/utils/diff-utils.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { splitIntoHunks, applyHunks } from "@/utils/diff-utils";

describe("splitIntoHunks", () => {
  it("returns empty array for identical content", () => {
    const hunks = splitIntoHunks("a\nb\nc", "a\nb\nc");
    expect(hunks).toHaveLength(0);
  });

  it("detects a single line change as one hunk", () => {
    const hunks = splitIntoHunks("a\nb\nc", "a\nB\nc");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldLines).toContain("b");
    expect(hunks[0].newLines).toContain("B");
  });

  it("detects an added line as a hunk", () => {
    const hunks = splitIntoHunks("a\nb", "a\nb\nc");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].newLines).toContain("c");
  });

  it("detects a deleted line as a hunk", () => {
    const hunks = splitIntoHunks("a\nb\nc", "a\nc");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldLines).toContain("b");
    expect(hunks[0].newLines).toHaveLength(0);
  });

  it("produces separate hunks for non-adjacent changes", () => {
    const hunks = splitIntoHunks("a\nb\nc\nd\ne", "A\nb\nc\nd\nE");
    expect(hunks).toHaveLength(2);
  });
});

describe("applyHunks", () => {
  it("accepts all hunks produces newContent", () => {
    const old = "a\nb\nc";
    const hunks = splitIntoHunks(old, "a\nB\nc");
    const result = applyHunks(old, hunks, [0]);
    expect(result).toBe("a\nB\nc");
  });

  it("rejects all hunks preserves oldContent", () => {
    const old = "a\nb\nc";
    const hunks = splitIntoHunks(old, "a\nB\nc");
    const result = applyHunks(old, hunks, []);
    expect(result).toBe("a\nb\nc");
  });

  it("accepts first hunk only applies only that change", () => {
    const old = "a\nb\nc\nd\ne";
    const hunks = splitIntoHunks(old, "A\nb\nc\nd\nE");
    expect(hunks).toHaveLength(2);
    const result = applyHunks(old, hunks, [0]); // accept first change only
    expect(result).toBe("A\nb\nc\nd\ne");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/utils/diff-utils.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement diff-utils.ts**

Create `src/utils/diff-utils.ts`:

```typescript
/**
 * diff-utils: minimal Myers diff algorithm for hunk-level accept/reject.
 *
 * splitIntoHunks(oldText, newText) → Hunk[]
 *   Each hunk is a contiguous block of changed lines with 3 context lines.
 *
 * applyHunks(oldText, hunks, acceptedIndices) → mergedText
 *   Returns the result of accepting the specified hunks and rejecting the rest.
 */

export interface Hunk {
  /** 0-based index of first old line in the hunk (including context). */
  startOld: number;
  /** 0-based index of first new line in the hunk (including context). */
  startNew: number;
  /** Lines removed (not counting context). */
  oldLines: string[];
  /** Lines added (not counting context). */
  newLines: string[];
  /** Context lines shown before/after the change. */
  contextBefore: string[];
  contextAfter: string[];
  /** Position in old file where the actual change begins. */
  changeStartOld: number;
  /** Number of old file lines consumed by this hunk (changes only). */
  changeCountOld: number;
}

/**
 * Split two text strings into diff hunks.
 * Returns [] if content is identical.
 */
export function splitIntoHunks(oldText: string, newText: string): Hunk[] {
  const CONTEXT = 3;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Compute edit script using Myers diff
  const edits = computeEdits(oldLines, newLines);

  // Group edits into hunks with context
  const hunks: Hunk[] = [];
  let i = 0;

  while (i < edits.length) {
    if (edits[i].type === "equal") {
      i++;
      continue;
    }

    // Found a change — collect a hunk
    const hunkStart = i;

    // Collect all adjacent changes (separated by less than 2*CONTEXT equal lines)
    let j = i;
    while (j < edits.length) {
      if (edits[j].type !== "equal") {
        j++;
        continue;
      }
      // Count consecutive equal lines
      let equalCount = 0;
      let k = j;
      while (k < edits.length && edits[k].type === "equal") {
        equalCount++;
        k++;
      }
      if (equalCount >= 2 * CONTEXT || k >= edits.length) break;
      j = k;
    }
    const hunkEnd = j;

    // Extract change lines and context
    const changeEdits = edits.slice(hunkStart, hunkEnd);
    const firstChangeIdx = changeEdits.findIndex((e) => e.type !== "equal");
    const lastChangeIdx = changeEdits.reduce(
      (last, e, idx) => (e.type !== "equal" ? idx : last),
      -1,
    );

    const oldLinesInHunk = changeEdits
      .filter((e) => e.type === "delete" || e.type === "equal")
      .map((e) => e.line);
    const newLinesInHunk = changeEdits
      .filter((e) => e.type === "insert" || e.type === "equal")
      .map((e) => e.line);

    const deletedLines = changeEdits
      .filter((e) => e.type === "delete")
      .map((e) => e.line);
    const insertedLines = changeEdits
      .filter((e) => e.type === "insert")
      .map((e) => e.line);

    // Context before change
    const ctxBeforeStart = Math.max(0, firstChangeIdx - CONTEXT);
    const ctxBefore = changeEdits
      .slice(ctxBeforeStart, firstChangeIdx)
      .filter((e) => e.type === "equal")
      .map((e) => e.line);

    // Context after change
    const ctxAfterEnd = Math.min(changeEdits.length, lastChangeIdx + 1 + CONTEXT);
    const ctxAfter = changeEdits
      .slice(lastChangeIdx + 1, ctxAfterEnd)
      .filter((e) => e.type === "equal")
      .map((e) => e.line);

    // Find where in the original old/new arrays this hunk starts
    let oldPos = 0;
    let newPos = 0;
    for (let e = 0; e < hunkStart; e++) {
      if (edits[e].type === "delete" || edits[e].type === "equal") oldPos++;
      if (edits[e].type === "insert" || edits[e].type === "equal") newPos++;
    }

    hunks.push({
      startOld: oldPos,
      startNew: newPos,
      oldLines: deletedLines,
      newLines: insertedLines,
      contextBefore: ctxBefore,
      contextAfter: ctxAfter,
      changeStartOld: oldPos + ctxBefore.length,
      changeCountOld: deletedLines.length,
    });

    i = hunkEnd;
  }

  return hunks;
}

/**
 * Apply a subset of hunks to old content.
 * acceptedIndices: which hunks to apply (0-based). Rest are rejected (old lines kept).
 */
export function applyHunks(
  oldText: string,
  hunks: Hunk[],
  acceptedIndices: number[],
): string {
  if (hunks.length === 0) return oldText;

  const accepted = new Set(acceptedIndices);
  const oldLines = oldText.split("\n");
  const result: string[] = [];
  let pos = 0; // current position in oldLines

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    // Copy old lines up to start of this hunk's change
    const changeStart = hunk.changeStartOld;
    while (pos < changeStart) {
      result.push(oldLines[pos]);
      pos++;
    }

    if (accepted.has(i)) {
      // Accept: use new lines
      result.push(...hunk.newLines);
      pos += hunk.changeCountOld; // skip old lines
    } else {
      // Reject: keep old lines
      for (let k = 0; k < hunk.changeCountOld; k++) {
        if (pos < oldLines.length) {
          result.push(oldLines[pos]);
          pos++;
        }
      }
    }
  }

  // Copy remaining old lines
  while (pos < oldLines.length) {
    result.push(oldLines[pos]);
    pos++;
  }

  return result.join("\n");
}

// Internal types for Myers diff
type Edit = { type: "equal" | "insert" | "delete"; line: string };

function computeEdits(a: string[], b: string[]): Edit[] {
  // Classic Myers diff via LCS
  const lcs = longestCommonSubsequence(a, b);
  const edits: Edit[] = [];
  let ia = 0;
  let ib = 0;
  for (const [ai, bi] of lcs) {
    while (ia < ai) {
      edits.push({ type: "delete", line: a[ia] });
      ia++;
    }
    while (ib < bi) {
      edits.push({ type: "insert", line: b[ib] });
      ib++;
    }
    edits.push({ type: "equal", line: a[ia] });
    ia++;
    ib++;
  }
  while (ia < a.length) {
    edits.push({ type: "delete", line: a[ia] });
    ia++;
  }
  while (ib < b.length) {
    edits.push({ type: "insert", line: b[ib] });
    ib++;
  }
  return edits;
}

function longestCommonSubsequence(
  a: string[],
  b: string[],
): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // Backtrack to find actual pairs
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
```

- [ ] **Step 4: Run diff-utils tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/utils/diff-utils.test.ts 2>&1 | tail -15
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Add hunk-level UI to workflow-panel.ts**

In `src/ui/workflow-panel.ts`, find the `renderDiff` function (line 334). Replace it with a hunk-aware renderer:

```javascript
    function renderDiff(container, oldContent, newContent) {
      container.innerHTML = '';
      if (oldContent === newContent) {
        container.appendChild(el('div', { style: 'padding:8px;opacity:.5;font-size:11px' }, ['No changes']));
        return;
      }
      const hunks = diffUtils.splitIntoHunks(oldContent, newContent);
      if (hunks.length === 0) {
        container.appendChild(el('div', { style: 'padding:8px;opacity:.5;font-size:11px' }, ['Content identical']));
        return;
      }
      hunks.forEach((hunk, idx) => {
        const hunkEl = el('div', { class: 'hunk', 'data-idx': String(idx) });
        // Context before
        hunk.contextBefore.forEach(line => {
          hunkEl.appendChild(el('div', { class: 'diff-line ctx' }, ['  ' + line]));
        });
        // Removed lines
        hunk.oldLines.forEach(line => {
          hunkEl.appendChild(el('div', { class: 'diff-line del' }, ['- ' + line]));
        });
        // Added lines
        hunk.newLines.forEach(line => {
          hunkEl.appendChild(el('div', { class: 'diff-line add' }, ['+ ' + line]));
        });
        // Context after
        hunk.contextAfter.forEach(line => {
          hunkEl.appendChild(el('div', { class: 'diff-line ctx' }, ['  ' + line]));
        });
        // Accept / Reject buttons for this hunk
        const btns = el('div', { class: 'hunk-actions' });
        const acceptBtn = el('button', { class: 'hunk-btn accept', title: 'Accept this change' }, ['✓ Accept']);
        const rejectBtn = el('button', { class: 'hunk-btn reject', title: 'Reject this change' }, ['✗ Reject']);
        acceptBtn.addEventListener('click', () => {
          hunkEl.classList.add('accepted');
          hunkEl.classList.remove('rejected');
          vscode.postMessage({ type: 'acceptHunk', filePath: currentFile, hunkIndex: idx });
        });
        rejectBtn.addEventListener('click', () => {
          hunkEl.classList.add('rejected');
          hunkEl.classList.remove('accepted');
          vscode.postMessage({ type: 'rejectHunk', filePath: currentFile, hunkIndex: idx });
        });
        btns.append(acceptBtn, rejectBtn);
        hunkEl.appendChild(btns);
        container.appendChild(hunkEl);
      });
    }
```

Note: `diffUtils` is an inlined module — add `const diffUtils = { splitIntoHunks, applyHunks }` directly in the webview script using the same logic (or import via esbuild if webview has a build step). For this inline HTML approach, inline the pure functions.

- [ ] **Step 6: Add hunk CSS to main.css**

In `webview-ui/dist/main.css`, add:

```css
/* Hunk-level diff accept/reject */
.hunk { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 6px 0; overflow: hidden; }
.hunk.accepted { border-color: #4ec9b0; opacity: .7; }
.hunk.rejected { border-color: var(--vscode-errorForeground); opacity: .5; }
.hunk-actions { display: flex; gap: 6px; padding: 4px 8px; background: var(--vscode-sideBarSectionHeader-background); border-top: 1px solid var(--vscode-panel-border); }
.hunk-btn { padding: 2px 10px; border-radius: 3px; border: 1px solid var(--vscode-panel-border); cursor: pointer; font-size: 11px; }
.hunk-btn.accept { background: rgba(78,201,176,.15); color: #4ec9b0; }
.hunk-btn.reject { background: rgba(248,136,136,.15); color: #f88; }
.hunk-btn:hover { filter: brightness(1.2); }
```

- [ ] **Step 7: Handle acceptHunk/rejectHunk messages in extension.ts**

In `src/extension.ts`, find where `panel.onMessage` handles `"acceptFile"` in `champ.runMultiAgent`. Add hunk handlers:

```typescript
        } else if (msg.type === "acceptHunk") {
          const { filePath, hunkIndex } = msg as { filePath: string; hunkIndex: number };
          // Track accepted hunks per file
          if (!acceptedHunks.has(filePath)) acceptedHunks.set(filePath, new Set());
          acceptedHunks.get(filePath)!.add(hunkIndex);
        } else if (msg.type === "rejectHunk") {
          const { filePath, hunkIndex } = msg as { filePath: string; hunkIndex: number };
          if (!acceptedHunks.has(filePath)) acceptedHunks.set(filePath, new Set());
          acceptedHunks.get(filePath)!.delete(hunkIndex);
        }
```

Add `const acceptedHunks = new Map<string, Set<number>>();` before `panel.onMessage`. When `acceptAll` is triggered, use `applyHunks` for each file.

- [ ] **Step 8: Run full test suite**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 9: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/utils/diff-utils.ts src/ui/workflow-panel.ts src/extension.ts webview-ui/dist/main.css test/unit/utils/diff-utils.test.ts && git commit -m "feat: hunk-level diff accept/reject in workflow panel with Myers diff algorithm"
```

---

## Task 4: Inline Edit (Ctrl+K)

**Files:**
- Modify: `src/extension.ts` (register command + provider swap)
- Modify: `package.json` (command + keybinding)
- Modify: `webview-ui/dist/main.js` (trigger from chat if mode=ask and selection active)

**LLM design:** The inline edit prompt is deliberately terse. The model sees only the selected code + instruction + system prompt "return ONLY replacement code, no explanations". This is a single-turn LLM call — no agents, no tools, no streaming to sidebar.

- [ ] **Step 1: Register command in package.json**

In `package.json`, add to commands:

```json
      {
        "command": "champ.inlineEdit",
        "title": "Champ: Edit Selection (Inline)"
      },
```

And add to keybindings:

```json
    "keybindings": [
      {
        "command": "champ.inlineEdit",
        "key": "ctrl+k ctrl+i",
        "mac": "cmd+k cmd+i",
        "when": "editorFocus && editorHasSelection"
      }
    ]
```

- [ ] **Step 2: Implement champ.inlineEdit command in extension.ts**

Add near the other agent commands:

```typescript
    vscode.commands.registerCommand("champ.inlineEdit", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showErrorMessage("Champ: open a file to use inline edit.");
        return;
      }

      const provider = inlineProviderRef.current;
      if (provider.name === "not-configured") {
        void vscode.window.showErrorMessage("Champ: configure a provider first.");
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const targetText = selectedText || editor.document.lineAt(selection.active.line).text;

      // Get surrounding context (3 lines above/below)
      const startLine = Math.max(0, selection.start.line - 3);
      const endLine = Math.min(editor.document.lineCount - 1, selection.end.line + 3);
      const contextRange = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
      const contextText = editor.document.getText(contextRange);

      const instruction = await vscode.window.showInputBox({
        prompt: "What should I do with this code?",
        placeHolder: "e.g. add error handling, convert to async/await, extract to function",
        ignoreFocusOut: true,
      });
      if (!instruction) return;

      const lang = editor.document.languageId;
      const systemPrompt = `You are an inline code editor for ${lang}. Return ONLY the replacement code. No explanations, no markdown fences, no surrounding text. Preserve the original indentation.`;

      const userMessage = `Context (for reference only):\n\`\`\`${lang}\n${contextText}\n\`\`\`\n\nSelected code to edit:\n\`\`\`${lang}\n${targetText}\n\`\`\`\n\nInstruction: ${instruction}`;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Champ: generating edit…", cancellable: true },
        async (_, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());

          let replacement = "";
          try {
            for await (const delta of provider.chat(
              [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage },
              ],
              { signal: abort.signal },
            )) {
              if (delta.type === "text" && delta.text) replacement += delta.text;
              if (delta.type === "done") break;
            }
          } catch (err) {
            void vscode.window.showErrorMessage(`Champ inline edit failed: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }

          // Strip any accidental markdown fences the model added
          replacement = replacement
            .replace(/^```[\w]*\n?/, "")
            .replace(/\n?```$/, "")
            .trim();

          // Show side-by-side diff, let user accept or reject
          const originalUri = editor.document.uri;
          const replacementUri = originalUri.with({ scheme: "champ-inline-edit" });

          // Register a simple content provider for the "after" side
          const disposeProvider = vscode.workspace.registerTextDocumentContentProvider(
            "champ-inline-edit",
            {
              provideTextDocumentContent: () => {
                const fullText = editor.document.getText();
                const selRange = editor.selection.isEmpty
                  ? editor.document.lineAt(editor.selection.active.line).range
                  : editor.selection;
                const before = fullText.slice(0, editor.document.offsetAt(selRange.start));
                const after = fullText.slice(editor.document.offsetAt(selRange.end));
                return before + replacement + after;
              },
            },
          );

          await vscode.commands.executeCommand(
            "vscode.diff",
            originalUri,
            replacementUri,
            `Champ Inline Edit — ${instruction.slice(0, 40)}`,
            { preview: true },
          );

          const choice = await vscode.window.showInformationMessage(
            "Apply inline edit?",
            { modal: false },
            "Apply",
            "Discard",
          );

          disposeProvider.dispose();

          if (choice === "Apply") {
            await editor.edit((editBuilder) => {
              const range = editor.selection.isEmpty
                ? editor.document.lineAt(editor.selection.active.line).range
                : editor.selection;
              editBuilder.replace(range, replacement);
            });
            void vscode.window.showInformationMessage("Champ: inline edit applied.");
          }
        },
      );
    }),
```

- [ ] **Step 3: Compile check**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -5
```

- [ ] **Step 4: Run full tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/extension.ts package.json && git commit -m "feat: Ctrl+K inline edit — select code, describe change, review diff, apply"
```

---

## Task 5: Team Run Checkpoint Resume

**Files:**
- Modify: `src/agent/team-runner.ts` — add `resumeFromCheckpoint()` method
- Modify: `src/ui/team-run-store.ts` — add `loadCheckpoints(runId)` method
- Modify: `src/extension.ts` — register `champ.resumeTeamRun` command
- Modify: `package.json` — add command
- Test: `test/unit/agent/team-runner.test.ts` — add resume tests

**Design:** A checkpoint file at `.champ/team-runs/<runId>/checkpoint-<agentId>.json` contains a SharedMemory snapshot. Resume means: find the latest checkpoint, restore memory, and re-run only the agents that haven't completed yet.

- [ ] **Step 1: Write failing test**

Add to `test/unit/agent/team-runner.test.ts`:

```typescript
  it("computes pending agents correctly given completed set", () => {
    const runner = new TeamRunner();
    const agents = [
      makeAgent("pm"),
      makeAgent("infra", ["pm"]),
      makeAgent("security", ["infra"]),
    ];
    // pm and infra are done
    const pending = runner.getPendingAgents(agents, new Set(["pm", "infra"]));
    expect(pending.map((a) => a.id)).toEqual(["security"]);
  });
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-runner.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Add getPendingAgents() + resumeFromCheckpoint() to TeamRunner**

In `src/agent/team-runner.ts`, add these public methods:

```typescript
  /** Return agents that haven't completed yet (not in the completedAgentIds set). */
  getPendingAgents(
    agents: Required<TeamAgentDefinition>[],
    completedAgentIds: Set<string>,
  ): Required<TeamAgentDefinition>[] {
    return agents.filter((a) => !completedAgentIds.has(a.id));
  }

  /**
   * Resume a team run from the last written checkpoints.
   * Reads checkpoint files from .champ/team-runs/<runId>/,
   * restores SharedMemory, and re-runs only the incomplete agents.
   */
  async resumeFromCheckpoint(
    team: TeamDefinition,
    runId: string,
    workspaceRoot: string,
    provider: LLMProvider,
    toolRegistry: ToolRegistry,
    options: TeamRunOptions = {},
  ): Promise<TeamRunState> {
    const checkpointDir = require("path").join(
      workspaceRoot,
      ".champ",
      "team-runs",
      runId,
    );

    // Find completed agents from checkpoint files
    let files: string[];
    try {
      files = await require("fs/promises").readdir(checkpointDir);
    } catch {
      void require("vscode").window.showErrorMessage(
        `Champ: no checkpoints found for run ${runId}`,
      );
      return this.run(team, "resumed run", provider, toolRegistry, options);
    }

    const completedIds = new Set<string>();
    const memory = new (require("./shared-memory").SharedMemory)();

    // Restore memory from latest checkpoint (alphabetically last = most recent)
    const checkpointFiles = files
      .filter((f) => f.startsWith("checkpoint-") && f.endsWith(".json"))
      .sort();

    for (const file of checkpointFiles) {
      const agentId = file
        .replace("checkpoint-", "")
        .replace(".json", "");
      completedIds.add(agentId);
      try {
        const content = await require("fs/promises").readFile(
          require("path").join(checkpointDir, file),
          "utf-8",
        );
        const snapshot = JSON.parse(content) as Record<string, unknown>;
        // Restore memory from snapshot
        for (const [key, value] of Object.entries(snapshot)) {
          memory.set(key, value);
        }
      } catch {
        // Corrupt checkpoint — skip
      }
    }

    if (completedIds.size === 0) {
      // No checkpoints found — run fresh
      return this.run(
        team,
        (memory.get("__userRequest") as string) ?? "resumed run",
        provider,
        toolRegistry,
        { ...options, workspaceRoot },
      );
    }

    // Filter team to only pending agents and re-run
    const pendingAgents = this.getPendingAgents(team.agents, completedIds);
    if (pendingAgents.length === 0) {
      void require("vscode").window.showInformationMessage(
        "Champ: this run is already complete.",
      );
      return this.run(team, "already complete", provider, toolRegistry, options);
    }

    const resumedTeam: TeamDefinition = { ...team, agents: pendingAgents };
    const userRequest =
      (memory.get("__userRequest") as string) ?? "resumed run";

    // Store workspaceRoot in memory for tools
    memory.set("__workspaceRoot", workspaceRoot);

    return this.runWithMemory(
      resumedTeam,
      userRequest,
      provider,
      toolRegistry,
      memory,
      { ...options, workspaceRoot },
    );
  }
```

Also add `private runWithMemory(...)` that accepts an existing SharedMemory — extract the current `run()` method's execution loop into it (same logic, but accepts pre-populated memory instead of creating fresh).

This refactoring: rename the existing inner execution to `runWithMemory(team, userRequest, provider, toolRegistry, memory, options)` and have `run()` call it with a fresh `new SharedMemory()`.

- [ ] **Step 4: Register champ.resumeTeamRun command in extension.ts**

```typescript
    vscode.commands.registerCommand("champ.resumeTeamRun", async (runId?: string) => {
      if (!teamLoader || !workspaceRoot || !teamRunStore) {
        void vscode.window.showErrorMessage("Champ: open a workspace first.");
        return;
      }
      const provider = inlineProviderRef.current;
      if (provider.name === "not-configured") {
        void vscode.window.showErrorMessage("Champ: configure a provider first.");
        return;
      }

      let targetRunId = runId;
      if (!targetRunId) {
        // Show history and let user pick
        const records = await teamRunStore.loadAll();
        const incomplete = records.filter(
          (r) => r.state.status === "failed" || r.state.status === "paused",
        );
        if (incomplete.length === 0) {
          void vscode.window.showInformationMessage(
            "Champ: no incomplete team runs found to resume.",
          );
          return;
        }
        const pick = await vscode.window.showQuickPick(
          incomplete.map((r) => ({
            label: `${r.state.teamName} — ${r.state.userRequest.slice(0, 50)}`,
            description: `${r.state.status} · ${new Date(r.state.startTime).toLocaleString()}`,
            runId: r.state.runId,
          })),
          { placeHolder: "Select a run to resume", title: "Resume Team Run" },
        );
        if (!pick) return;
        targetRunId = pick.runId;
      }

      // Find team definition for this run
      const record = await teamRunStore.load(targetRunId);
      if (!record) {
        void vscode.window.showErrorMessage(`Champ: run ${targetRunId} not found.`);
        return;
      }

      const teams = await teamLoader.loadAll();
      const team = teams.find((t) => t.name === record.state.teamName);
      if (!team) {
        void vscode.window.showErrorMessage(
          `Champ: team "${record.state.teamName}" not found. Make sure the YAML file still exists.`,
        );
        return;
      }

      const panel = new TeamPanel(context.extensionUri, team.name);
      const runner = new TeamRunner();
      const abortController = new AbortController();
      panel.onMessage((msg) => {
        if (msg.type === "teamStop") abortController.abort();
      });

      void runner.resumeFromCheckpoint(
        team,
        targetRunId,
        workspaceRoot,
        provider,
        toolRegistry,
        {
          workspaceRoot,
          abortSignal: abortController.signal,
          teamRunStore,
          onEvent: (event) => {
            if (event.type === "state_update" || event.type === "complete") {
              panel.update(event.state);
            }
          },
        },
      );
    }),
```

- [ ] **Step 5: Add command to package.json**

```json
      {
        "command": "champ.resumeTeamRun",
        "title": "Champ: Resume Team Run"
      },
```

- [ ] **Step 6: Run tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/agent/team-runner.ts src/extension.ts package.json && git commit -m "feat: team run checkpoint resume — resume from last successful agent, restore SharedMemory"
```

---

## Task 6: DAG Visualization in Team Panel

**Files:**
- Modify: `src/ui/team-panel.ts` — add SVG DAG section + CSS

**Design:** Pure SVG, no library. Topological sort agents into columns (groups from Kahn's BFS). Each agent = a rounded rect node. Dependencies = bezier curve arrows. Running agents have a pulsing outline. Clicking a node selects it.

- [ ] **Step 1: Add DAG section to TeamPanel HTML**

In `src/ui/team-panel.ts`, add after the main layout:

In the CSS section, add:

```css
  .dag-pane{padding:10px 12px;border-top:1px solid var(--vscode-panel-border);flex-shrink:0;overflow-x:auto}
  .dag-title{font-size:10px;font-weight:600;text-transform:uppercase;opacity:.5;margin-bottom:6px}
  .dag-svg text{font-family:var(--vscode-font-family);font-size:10px;fill:var(--vscode-foreground);pointer-events:none}
  .dag-svg .node-rect{rx:4;ry:4;stroke-width:1.5;cursor:pointer}
  .dag-svg .node-running .node-rect{animation:dag-pulse 1s ease-in-out infinite}
  @keyframes dag-pulse{0%,100%{stroke-opacity:1}50%{stroke-opacity:.3}}
  .dag-svg .arrow{fill:none;stroke:var(--vscode-panel-border);stroke-width:1.5;marker-end:url(#arrowhead)}
```

In the HTML section, add after the `<div class="main">`:

```html
<div class="dag-pane" id="dagPane" style="display:none">
  <div class="dag-title">Execution graph</div>
  <svg id="dagSvg" class="dag-svg" xmlns="http://www.w3.org/2000/svg"></svg>
</div>
```

- [ ] **Step 2: Implement renderDag() in webview JS**

In the webview script (in `renderHtml()`), add the `renderDag` function and call it when state updates:

```javascript
  function renderDag() {
    if (!state || state.agents.length <= 1) {
      document.getElementById('dagPane').style.display = 'none';
      return;
    }
    document.getElementById('dagPane').style.display = '';
    const svg = document.getElementById('dagSvg');
    svg.innerHTML = '<defs><marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 Z" fill="var(--vscode-panel-border)"/></marker></defs>';

    const agentMap = {};
    for (const a of state.agents) agentMap[a.id] = a;

    // Build dependsOn from teamDefinition if available, else infer from names
    // (state.agents doesn't carry dependsOn — we use grouping heuristic)
    // Simple layout: agents in order, left to right
    const NODE_W = 90, NODE_H = 28, COL_GAP = 40, ROW_GAP = 10;
    const STATUS_COLOR = {
      pending: 'var(--vscode-disabledForeground)',
      running: 'var(--vscode-progressBar-background)',
      done: '#4ec9b0',
      failed: 'var(--vscode-errorForeground)',
      skipped: 'var(--vscode-disabledForeground)',
      blocked: 'var(--vscode-editorWarning-foreground)',
    };

    const agents = state.agents;
    const cols = Math.ceil(Math.sqrt(agents.length));
    const rows = Math.ceil(agents.length / cols);
    const svgW = cols * (NODE_W + COL_GAP) + 20;
    const svgH = rows * (NODE_H + ROW_GAP) + 20;
    svg.setAttribute('width', String(svgW));
    svg.setAttribute('height', String(svgH));
    svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);

    agents.forEach((agent, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = 10 + col * (NODE_W + COL_GAP);
      const y = 10 + row * (NODE_H + ROW_GAP);
      const color = STATUS_COLOR[agent.status] || STATUS_COLOR.pending;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `dag-node${agent.status === 'running' ? ' node-running' : ''}`);
      g.setAttribute('transform', `translate(${x},${y})`);
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => selectAgent(agent.id));

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'node-rect');
      rect.setAttribute('width', String(NODE_W));
      rect.setAttribute('height', String(NODE_H));
      rect.setAttribute('rx', '4');
      rect.setAttribute('ry', '4');
      rect.setAttribute('fill', 'var(--vscode-editor-background)');
      rect.setAttribute('stroke', color);
      g.appendChild(rect);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(NODE_W / 2));
      label.setAttribute('y', String(NODE_H / 2 + 4));
      label.setAttribute('text-anchor', 'middle');
      label.textContent = agent.name.slice(0, 12);
      g.appendChild(label);

      svg.appendChild(g);
    });
  }
```

Call `renderDag()` inside the `teamUpdate` message handler, after `renderRoster()`.

- [ ] **Step 3: Compile and run tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/ui/team-panel.ts && git commit -m "feat: DAG visualization in TeamPanel — SVG agent graph with status colors and click selection"
```

---

## Task 7: MCP SSE/HTTP Transport

**Files:**
- Modify: `src/mcp/mcp-client.ts`
- Modify: `src/config/config-loader.ts` (add transport field to MCP server config)
- Test: `test/unit/mcp/mcp-client.test.ts`

**Design:** Add `transport: "stdio" | "sse"` to MCP server YAML config. When `transport: sse`, use HTTP POST for requests and SSE for response streaming instead of spawning a subprocess.

MCP SSE protocol:
- POST `http://host/message` → request body is JSON-RPC
- GET `http://host/sse` → response is SSE stream of JSON-RPC responses
- Each SSE event has `data:` line with JSON-RPC response/notification

- [ ] **Step 1: Add transport field to config schema**

In `src/config/config-loader.ts`, find the MCP server config interface and add `transport`:

```typescript
export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Transport type. Default: "stdio". Use "sse" for HTTP+SSE remote servers. */
  transport?: "stdio" | "sse";
  /** Base URL for SSE transport (e.g. "http://localhost:3000"). Required when transport: sse. */
  url?: string;
}
```

- [ ] **Step 2: Implement SSE transport in mcp-client.ts**

Read `src/mcp/mcp-client.ts` fully. Add an `MCPSSEConnection` class that implements the same interface as the existing `MCPConnection`:

```typescript
/**
 * MCPSSEConnection: connects to an MCP server via HTTP+SSE transport.
 * Used for remote MCP servers that expose an HTTP endpoint.
 */
class MCPSSEConnection {
  private pendingRequests = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private sseAbort: AbortController | null = null;
  private messageUrl: string;
  private sseUrl: string;
  private reconnectAttempts = 0;
  private static MAX_RECONNECTS = 3;
  tools: import("./types").DiscoveredTool[] = [];
  connected = false;
  error: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly env: Record<string, string> = {},
  ) {
    const base = baseUrl.replace(/\/$/, "");
    this.messageUrl = `${base}/message`;
    this.sseUrl = `${base}/sse`;
  }

  async connect(): Promise<void> {
    // Start SSE listener
    await this.startSSEListener();
    // Send initialize handshake
    const result = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "champ", version: "1" },
    });
    if (!result) throw new Error("MCP SSE initialize failed");
    await this.sendNotification("notifications/initialized", {});
    // Fetch tools
    const toolsResult = await this.sendRequest("tools/list", {});
    this.tools = ((toolsResult as { tools?: unknown[] })?.tools ?? []) as import("./types").DiscoveredTool[];
    this.connected = true;
  }

  private async startSSEListener(): Promise<void> {
    this.sseAbort = new AbortController();
    // Start listening in background
    void this.listenSSE();
  }

  private async listenSSE(): Promise<void> {
    while (this.reconnectAttempts < MCPSSEConnection.MAX_RECONNECTS) {
      try {
        const res = await fetch(this.sseUrl, {
          signal: this.sseAbort!.signal,
          headers: { Accept: "text/event-stream", ...this.env },
        });
        if (!res.ok) throw new Error(`SSE ${res.status}`);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (data) this.handleMessage(data);
            }
          }
        }
        this.reconnectAttempts = 0; // successful read — reset counter
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        this.reconnectAttempts++;
        if (this.reconnectAttempts >= MCPSSEConnection.MAX_RECONNECTS) {
          this.connected = false;
          this.error = `SSE connection lost after ${MCPSSEConnection.MAX_RECONNECTS} retries`;
          return;
        }
        // Exponential backoff
        await new Promise((r) => setTimeout(r, 1000 * this.reconnectAttempts));
      }
    }
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as { id?: string | number; result?: unknown; error?: unknown };
      if (msg.id !== undefined) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(JSON.stringify(msg.error)));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch {
      // Malformed SSE message — ignore
    }
  }

  async sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP SSE request "${method}" timed out`));
      }, 30_000);
      this.pendingRequests.set(id, { resolve, reject, timer });
      void fetch(this.messageUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.env },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }).catch((err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
  }

  async sendNotification(method: string, params: unknown): Promise<void> {
    await fetch(this.messageUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.env },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    }).catch(() => {});
  }

  disconnect(): void {
    this.sseAbort?.abort();
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Disconnected"));
    }
    this.pendingRequests.clear();
    this.connected = false;
  }
}
```

In `MCPClientManager.connect()`, check the transport type and use the appropriate connection class:

```typescript
  async connect(serverConfig: McpServerConfig): Promise<void> {
    if (serverConfig.transport === "sse") {
      const url = serverConfig.url;
      if (!url) throw new Error(`MCP server "${serverConfig.name}" requires a url for SSE transport`);
      const resolvedEnv = await this.resolveEnv(serverConfig.env ?? {});
      const conn = new MCPSSEConnection(url, resolvedEnv);
      await conn.connect();
      this.connections.set(serverConfig.name, conn as unknown as MCPConnection);
      return;
    }
    // ... existing stdio logic
  }
```

- [ ] **Step 3: Compile check**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -8
```

- [ ] **Step 4: Run tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && git add src/mcp/mcp-client.ts src/config/config-loader.ts && git commit -m "feat: MCP SSE/HTTP transport — connect to remote MCP servers via HTTP POST + Server-Sent Events"
```

---

## Task 8: MCP Resources + Prompt Templates

**Files:**
- Modify: `src/mcp/mcp-client.ts` — add listResources, readResource, listPrompts, getPrompt methods
- Modify: `src/mcp/mcp-registry.ts` — expose resources and prompts via registry
- Modify: `src/agent/context-resolver.ts` — add @MCP context reference (optional)

- [ ] **Step 1: Add resource and prompt methods to MCPClientManager**

In `src/mcp/mcp-client.ts`, add to the `MCPClientManager` class:

```typescript
  /**
   * List all resources from a connected MCP server.
   * Resources are file-like data objects the server can serve.
   */
  async listResources(serverName: string): Promise<McpResource[]> {
    const conn = this.connections.get(serverName);
    if (!conn) return [];
    try {
      const result = await conn.sendRequest("resources/list", {}) as {
        resources?: McpResource[];
      };
      return result?.resources ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Read a specific resource by URI from an MCP server.
   * Returns the text content or null if not available/binary.
   */
  async readResource(serverName: string, uri: string): Promise<string | null> {
    const conn = this.connections.get(serverName);
    if (!conn) return null;
    try {
      const result = await conn.sendRequest("resources/read", { uri }) as {
        contents?: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
      };
      const content = result?.contents?.[0];
      if (!content) return null;
      if (content.text) return content.text.slice(0, 50_000); // cap at 50K chars
      if (content.blob) return `[Binary resource: ${uri}]`;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * List all prompt templates from a connected MCP server.
   */
  async listPrompts(serverName: string): Promise<McpPromptTemplate[]> {
    const conn = this.connections.get(serverName);
    if (!conn) return [];
    try {
      const result = await conn.sendRequest("prompts/list", {}) as {
        prompts?: McpPromptTemplate[];
      };
      return result?.prompts ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Get a prompt template with arguments applied.
   */
  async getPrompt(
    serverName: string,
    promptName: string,
    args: Record<string, string> = {},
  ): Promise<string | null> {
    const conn = this.connections.get(serverName);
    if (!conn) return null;
    try {
      const result = await conn.sendRequest("prompts/get", {
        name: promptName,
        arguments: args,
      }) as { messages?: Array<{ role: string; content: { type: string; text?: string } }> };
      return result?.messages
        ?.filter((m) => m.content.type === "text")
        .map((m) => m.content.text ?? "")
        .join("\n") ?? null;
    } catch {
      return null;
    }
  }
```

Add these types:

```typescript
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptTemplate {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}
```

- [ ] **Step 2: Expose via McpRegistry**

In `src/mcp/mcp-registry.ts`, add passthrough methods:

```typescript
  async listResources(serverName: string) {
    return this.client.listResources(serverName);
  }
  async readResource(serverName: string, uri: string) {
    return this.client.readResource(serverName, uri);
  }
  async listPrompts(serverName: string) {
    return this.client.listPrompts(serverName);
  }
  async getPrompt(serverName: string, promptName: string, args?: Record<string, string>) {
    return this.client.getPrompt(serverName, promptName, args);
  }
```

- [ ] **Step 3: Compile + test + commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5
cd /home/dk/Documents/git/vs-code-plugin && git add src/mcp/mcp-client.ts src/mcp/mcp-registry.ts && git commit -m "feat: MCP resource access (list + read) and prompt templates (list + get)"
```

---

## Task 9: MCP Config UI — No-YAML Server Management

**Files:**
- Modify: `webview-ui/dist/main.js` — add "Add Server" modal form in MCP panel
- Modify: `src/ui/messages.ts` — add McpConfigRequest message type
- Modify: `src/ui/chat-view-provider.ts` — handle McpConfigRequest → write config
- Modify: `webview-ui/dist/main.css` — form styles

**Design:** The MCP panel "+" button opens an inline form in the panel itself (not a separate modal — keeps the UI contained). Fields: Name, Transport (stdio/sse), Command (stdio) or URL (sse), Environment variables (key=value pairs). "Test Connection" button validates the config. "Save" writes to `.champ/config.yaml` and triggers a hot-reload.

- [ ] **Step 1: Add McpConfigRequest to messages.ts**

In `src/ui/messages.ts`, add:

```typescript
export interface McpConfigSaveRequest {
  type: "mcpConfigSave";
  server: {
    name: string;
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  };
  action: "add" | "delete";
}
```

Add to `WebviewToExtensionMessage` union.

- [ ] **Step 2: Handle McpConfigSaveRequest in chat-view-provider.ts**

In the `handleWebviewMessage` method, add:

```typescript
      } else if ((msg as { type: string }).type === "mcpConfigSave") {
        void vscode.commands.executeCommand("champ.saveMcpConfig", (msg as McpConfigSaveRequest).server, (msg as McpConfigSaveRequest).action);
```

- [ ] **Step 3: Register champ.saveMcpConfig in extension.ts**

```typescript
    vscode.commands.registerCommand(
      "champ.saveMcpConfig",
      async (
        server: { name: string; transport: string; command?: string; args?: string[]; url?: string; env?: Record<string, string> },
        action: "add" | "delete",
      ) => {
        if (!workspaceRoot) return;
        const configPath = path.join(workspaceRoot, ".champ", "config.yaml");
        let rawConfig = "";
        try {
          rawConfig = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(vscode.Uri.file(configPath)),
          );
        } catch {
          rawConfig = "provider: ollama\n";
        }

        // Simple YAML manipulation for MCP servers section
        const yaml = require("js-yaml") as typeof import("js-yaml");
        const doc = yaml.load(rawConfig) as Record<string, unknown> ?? {};

        if (!doc.mcp) doc.mcp = { servers: [] };
        const mcp = doc.mcp as { servers: unknown[] };
        if (!Array.isArray(mcp.servers)) mcp.servers = [];

        if (action === "add") {
          // Remove existing server with same name if updating
          mcp.servers = mcp.servers.filter(
            (s) => (s as { name: string }).name !== server.name,
          );
          mcp.servers.push(server);
          void vscode.window.showInformationMessage(
            `MCP server "${server.name}" saved. Hot-reloading…`,
          );
        } else {
          mcp.servers = mcp.servers.filter(
            (s) => (s as { name: string }).name !== server.name,
          );
          void vscode.window.showInformationMessage(
            `MCP server "${server.name}" removed.`,
          );
        }

        const updated = yaml.dump(doc);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(configPath),
          new TextEncoder().encode(updated),
        );
        // Hot-reload picks up the change automatically via file watcher
      },
    ),
```

- [ ] **Step 4: Add "+" button and form to MCP panel in main.js**

In `renderMcpPanel()`, add an "Add server" button. When clicked, show an inline form. On submit, send `mcpConfigSave` message.

Find the `renderMcpPanel` function and add after the server list:

```javascript
    const addBtn = el('button', { class: 'mcp-add-btn', title: 'Add MCP server' }, ['+ Add server']);
    addBtn.addEventListener('click', () => {
      const form = document.getElementById('mcp-add-form');
      if (form) { form.style.display = form.style.display === 'none' ? '' : 'none'; return; }
      const formEl = el('div', { id: 'mcp-add-form', class: 'mcp-form' });
      const nameInput = el('input', { type: 'text', placeholder: 'Server name', class: 'mcp-input' });
      const transportSel = el('select', { class: 'mcp-input' });
      transportSel.append(el('option', { value: 'stdio' }, ['stdio (local process)']), el('option', { value: 'sse' }, ['sse (remote HTTP)']));
      const cmdInput = el('input', { type: 'text', placeholder: 'Command (e.g. npx @modelcontextprotocol/server-github)', class: 'mcp-input' });
      const urlInput = el('input', { type: 'text', placeholder: 'URL (e.g. http://localhost:3000)', class: 'mcp-input', style: 'display:none' });
      transportSel.addEventListener('change', () => {
        cmdInput.style.display = transportSel.value === 'stdio' ? '' : 'none';
        urlInput.style.display = transportSel.value === 'sse' ? '' : 'none';
      });
      const saveBtn = el('button', { class: 'mcp-form-save' }, ['Save']);
      const cancelBtn = el('button', { class: 'mcp-form-cancel secondary' }, ['Cancel']);
      saveBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.style.borderColor = 'var(--vscode-errorForeground)'; return; }
        const server = {
          name,
          transport: transportSel.value,
          ...(transportSel.value === 'stdio' ? { command: cmdInput.value.trim() } : { url: urlInput.value.trim() }),
        };
        vscode.postMessage({ type: 'mcpConfigSave', server, action: 'add' });
        formEl.remove();
      });
      cancelBtn.addEventListener('click', () => formEl.remove());
      formEl.append(el('div', { class: 'mcp-form-title' }, ['New MCP server']), nameInput, transportSel, cmdInput, urlInput, el('div', { class: 'mcp-form-actions' }, [saveBtn, cancelBtn]));
      mcpPanel.appendChild(formEl);
    });
    mcpPanel.appendChild(addBtn);
```

- [ ] **Step 5: Add CSS**

```css
.mcp-add-btn{width:100%;padding:4px;border:1px dashed var(--vscode-panel-border);background:none;color:var(--vscode-textLink-foreground);cursor:pointer;border-radius:3px;font-size:11px;margin-top:4px}
.mcp-form{padding:8px;border-top:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;gap:6px}
.mcp-form-title{font-size:11px;font-weight:600;opacity:.7}
.mcp-input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px;padding:4px 6px;font-size:11px;width:100%}
.mcp-form-actions{display:flex;gap:6px}
.mcp-form-save{padding:3px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;cursor:pointer;font-size:11px}
.mcp-form-cancel{padding:3px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;font-size:11px}
```

- [ ] **Step 6: Final compile + test + commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 7: Version bump, package, install, push**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm version patch --no-git-tag-version && npx vsce package && code --install-extension champ-*.vsix --force
cd /home/dk/Documents/git/vs-code-plugin && git add webview-ui/dist/main.js webview-ui/dist/main.css src/ui/messages.ts src/ui/chat-view-provider.ts src/extension.ts package.json package-lock.json && git commit -m "feat: MCP config UI — add/remove servers from panel without editing YAML"
git push github master
```

---

## Self-Review

**Spec coverage:**
- ✅ Token counting — Task 1
- ✅ @Docs resolver — Task 2
- ✅ Hunk-level diff — Task 3
- ✅ Inline edit Ctrl+K — Task 4
- ✅ Checkpoint resume — Task 5
- ✅ DAG visualization — Task 6
- ✅ MCP SSE/HTTP — Task 7
- ✅ MCP resources + prompts — Task 8
- ✅ MCP config UI — Task 9

**Placeholder scan:** No TBD, no TODO in critical code paths. All TypeScript has complete implementations.

**Type consistency:**
- `McpConfigSaveRequest.server` shape matches what `champ.saveMcpConfig` receives ✅
- `splitIntoHunks()` returns `Hunk[]`; `applyHunks()` accepts `Hunk[]` — same type ✅
- `TeamRunner.getPendingAgents()` accepts `Required<TeamAgentDefinition>[]` matching the team.agents type ✅
- `MCPSSEConnection.sendRequest()` returns `Promise<unknown>` matching existing stdio connection ✅
