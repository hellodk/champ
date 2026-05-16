# Spec: Inline Hunk Diff Overlay

**Date**: 2026-05-16
**Sprint**: 2

---

## Goal

Render per-hunk inline diff decorations in VS Code text editors — gutter color bars, hover popups showing old vs new content, and Accept/Reject CodeLens actions — as an additive layer on top of the existing bulk edit-summary panel.

---

## Architecture

`DiffOverlayController` (new class in `src/ui/diff-overlay-controller.ts`) is instantiated once in `src/extension.ts` and passed to `ChatViewProvider`. After `ChatViewProvider` calls `emitEditSummary()` (which sends the `editSummary` message to the webview), it also calls `diffOverlayController.registerEdit(record)` for each `EditRecord` from `EditReviewTracker.flush()`. `DiffOverlayController` registers three VS Code API providers:

- `vscode.TextEditorDecorationType` (two instances: one for added lines, one for deleted-line indicators) — registered once on construction via `vscode.window.createTextEditorDecorationType()`
- `vscode.HoverProvider` — registered once via `vscode.languages.registerHoverProvider({ scheme: "file" }, controller)` inside the constructor
- `vscode.CodeLensProvider` — registered once via `vscode.languages.registerCodeLensProvider({ scheme: "file" }, controller)` inside the constructor

The controller fires `_onDidChangeCodeLenses` (a `vscode.EventEmitter<void>`) to refresh CodeLenses when hunk state changes. All provider registrations are pushed onto the `ExtensionContext.subscriptions` array passed to the constructor. Decorations are disposed per-file when all hunks in that file are resolved, or globally when `champ.clearDiffOverlay` is called, or when the controlling document is closed.

---

## Gutter Decorations

### Added Lines (green)

Applied to every line in the new document that belongs to a hunk's "added" set (lines present in `newContent` but absent or changed from `oldContent`).

```typescript
const addedDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  overviewRulerColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
  borderColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
  borderWidth: "0 0 0 3px",
  borderStyle: "solid",
});
```

### Removed-Line Indicator (red)

Removed lines do not exist in the new document. Their presence is indicated by a single-line decoration applied to the line **immediately after** the deletion point (the line at index `deletionPoint` in the new document, where `deletionPoint` is the 0-based line index before which the deletion occurred). If the deletion is at the very end of the file (all remaining lines removed), the decoration is applied to the last line of the new document.

```typescript
const removedDecoration = vscode.window.createTextEditorDecorationType({
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
```

### Hunk Parsing for Decoration Placement

Hunks are computed from `(oldContent, newContent)` using the Myers diff algorithm (or any correct O(ND) diff). The implementation uses a `computeHunks(oldContent: string, newContent: string): Hunk[]` pure function in `src/ui/diff-overlay-controller.ts`.

```typescript
export interface Hunk {
  /** 0-based index of this hunk in the file's hunk list. */
  index: number;
  /**
   * Lines in the new document that are "added" (changed or inserted).
   * Array of 0-based line numbers in the new document.
   */
  addedLines: number[];
  /**
   * The deletion point in the new document for removed-only hunks.
   * Only present if the hunk contains removed lines but zero added lines.
   * This is the 0-based line number in the new document immediately after
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
```

---

## Hover Provider

`DiffOverlayController` implements `vscode.HoverProvider`. The `provideHover(document, position)` method:

1. Look up `pendingDiffs.get(document.uri.fsPath)`. If not found, return `null`.
2. Find the hunk whose `addedLines` includes `position.line`, or whose `deletionPoint === position.line`. If no match, return `null`.
3. If the hunk has already been accepted or rejected (`acceptedIndices` or `rejectedIndices` contains `hunk.index`), return `null`.
4. Build a `vscode.MarkdownString`:

```markdown
```diff
- old line 1
- old line 2
+ new line 1
+ new line 2
```
```

Exact format: a single fenced code block with language `diff`. Removed lines are prefixed with `"- "` (hyphen-space). Added lines are prefixed with `"+ "` (plus-space). Hunk boundary is not repeated in the popup body — the title above the code block is:

```
**Champ edit** — hunk ${hunk.index + 1} of ${pendingDiff.hunks.length}
```

The `MarkdownString` has `isTrusted = false` and `supportHtml = false`.

Full `vscode.Hover` return value:

```typescript
return new vscode.Hover(
  markdownContent,
  new vscode.Range(position.line, 0, position.line, document.lineAt(position.line).text.length),
);
```

---

## CodeLens Provider

`DiffOverlayController` implements `vscode.CodeLensProvider`. The `provideCodeLenses(document)` method returns an array of `vscode.CodeLens` objects.

### Per-Hunk CodeLenses

For each unresolved hunk (not in `acceptedIndices` or `rejectedIndices`), add **two** `CodeLens` instances, both placed on the line `hunk.newDocStartLine`:

```typescript
new vscode.CodeLens(
  new vscode.Range(hunk.newDocStartLine, 0, hunk.newDocStartLine, 0),
  {
    title: "⚡ Accept",
    command: "champ.acceptHunkAtLine",
    arguments: [document.uri.fsPath, hunk.newDocStartLine],
  },
),
new vscode.CodeLens(
  new vscode.Range(hunk.newDocStartLine, 0, hunk.newDocStartLine, 0),
  {
    title: "✗ Reject",
    command: "champ.rejectHunkAtLine",
    arguments: [document.uri.fsPath, hunk.newDocStartLine],
  },
),
```

### File-Level CodeLenses

Add two more `CodeLens` instances at line 0 of the first unresolved hunk's `newDocStartLine` — specifically, at the `newDocStartLine` of `hunks[0]` (the first hunk in the file, whether resolved or not):

```typescript
const unresolvedCount = hunks.filter(
  (h) => !acceptedIndices.has(h.index) && !rejectedIndices.has(h.index),
).length;

new vscode.CodeLens(
  new vscode.Range(hunks[0].newDocStartLine, 0, hunks[0].newDocStartLine, 0),
  {
    title: `Accept all ${unresolvedCount} changes`,
    command: "champ.acceptAllHunks",
    arguments: [document.uri.fsPath],
  },
),
new vscode.CodeLens(
  new vscode.Range(hunks[0].newDocStartLine, 0, hunks[0].newDocStartLine, 0),
  {
    title: `Reject all ${unresolvedCount} changes`,
    command: "champ.rejectAllHunks",
    arguments: [document.uri.fsPath],
  },
),
```

The file-level CodeLenses are omitted when `unresolvedCount === 0`.

### Commands Registered in `package.json`

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

All 5 commands are registered in `src/extension.ts` and listed in `package.json`'s `contributes.commands`.

---

## State Management

### Core Types

```typescript
// src/ui/diff-overlay-controller.ts

export interface PendingFileDiff {
  hunks: Hunk[];
  acceptedIndices: Set<number>;
  rejectedIndices: Set<number>;
  oldContent: string;
  newContent: string;
}
```

`DiffOverlayController` holds:

```typescript
private pendingDiffs = new Map<string, PendingFileDiff>();
```

Key: absolute `filePath` string (matches `document.uri.fsPath`).

### `registerEdit(record: EditRecord): void`

1. Compute `hunks = computeHunks(record.oldContent, record.newContent)`.
2. If `hunks.length === 0`, return immediately (no changes to show).
3. Store:
   ```typescript
   this.pendingDiffs.set(record.path, {
     hunks,
     acceptedIndices: new Set(),
     rejectedIndices: new Set(),
     oldContent: record.oldContent,
     newContent: record.newContent,
   });
   ```
4. Apply decorations to any currently-open editor for this file.
5. Fire `this._onDidChangeCodeLenses.fire()`.

### `acceptHunkAtLine(filePath: string, line: number): void`

1. Look up `pendingDiff = pendingDiffs.get(filePath)`. If absent, return.
2. Find `hunk` where `hunk.addedLines.includes(line) || hunk.deletionPoint === line`.
3. Add `hunk.index` to `pendingDiff.acceptedIndices`.
4. Call `_checkAllResolved(filePath)`.
5. Fire `_onDidChangeCodeLenses`.
6. Re-apply decorations.

### `rejectHunkAtLine(filePath: string, line: number): void`

Same as accept but adds to `rejectedIndices` instead.

### `acceptAllHunks(filePath: string): void`

Add all hunk indices to `acceptedIndices`, then call `_checkAllResolved(filePath)` and fire events.

### `rejectAllHunks(filePath: string): void`

Add all hunk indices to `rejectedIndices`, then call `_checkAllResolved(filePath)` and fire events.

### `_checkAllResolved(filePath: string): void`

```typescript
private async _checkAllResolved(filePath: string): Promise<void> {
  const diff = this.pendingDiffs.get(filePath);
  if (!diff) return;
  const allResolved = diff.hunks.every(
    (h) => diff.acceptedIndices.has(h.index) || diff.rejectedIndices.has(h.index),
  );
  if (!allResolved) return;

  // Build final content: apply accepted hunks to oldContent, discard rejected.
  const finalContent = applyHunks(diff.oldContent, diff.hunks, diff.acceptedIndices);

  // Write the file.
  const uri = vscode.Uri.file(filePath);
  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(uri, encoder.encode(finalContent));

  // Dispose decorations for this file.
  this._disposeDecorationsForFile(filePath);
  this.pendingDiffs.delete(filePath);
  this._onDidChangeCodeLenses.fire();
}
```

`applyHunks(oldContent, hunks, acceptedIndices)` is a pure function that reconstructs file content by applying only the accepted hunks. Rejected hunks revert to the original old lines for those regions.

---

## Integration with EditReviewTracker

After `ChatViewProvider` calls `editReviewTracker.flush()` and sends the `editSummary` message to the webview:

```typescript
// In ChatViewProvider, after emitEditSummary():
for (const record of editRecords) {
  this.diffOverlayController.registerEdit(record);
}
```

`ChatViewProvider` receives a `diffOverlayController: DiffOverlayController` in its constructor (passed from `src/extension.ts`). The existing `editSummary` webview panel is unchanged — the overlay is purely additive. Users can accept/reject hunks either through the CodeLens actions in the editor OR through the bulk editSummary panel buttons; whichever fires first wins (accepting via the panel clears the overlay via `diffOverlayController.acceptAllHunks(filePath)`).

---

## Lifecycle

### Decoration Application

`_applyDecorationsForFile(filePath: string): void` finds all visible editors where `editor.document.uri.fsPath === filePath` and sets decorations:

```typescript
editor.setDecorations(this.addedDecoration, addedRanges);
editor.setDecorations(this.removedDecoration, removedRanges);
```

Where `addedRanges` is `vscode.Range[]` built from each unresolved hunk's `addedLines`, and `removedRanges` is built from each unresolved hunk's `deletionPoint` (if present).

### Disposal Triggers

| Event | Action |
|---|---|
| All hunks in a file accepted/rejected | `_disposeDecorationsForFile(filePath)`, delete from `pendingDiffs` |
| `vscode.workspace.onDidCloseTextDocument` | If `doc.uri.fsPath` is in `pendingDiffs`, remove decorations and delete entry |
| `champ.clearDiffOverlay` command | Clear all decorations for all files, clear `pendingDiffs`, fire `_onDidChangeCodeLenses` |
| VS Code restart | `pendingDiffs` is in-memory only — not persisted. Overlay is not restored |

### On VS Code Restart

The overlay is session-scoped. When VS Code restarts, the file on disk retains the `newContent` as written by the agent (the agent's edit has already been applied to disk). The overlay decorations are not restored. The user sees the post-edit state of the file with no decorations.

---

## Testing

### Unit Tests (new file: `src/test/diff-overlay-controller.test.ts`)

Tests use a fake `vscode` namespace — no real VS Code API is called.

1. `computeHunks()` returns empty array when `oldContent === newContent`.
2. `computeHunks()` returns single hunk for a simple one-line change.
3. `computeHunks()` returns two hunks for two disjoint changes separated by 3+ unchanged lines.
4. `computeHunks()` correctly sets `deletionPoint` for a removed-only hunk (no added lines).
5. `registerEdit()` stores `PendingFileDiff` keyed by `filePath`.
6. `acceptHunkAtLine()` adds correct hunk index to `acceptedIndices`.
7. `rejectHunkAtLine()` adds correct hunk index to `rejectedIndices`.
8. `_checkAllResolved()` calls `applyHunks()` and clears the map entry when all hunks are resolved.
9. `applyHunks()` with all indices accepted returns `newContent` unchanged.
10. `applyHunks()` with all indices rejected returns `oldContent` unchanged.
11. `applyHunks()` with mixed accept/reject reconstructs a hybrid content string correctly.
12. `acceptAllHunks()` marks every hunk as accepted and triggers resolution.
13. `rejectAllHunks()` marks every hunk as rejected and triggers resolution.
14. `clearDiffOverlay` clears `pendingDiffs` completely.
15. File close removes the file's entry from `pendingDiffs`.

### Integration Notes

The VS Code provider methods (`provideHover`, `provideCodeLenses`) are not unit-tested — they are exercised in manual E2E testing. The integration test plan:
- Apply an edit to a file via the agent.
- Verify the green gutter bar appears on added lines.
- Verify the red top-border and "deleted lines" annotation appears at the deletion point.
- Verify the hover popup shows the correct `- ` / `+ ` diff format.
- Click "⚡ Accept" on one hunk; verify it disappears from decorations.
- Click "✗ Reject" on the remaining hunk; verify file reverts that region and decorations clear.

---

## Files

| File | Status | Change |
|---|---|---|
| `src/ui/diff-overlay-controller.ts` | New | Full implementation: `DiffOverlayController`, `PendingFileDiff`, `Hunk`, `computeHunks()`, `applyHunks()` |
| `src/extension.ts` | Modified | Instantiate `DiffOverlayController`; register `champ.acceptHunkAtLine`, `champ.rejectHunkAtLine`, `champ.acceptAllHunks`, `champ.rejectAllHunks`, `champ.clearDiffOverlay`; pass controller to `ChatViewProvider` |
| `src/ui/chat-view-provider.ts` | Modified | Accept `diffOverlayController: DiffOverlayController` in constructor; call `diffOverlayController.registerEdit(record)` for each record after `emitEditSummary()` |
| `package.json` | Modified | Add 5 commands to `contributes.commands` |
