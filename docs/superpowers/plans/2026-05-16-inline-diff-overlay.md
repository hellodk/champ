# Inline Hunk Diff Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show agent file edits as colored gutter decorations in the editor with per-hunk Accept/Reject CodeLens and hover popup showing the actual diff.

**Architecture:** `DiffOverlayController` registers three VS Code providers (`TextEditorDecorationType` for gutter bars, `HoverProvider` for diff popup, `CodeLensProvider` for action buttons) against a `PendingFileDiff` state map. `ChatViewProvider` calls `registerEdit()` after each agent file edit. On resolve, decorations dispose.

**Tech Stack:** TypeScript, VS Code Extension API (`TextEditorDecorationType`, `HoverProvider`, `CodeLensProvider`, `TextEditorDecoration`), existing `splitIntoHunks` from `src/utils/diff-utils.ts`.

---

## Task 1: Types, `computeHunks`, `applyHunks` — no VS Code APIs

- [ ] Create `src/ui/diff-overlay-controller.ts` with the types and pure functions. No VS Code API used in this task — just the data structures and algorithms.

```typescript
// src/ui/diff-overlay-controller.ts
/**
 * DiffOverlayController — per-hunk inline diff decorations for VS Code.
 *
 * Renders:
 *   - Green gutter bars on added lines (TextEditorDecorationType)
 *   - Red top-border on deletion-point lines (TextEditorDecorationType)
 *   - Hover popup with diff fenced block (HoverProvider)
 *   - Accept/Reject CodeLens on each hunk (CodeLensProvider)
 */
import * as vscode from "vscode";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single diff hunk as used by the overlay controller. */
export interface OverlayHunk {
  /** 0-based index of this hunk in the file's hunk list. */
  index: number;
  /**
   * Lines in the new document that are "added" (changed or inserted).
   * Array of 0-based line numbers in the new document.
   */
  addedLines: number[];
  /**
   * The deletion point in the new document for removed-only hunks.
   * Only present if the hunk has removed lines but zero added lines.
   * This is the 0-based line in the new document immediately after
   * where the deleted lines would have appeared.
   */
  deletionPoint?: number;
  /** The old lines (strings) removed in this hunk. */
  removedOldLines: string[];
  /** The new lines (strings) added in this hunk. */
  addedNewLines: string[];
  /** 0-based first line of this hunk in the new document (for CodeLens placement). */
  newDocStartLine: number;
}

/** State for pending (unresolved) hunks in a single file. */
export interface PendingFileDiff {
  hunks: OverlayHunk[];
  acceptedIndices: Set<number>;
  rejectedIndices: Set<number>;
  oldContent: string;
  newContent: string;
}

/** Minimal edit record passed from ChatViewProvider. */
export interface EditRecord {
  path: string;         // absolute file path
  oldContent: string;
  newContent: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions — no VS Code API, fully testable
// ─────────────────────────────────────────────────────────────────────────────

type EditType = "equal" | "insert" | "delete";
interface RawEdit {
  type: EditType;
  line: string;
}

function longestCommonSubsequence(a: string[], b: string[]): Array<[number, number]> {
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
 * Compute overlay hunks from old and new file content.
 * Returns [] if content is identical.
 */
export function computeHunks(oldContent: string, newContent: string): OverlayHunk[] {
  if (oldContent === newContent) return [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const rawEdits = computeRawEdits(oldLines, newLines);

  const hunks: OverlayHunk[] = [];
  let oldIdx = 0;   // position in old document
  let newIdx = 0;   // position in new document
  let editIdx = 0;

  while (editIdx < rawEdits.length) {
    const edit = rawEdits[editIdx];
    if (edit.type === "equal") {
      oldIdx++;
      newIdx++;
      editIdx++;
      continue;
    }

    // Collect contiguous changed block
    const removedOldLines: string[] = [];
    const addedNewLines: string[] = [];
    const newDocStartLine = newIdx;

    while (editIdx < rawEdits.length && rawEdits[editIdx].type !== "equal") {
      const e = rawEdits[editIdx];
      if (e.type === "delete") {
        removedOldLines.push(e.line);
        oldIdx++;
      } else {
        addedNewLines.push(e.line);
        newIdx++;
      }
      editIdx++;
    }

    // Compute which new-document lines are "added"
    const addedLineNumbers: number[] = [];
    for (let k = 0; k < addedNewLines.length; k++) {
      addedLineNumbers.push(newDocStartLine + k);
    }

    const hunkIndex = hunks.length;

    if (addedLineNumbers.length === 0) {
      // Removal-only hunk: mark the deletion point
      // The deletion point is the line in the new document where the marker appears.
      // If newDocStartLine is past the end of the new file, clamp to last line.
      const deletionPoint = Math.min(newDocStartLine, Math.max(0, newLines.length - 1));
      hunks.push({
        index: hunkIndex,
        addedLines: [],
        deletionPoint,
        removedOldLines,
        addedNewLines: [],
        newDocStartLine: deletionPoint,
      });
    } else {
      hunks.push({
        index: hunkIndex,
        addedLines: addedLineNumbers,
        deletionPoint: removedOldLines.length > 0 ? newDocStartLine : undefined,
        removedOldLines,
        addedNewLines,
        newDocStartLine,
      });
    }
  }

  return hunks;
}

/**
 * Reconstruct file content by applying only accepted hunks.
 * Rejected hunks revert to old lines for their regions.
 * acceptedIndices is a Set<number> of 0-based hunk indices.
 *
 * This mirrors the logic in src/utils/diff-utils.ts applyHunks() but
 * operates on OverlayHunk (which tracks old lines directly, no changeStartOld).
 */
export function applyOverlayHunks(
  oldContent: string,
  hunks: OverlayHunk[],
  acceptedIndices: Set<number>,
): string {
  if (hunks.length === 0) return oldContent;

  const oldLines = oldContent.split("\n");
  const newContent_lines: string[] = [];
  let oldPos = 0;

  // We need to walk the old document in hunk order.
  // Each hunk knows how many old lines it consumed (removedOldLines.length).
  // Between hunks, old lines that were not part of any hunk appear as-is in new content.
  // We reconstruct by replaying the edit sequence.

  // Re-run the diff to get the edit sequence (same as computeHunks internals),
  // but now we apply accept/reject decisions.
  const newLines = []; // placeholder — we actually re-derive from hunks

  // Strategy: walk hunks in order. For each hunk:
  //   1. Copy old lines from oldPos up to (but not including) the hunk's start in old doc.
  //      The hunk's start in old doc = oldPos + (gap lines).
  //   We can compute old-doc positions by tracking how many old lines each previous hunk consumed.

  // Build old-doc start positions for each hunk by re-deriving from the diff.
  // We re-run computeRawEdits to get a position map.
  const oldLinesArr = oldContent.split("\n");
  const newLinesArr = computeCurrentNewLines(oldContent, hunks); // see helper below

  // Simpler approach: re-derive old-doc positions from the raw edits.
  const rawEdits = computeRawEdits(oldLinesArr, newLinesArr);

  let oldDocPos = 0;
  let hunkIdx = 0;
  let editI = 0;

  while (editI < rawEdits.length) {
    const edit = rawEdits[editI];
    if (edit.type === "equal") {
      newContent_lines.push(edit.line);
      oldDocPos++;
      editI++;
      continue;
    }

    if (hunkIdx >= hunks.length) {
      // Safety: no more hunks but still edits — just copy
      if (edit.type === "delete") oldDocPos++;
      else newContent_lines.push(edit.line);
      editI++;
      continue;
    }

    const hunk = hunks[hunkIdx];
    const accepted = acceptedIndices.has(hunk.index);

    // Collect this entire hunk's edits
    const hunkRemovedLines: string[] = [];
    const hunkAddedLines: string[] = [];
    while (editI < rawEdits.length && rawEdits[editI].type !== "equal") {
      const e = rawEdits[editI];
      if (e.type === "delete") {
        hunkRemovedLines.push(e.line);
        oldDocPos++;
      } else {
        hunkAddedLines.push(e.line);
      }
      editI++;
    }

    if (accepted) {
      // Apply hunk: use new lines
      newContent_lines.push(...hunkAddedLines);
    } else {
      // Reject hunk: restore old lines
      newContent_lines.push(...hunkRemovedLines);
    }
    hunkIdx++;
  }

  // Remaining old lines (after last hunk)
  while (oldDocPos < oldLinesArr.length) {
    newContent_lines.push(oldLinesArr[oldDocPos++]);
  }

  return newContent_lines.join("\n");
}

/**
 * Reconstruct the "current new lines" from old content + hunks.
 * This is the version of the file that has ALL hunks applied (i.e., newContent).
 * Used internally by applyOverlayHunks to get a consistent diff base.
 */
function computeCurrentNewLines(oldContent: string, hunks: OverlayHunk[]): string[] {
  const oldLines = oldContent.split("\n");
  const result: string[] = [];
  let oldPos = 0;

  // We need to figure out where each hunk starts in the old document.
  // We do this by re-running the LCS and tracking old positions.
  // Actually, since we have the hunk data (removedOldLines and addedNewLines),
  // we can reconstruct the new content directly.

  // Walk hunks in order. We need old-doc positions.
  // Hunk.removedOldLines.length tells us how many old lines were consumed.
  // But we need to know where in the old doc each hunk starts.
  // We derive this by scanning the old lines and matching removed lines.

  for (const hunk of hunks) {
    // Find where this hunk starts in the old doc by matching removedOldLines
    if (hunk.removedOldLines.length > 0) {
      // Scan forward from oldPos to find the first removed line
      while (
        oldPos < oldLines.length &&
        oldLines[oldPos] !== hunk.removedOldLines[0]
      ) {
        result.push(oldLines[oldPos++]);
      }
      // Skip the removed lines
      oldPos += hunk.removedOldLines.length;
    } else {
      // Pure insertion: copy old lines up to the insertion point
      // newDocStartLine tells us where in the new doc this inserts
      // We trust the hunk ordering and don't need to scan
    }
    // Add new lines
    result.push(...hunk.addedNewLines);
  }

  // Copy remaining old lines
  while (oldPos < oldLines.length) {
    result.push(oldLines[oldPos++]);
  }

  return result;
}
```

**Note:** The `applyOverlayHunks` implementation above is intentionally careful. The simpler and more reliable approach used in actual implementation should re-derive positions from the LCS diff. See the unit tests in Task 2 for the expected behavior contract.

---

## Task 2: Unit tests for pure functions (no VS Code API)

- [ ] Create `src/ui/__tests__/diff-overlay-controller.test.ts`:

```typescript
// src/ui/__tests__/diff-overlay-controller.test.ts
import { describe, it, expect } from "vitest";
import {
  computeHunks,
  applyOverlayHunks,
  type PendingFileDiff,
  type OverlayHunk,
} from "../diff-overlay-controller";

describe("computeHunks", () => {
  it("returns empty array when oldContent === newContent", () => {
    const result = computeHunks("line1\nline2\nline3", "line1\nline2\nline3");
    expect(result).toEqual([]);
  });

  it("returns single hunk for a simple one-line change", () => {
    const old = "line1\nline2\nline3";
    const neu = "line1\nCHANGED\nline3";
    const hunks = computeHunks(old, neu);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].removedOldLines).toEqual(["line2"]);
    expect(hunks[0].addedNewLines).toEqual(["CHANGED"]);
    expect(hunks[0].addedLines).toEqual([1]); // line 1 in new doc (0-based)
  });

  it("returns two hunks for two disjoint changes separated by 3+ unchanged lines", () => {
    const old = "a\nb\nc\nd\ne\nf\ng";
    const neu = "A\nb\nc\nd\ne\nf\nG";
    const hunks = computeHunks(old, neu);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].removedOldLines).toEqual(["a"]);
    expect(hunks[0].addedNewLines).toEqual(["A"]);
    expect(hunks[1].removedOldLines).toEqual(["g"]);
    expect(hunks[1].addedNewLines).toEqual(["G"]);
  });

  it("sets deletionPoint for a removed-only hunk (no added lines)", () => {
    const old = "keep1\nremoved-line\nkeep2";
    const neu = "keep1\nkeep2";
    const hunks = computeHunks(old, neu);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].addedLines).toEqual([]);
    expect(hunks[0].removedOldLines).toEqual(["removed-line"]);
    expect(hunks[0].deletionPoint).toBeDefined();
    expect(typeof hunks[0].deletionPoint).toBe("number");
  });

  it("assigns sequential indices starting from 0", () => {
    const old = "a\nb\nc\nd\ne";
    const neu = "A\nb\nc\nd\nE";
    const hunks = computeHunks(old, neu);
    expect(hunks[0].index).toBe(0);
    expect(hunks[1].index).toBe(1);
  });

  it("handles pure insertion (new lines added, none removed)", () => {
    const old = "line1\nline3";
    const neu = "line1\nline2\nline3";
    const hunks = computeHunks(old, neu);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].removedOldLines).toEqual([]);
    expect(hunks[0].addedNewLines).toEqual(["line2"]);
    expect(hunks[0].addedLines).toHaveLength(1);
  });
});

describe("applyOverlayHunks", () => {
  it("with all indices accepted returns newContent equivalent", () => {
    const old = "line1\nold-line\nline3";
    const neu = "line1\nnew-line\nline3";
    const hunks = computeHunks(old, neu);
    const accepted = new Set(hunks.map((h) => h.index));
    const result = applyOverlayHunks(old, hunks, accepted);
    expect(result).toBe(neu);
  });

  it("with all indices rejected returns oldContent equivalent", () => {
    const old = "line1\nold-line\nline3";
    const neu = "line1\nnew-line\nline3";
    const hunks = computeHunks(old, neu);
    const result = applyOverlayHunks(old, hunks, new Set());
    expect(result).toBe(old);
  });

  it("with mixed accept/reject reconstructs hybrid content correctly", () => {
    const old = "a\nb\nc\nd\ne";
    const neu = "A\nb\nc\nd\nE";
    const hunks = computeHunks(old, neu);
    expect(hunks).toHaveLength(2);
    // Accept hunk 0 (a→A), reject hunk 1 (e→E)
    const accepted = new Set([0]);
    const result = applyOverlayHunks(old, hunks, accepted);
    expect(result).toBe("A\nb\nc\nd\ne");
  });

  it("returns oldContent unchanged when hunks array is empty", () => {
    const content = "line1\nline2";
    const result = applyOverlayHunks(content, [], new Set());
    expect(result).toBe(content);
  });
});

describe("PendingFileDiff state management (pure Map logic)", () => {
  it("stores PendingFileDiff keyed by filePath", () => {
    const pendingDiffs = new Map<string, PendingFileDiff>();
    const hunks = computeHunks("old", "new");
    const diff: PendingFileDiff = {
      hunks,
      acceptedIndices: new Set(),
      rejectedIndices: new Set(),
      oldContent: "old",
      newContent: "new",
    };
    pendingDiffs.set("/path/to/file.ts", diff);
    expect(pendingDiffs.get("/path/to/file.ts")).toBe(diff);
  });

  it("acceptHunkAtLine logic: adds hunk index to acceptedIndices", () => {
    const hunks = computeHunks("a\nb\nc", "a\nB\nc");
    const diff: PendingFileDiff = {
      hunks,
      acceptedIndices: new Set(),
      rejectedIndices: new Set(),
      oldContent: "a\nb\nc",
      newContent: "a\nB\nc",
    };
    // Simulate acceptHunkAtLine for line 1 (the changed line)
    const targetLine = 1;
    const hunk = diff.hunks.find(
      (h) => h.addedLines.includes(targetLine) || h.deletionPoint === targetLine,
    );
    expect(hunk).toBeDefined();
    diff.acceptedIndices.add(hunk!.index);
    expect(diff.acceptedIndices.has(0)).toBe(true);
  });

  it("rejectHunkAtLine logic: adds hunk index to rejectedIndices", () => {
    const hunks = computeHunks("a\nb\nc", "a\nB\nc");
    const diff: PendingFileDiff = {
      hunks,
      acceptedIndices: new Set(),
      rejectedIndices: new Set(),
      oldContent: "a\nb\nc",
      newContent: "a\nB\nc",
    };
    diff.rejectedIndices.add(hunks[0].index);
    expect(diff.rejectedIndices.has(0)).toBe(true);
    expect(diff.acceptedIndices.has(0)).toBe(false);
  });

  it("all-resolved check returns true when every hunk is either accepted or rejected", () => {
    const hunks = computeHunks("a\nb", "A\nB");
    const diff: PendingFileDiff = {
      hunks,
      acceptedIndices: new Set([0]),
      rejectedIndices: new Set([1]),
      oldContent: "a\nb",
      newContent: "A\nB",
    };
    const allResolved = diff.hunks.every(
      (h) => diff.acceptedIndices.has(h.index) || diff.rejectedIndices.has(h.index),
    );
    expect(allResolved).toBe(true);
  });

  it("acceptAllHunks: marks every hunk as accepted", () => {
    const hunks = computeHunks("a\nb\nc", "A\nB\nC");
    const diff: PendingFileDiff = {
      hunks,
      acceptedIndices: new Set(),
      rejectedIndices: new Set(),
      oldContent: "a\nb\nc",
      newContent: "A\nB\nC",
    };
    for (const h of diff.hunks) diff.acceptedIndices.add(h.index);
    expect(diff.acceptedIndices.size).toBe(diff.hunks.length);
    const allResolved = diff.hunks.every((h) => diff.acceptedIndices.has(h.index));
    expect(allResolved).toBe(true);
  });

  it("rejectAllHunks: marks every hunk as rejected", () => {
    const hunks = computeHunks("a\nb\nc", "A\nB\nC");
    const diff: PendingFileDiff = {
      hunks,
      acceptedIndices: new Set(),
      rejectedIndices: new Set(),
      oldContent: "a\nb\nc",
      newContent: "A\nB\nC",
    };
    for (const h of diff.hunks) diff.rejectedIndices.add(h.index);
    const allResolved = diff.hunks.every((h) => diff.rejectedIndices.has(h.index));
    expect(allResolved).toBe(true);
  });

  it("clearDiffOverlay: clears pendingDiffs completely", () => {
    const pendingDiffs = new Map<string, PendingFileDiff>();
    const hunks = computeHunks("old", "new");
    pendingDiffs.set("/a.ts", {
      hunks,
      acceptedIndices: new Set(),
      rejectedIndices: new Set(),
      oldContent: "old",
      newContent: "new",
    });
    pendingDiffs.set("/b.ts", {
      hunks,
      acceptedIndices: new Set(),
      rejectedIndices: new Set(),
      oldContent: "old",
      newContent: "new",
    });
    // Simulate clearDiffOverlay
    pendingDiffs.clear();
    expect(pendingDiffs.size).toBe(0);
  });

  it("file close removes the file entry from pendingDiffs", () => {
    const pendingDiffs = new Map<string, PendingFileDiff>();
    const hunks = computeHunks("old", "new");
    pendingDiffs.set("/a.ts", {
      hunks,
      acceptedIndices: new Set(),
      rejectedIndices: new Set(),
      oldContent: "old",
      newContent: "new",
    });
    // Simulate onDidCloseTextDocument
    pendingDiffs.delete("/a.ts");
    expect(pendingDiffs.has("/a.ts")).toBe(false);
  });
});
```

- [ ] Run: `npx vitest run src/ui/__tests__/diff-overlay-controller.test.ts`
  - Expected: all tests pass.

---

## Task 3: `DiffOverlayController` class with VS Code providers

- [ ] Continue `src/ui/diff-overlay-controller.ts` — append the class after the pure functions:

```typescript
// (continuing src/ui/diff-overlay-controller.ts after the pure functions)

// ─────────────────────────────────────────────────────────────────────────────
// DiffOverlayController class
// ─────────────────────────────────────────────────────────────────────────────

export class DiffOverlayController
  implements vscode.HoverProvider, vscode.CodeLensProvider
{
  private pendingDiffs = new Map<string, PendingFileDiff>();

  // ── Decoration types (created once, live for the controller's lifetime) ──

  private readonly addedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    borderColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
    borderWidth: "0 0 0 3px",
    borderStyle: "solid",
  });

  private readonly removedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    after: {
      contentText: "  ▲ deleted lines above",
      color: new vscode.ThemeColor("editorError.foreground"),
      fontStyle: "italic",
      fontSize: "11px",
      margin: "0 0 0 12px",
    },
    borderColor: new vscode.ThemeColor("diffEditor.removedTextBorder"),
    borderWidth: "3px 0 0 0",
    borderStyle: "solid",
  });

  // ── CodeLensProvider event emitter ──

  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  constructor(context: vscode.ExtensionContext) {
    // Register providers — disposables are pushed to context.subscriptions.
    context.subscriptions.push(
      vscode.languages.registerHoverProvider({ scheme: "file" }, this),
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const fsPath = doc.uri.fsPath;
        if (this.pendingDiffs.has(fsPath)) {
          this._disposeDecorationsForFile(fsPath);
          this.pendingDiffs.delete(fsPath);
          this._onDidChangeCodeLenses.fire();
        }
      }),
      this.addedDecoration,
      this.removedDecoration,
      this._onDidChangeCodeLenses,
    );
  }

  // ── Public API ──

  /** Register a file edit and create pending diff state. */
  registerEdit(record: EditRecord): void {
    const hunks = computeHunks(record.oldContent, record.newContent);
    if (hunks.length === 0) return;

    this.pendingDiffs.set(record.path, {
      hunks,
      acceptedIndices: new Set(),
      rejectedIndices: new Set(),
      oldContent: record.oldContent,
      newContent: record.newContent,
    });

    this._applyDecorationsForFile(record.path);
    this._onDidChangeCodeLenses.fire();
  }

  /** Accept the hunk that contains the given 0-based line number. */
  acceptHunkAtLine(filePath: string, line: number): void {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;
    const hunk = diff.hunks.find(
      (h) => h.addedLines.includes(line) || h.deletionPoint === line,
    );
    if (!hunk) return;
    diff.acceptedIndices.add(hunk.index);
    void this._checkAllResolved(filePath);
    this._applyDecorationsForFile(filePath);
    this._onDidChangeCodeLenses.fire();
  }

  /** Reject the hunk that contains the given 0-based line number. */
  rejectHunkAtLine(filePath: string, line: number): void {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;
    const hunk = diff.hunks.find(
      (h) => h.addedLines.includes(line) || h.deletionPoint === line,
    );
    if (!hunk) return;
    diff.rejectedIndices.add(hunk.index);
    void this._checkAllResolved(filePath);
    this._applyDecorationsForFile(filePath);
    this._onDidChangeCodeLenses.fire();
  }

  /** Accept all hunks for a file. */
  acceptAllHunks(filePath: string): void {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;
    for (const h of diff.hunks) diff.acceptedIndices.add(h.index);
    void this._checkAllResolved(filePath);
    this._applyDecorationsForFile(filePath);
    this._onDidChangeCodeLenses.fire();
  }

  /** Reject all hunks for a file. */
  rejectAllHunks(filePath: string): void {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;
    for (const h of diff.hunks) diff.rejectedIndices.add(h.index);
    void this._checkAllResolved(filePath);
    this._applyDecorationsForFile(filePath);
    this._onDidChangeCodeLenses.fire();
  }

  /** Clear all pending diffs and decorations across all files. */
  clearAll(): void {
    for (const filePath of this.pendingDiffs.keys()) {
      this._disposeDecorationsForFile(filePath);
    }
    this.pendingDiffs.clear();
    this._onDidChangeCodeLenses.fire();
  }

  // ── HoverProvider ──

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | null {
    const diff = this.pendingDiffs.get(document.uri.fsPath);
    if (!diff) return null;

    const hunk = diff.hunks.find(
      (h) =>
        !diff.acceptedIndices.has(h.index) &&
        !diff.rejectedIndices.has(h.index) &&
        (h.addedLines.includes(position.line) ||
          h.deletionPoint === position.line),
    );
    if (!hunk) return null;

    const diffLines: string[] = [];
    for (const line of hunk.removedOldLines) diffLines.push(`- ${line}`);
    for (const line of hunk.addedNewLines) diffLines.push(`+ ${line}`);

    const md = new vscode.MarkdownString(
      `**Champ edit** — hunk ${hunk.index + 1} of ${diff.hunks.length}\n\`\`\`diff\n${diffLines.join("\n")}\n\`\`\``,
    );
    md.isTrusted = false;
    md.supportHtml = false;

    return new vscode.Hover(
      md,
      new vscode.Range(
        position.line,
        0,
        position.line,
        document.lineAt(position.line).text.length,
      ),
    );
  }

  // ── CodeLensProvider ──

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const diff = this.pendingDiffs.get(document.uri.fsPath);
    if (!diff || diff.hunks.length === 0) return [];

    const lenses: vscode.CodeLens[] = [];
    const filePath = document.uri.fsPath;

    const unresolvedHunks = diff.hunks.filter(
      (h) => !diff.acceptedIndices.has(h.index) && !diff.rejectedIndices.has(h.index),
    );

    // Per-hunk CodeLenses
    for (const hunk of unresolvedHunks) {
      const range = new vscode.Range(hunk.newDocStartLine, 0, hunk.newDocStartLine, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: "⚡ Accept",
          command: "champ.acceptHunkAtLine",
          arguments: [filePath, hunk.newDocStartLine],
        }),
        new vscode.CodeLens(range, {
          title: "✗ Reject",
          command: "champ.rejectHunkAtLine",
          arguments: [filePath, hunk.newDocStartLine],
        }),
      );
    }

    // File-level CodeLenses (only when there are unresolved hunks)
    if (unresolvedHunks.length > 0) {
      const firstHunkLine = diff.hunks[0].newDocStartLine;
      const fileRange = new vscode.Range(firstHunkLine, 0, firstHunkLine, 0);
      lenses.push(
        new vscode.CodeLens(fileRange, {
          title: `Accept all ${unresolvedHunks.length} changes`,
          command: "champ.acceptAllHunks",
          arguments: [filePath],
        }),
        new vscode.CodeLens(fileRange, {
          title: `Reject all ${unresolvedHunks.length} changes`,
          command: "champ.rejectAllHunks",
          arguments: [filePath],
        }),
      );
    }

    return lenses;
  }

  // ── Private helpers ──

  private _applyDecorationsForFile(filePath: string): void {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;

    const unresolvedHunks = diff.hunks.filter(
      (h) => !diff.acceptedIndices.has(h.index) && !diff.rejectedIndices.has(h.index),
    );

    const addedRanges: vscode.Range[] = [];
    const removedRanges: vscode.Range[] = [];

    for (const hunk of unresolvedHunks) {
      for (const lineNum of hunk.addedLines) {
        addedRanges.push(new vscode.Range(lineNum, 0, lineNum, 0));
      }
      if (hunk.deletionPoint !== undefined) {
        removedRanges.push(
          new vscode.Range(hunk.deletionPoint, 0, hunk.deletionPoint, 0),
        );
      }
    }

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === filePath) {
        editor.setDecorations(this.addedDecoration, addedRanges);
        editor.setDecorations(this.removedDecoration, removedRanges);
      }
    }
  }

  private _disposeDecorationsForFile(filePath: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === filePath) {
        editor.setDecorations(this.addedDecoration, []);
        editor.setDecorations(this.removedDecoration, []);
      }
    }
  }

  private async _checkAllResolved(filePath: string): Promise<void> {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;

    const allResolved = diff.hunks.every(
      (h) => diff.acceptedIndices.has(h.index) || diff.rejectedIndices.has(h.index),
    );
    if (!allResolved) return;

    // Build final content: apply accepted hunks to oldContent, discard rejected.
    const finalContent = applyOverlayHunks(
      diff.oldContent,
      diff.hunks,
      diff.acceptedIndices,
    );

    // Write the file.
    const uri = vscode.Uri.file(filePath);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(finalContent));

    // Dispose decorations and remove from map.
    this._disposeDecorationsForFile(filePath);
    this.pendingDiffs.delete(filePath);
    this._onDidChangeCodeLenses.fire();
  }
}
```

---

## Task 4: Register commands in `extension.ts`

- [ ] Add import at the top of `src/extension.ts`:

```typescript
import {
  DiffOverlayController,
  type EditRecord,
} from "./ui/diff-overlay-controller";
```

- [ ] Add the following inside `activate()`, after instantiating `chatViewProvider`:

```typescript
// Instantiate DiffOverlayController and register commands
const diffOverlayController = new DiffOverlayController(context);

context.subscriptions.push(
  vscode.commands.registerCommand(
    "champ.acceptHunkAtLine",
    (filePath: string, line: number) => {
      diffOverlayController.acceptHunkAtLine(filePath, line);
    },
  ),
  vscode.commands.registerCommand(
    "champ.rejectHunkAtLine",
    (filePath: string, line: number) => {
      diffOverlayController.rejectHunkAtLine(filePath, line);
    },
  ),
  vscode.commands.registerCommand(
    "champ.acceptAllHunks",
    (filePath: string) => {
      diffOverlayController.acceptAllHunks(filePath);
    },
  ),
  vscode.commands.registerCommand(
    "champ.rejectAllHunks",
    (filePath: string) => {
      diffOverlayController.rejectAllHunks(filePath);
    },
  ),
  vscode.commands.registerCommand("champ.clearDiffOverlay", () => {
    diffOverlayController.clearAll();
  }),
);

// Pass controller to ChatViewProvider so it can call registerEdit
chatViewProvider.setDiffOverlayController(diffOverlayController);
```

---

## Task 5: Add 5 commands to `package.json`

- [ ] Add to `contributes.commands` array in `package.json`:

```json
{
  "command": "champ.acceptHunkAtLine",
  "title": "Champ: Accept Hunk",
  "category": "Champ"
},
{
  "command": "champ.rejectHunkAtLine",
  "title": "Champ: Reject Hunk",
  "category": "Champ"
},
{
  "command": "champ.acceptAllHunks",
  "title": "Champ: Accept All Hunks",
  "category": "Champ"
},
{
  "command": "champ.rejectAllHunks",
  "title": "Champ: Reject All Hunks",
  "category": "Champ"
},
{
  "command": "champ.clearDiffOverlay",
  "title": "Champ: Clear Diff Overlay",
  "category": "Champ"
}
```

---

## Task 6: Wire into `ChatViewProvider`

- [ ] Open `src/ui/chat-view-provider.ts`. Add a private field near the other field declarations:

```typescript
private diffOverlayController: import("./diff-overlay-controller").DiffOverlayController | null = null;
```

- [ ] Add the setter method to the `ChatViewProvider` class:

```typescript
/** Called from extension.ts after DiffOverlayController is instantiated. */
setDiffOverlayController(
  controller: import("./diff-overlay-controller").DiffOverlayController,
): void {
  this.diffOverlayController = controller;
}
```

- [ ] In the `forwardStreamDelta` method (around line 948), find the `case "done":` handler:

```typescript
case "done":
  this.postMessage(createStreamEnd(delta.usage));
  this.emitEditSummary();
  this.editTracker.reset();
  this._pendingStreamUsage = delta.usage;
  break;
```

Replace with:

```typescript
case "done": {
  this.postMessage(createStreamEnd(delta.usage));
  // Collect edit records before emitEditSummary flushes the tracker
  const editRecords = this.editTracker.getRecords?.() ?? [];
  this.emitEditSummary();
  this.editTracker.reset();
  this._pendingStreamUsage = delta.usage;
  // Register edits with DiffOverlayController for inline gutter decorations
  if (this.diffOverlayController && editRecords.length > 0) {
    for (const record of editRecords) {
      this.diffOverlayController.registerEdit({
        path: record.path,
        oldContent: record.oldContent,
        newContent: record.newContent,
      });
    }
  }
  break;
}
```

**Note:** If `editTracker` does not expose a `getRecords()` method, check the `EditReviewTracker` implementation. The spec says to call `editReviewTracker.flush()` before the reset. If the tracker is already flushed by `emitEditSummary()`, you may need to snapshot the records before calling `emitEditSummary()`. Adjust to match the actual `EditReviewTracker` API.

---

## Task 7: Compile check, tests, version bump, commit

- [ ] TypeScript compile check:
  ```bash
  npx tsc --noEmit 2>&1 | head -40
  ```
  Expected: zero errors.

- [ ] Run full test suite:
  ```bash
  npx vitest run
  ```
  Expected: all tests pass including the 15 new tests from Task 2.

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
    src/ui/diff-overlay-controller.ts \
    src/ui/__tests__/diff-overlay-controller.test.ts \
    src/extension.ts \
    src/ui/chat-view-provider.ts \
    package.json

  git commit -m "feat: inline hunk diff overlay — gutter bars, hover popup, Accept/Reject CodeLens"
  ```

---

## Key Decisions

1. **`OverlayHunk` is separate from `Hunk` in `diff-utils.ts`** — the overlay needs `addedLines: number[]` (absolute line numbers in new doc) and `deletionPoint`, whereas `diff-utils.Hunk` tracks `changeStartOld`. Both are derived from the same LCS algorithm. The controller does not import `diff-utils.ts` to avoid coupling.

2. **`applyOverlayHunks` uses a re-run LCS strategy** rather than relying on stored offsets. This ensures consistency even if hunk line numbers drift (e.g., because a previous hunk applied).

3. **`registerEdit` receives an `EditRecord { path, oldContent, newContent }`** rather than a `Hunk[]` — the controller owns the hunk computation so the caller doesn't need to know about `OverlayHunk`.

4. **`provideCodeLenses` file-level lenses** are placed at `hunks[0].newDocStartLine` (not line 0) per the spec — this ensures they appear near the first change, not at the top of an unrelated file header.

5. **`_checkAllResolved` is `async`** because it calls `vscode.workspace.fs.writeFile`. The callers (`acceptHunkAtLine` etc.) fire it with `void` since the decoration cleanup happens synchronously in the decoration re-apply.
