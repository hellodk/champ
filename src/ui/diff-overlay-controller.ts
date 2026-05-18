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
  path: string; // absolute file path
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
 * Compute overlay hunks from old and new file content.
 * Returns [] if content is identical.
 */
export function computeHunks(
  oldContent: string,
  newContent: string,
): OverlayHunk[] {
  if (oldContent === newContent) return [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const rawEdits = computeRawEdits(oldLines, newLines);

  const hunks: OverlayHunk[] = [];
  let oldIdx = 0; // position in old document
  let newIdx = 0; // position in new document
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
      const deletionPoint = Math.min(
        newDocStartLine,
        Math.max(0, newLines.length - 1),
      );
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
 */
export function applyOverlayHunks(
  oldContent: string,
  hunks: OverlayHunk[],
  acceptedIndices: Set<number>,
): string {
  if (hunks.length === 0) return oldContent;

  const oldLinesArr = oldContent.split("\n");
  // Reconstruct the full "new content" from hunks to use as the diff base
  const newLinesArr = computeCurrentNewLines(oldContent, hunks);

  const rawEdits = computeRawEdits(oldLinesArr, newLinesArr);

  const newContent_lines: string[] = [];
  let hunkIdx = 0;
  let editI = 0;

  while (editI < rawEdits.length) {
    const edit = rawEdits[editI];
    if (edit.type === "equal") {
      newContent_lines.push(edit.line);
      editI++;
      continue;
    }

    if (hunkIdx >= hunks.length) {
      // Safety: no more hunks but still edits — just copy
      if (edit.type === "insert") newContent_lines.push(edit.line);
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

  return newContent_lines.join("\n");
}

/**
 * Reconstruct the "current new lines" from old content + hunks (all accepted).
 * Used internally by applyOverlayHunks to get a consistent diff base.
 */
function computeCurrentNewLines(
  oldContent: string,
  hunks: OverlayHunk[],
): string[] {
  const oldLines = oldContent.split("\n");
  const result: string[] = [];
  let oldPos = 0;

  for (const hunk of hunks) {
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

// ─────────────────────────────────────────────────────────────────────────────
// DiffOverlayController class
// ─────────────────────────────────────────────────────────────────────────────

export class DiffOverlayController
  implements vscode.HoverProvider, vscode.CodeLensProvider
{
  private pendingDiffs = new Map<string, PendingFileDiff>();
  private writeQueues = new Map<string, Promise<void>>();

  // ── Decoration types (created once, live for the controller's lifetime) ──

  private readonly addedDecoration =
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor(
        "diffEditor.insertedLineBackground",
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      backgroundColor: new vscode.ThemeColor(
        "diffEditor.insertedLineBackground",
      ),
      borderColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
    });

  private readonly removedDecoration =
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor(
        "diffEditor.removedLineBackground",
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      after: {
        contentText: "  ▲ deleted lines above",
        color: new vscode.ThemeColor("editorError.foreground"),
        fontStyle: "italic",
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
    this._enqueueWrite(filePath);
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
    this._enqueueWrite(filePath);
    this._applyDecorationsForFile(filePath);
    this._onDidChangeCodeLenses.fire();
  }

  /** Accept all hunks for a file. */
  acceptAllHunks(filePath: string): void {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;
    for (const h of diff.hunks) diff.acceptedIndices.add(h.index);
    this._enqueueWrite(filePath);
    this._applyDecorationsForFile(filePath);
    this._onDidChangeCodeLenses.fire();
  }

  /** Reject all hunks for a file. */
  rejectAllHunks(filePath: string): void {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;
    for (const h of diff.hunks) diff.rejectedIndices.add(h.index);
    this._enqueueWrite(filePath);
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

  /**
   * Open a native VS Code diff editor for the given file path.
   * Creates two virtual TextDocuments (before/after) and calls
   * vscode.diff() to open the side-by-side diff view.
   * No-op if there is no pending diff for the given path.
   */
  async openDiffEditor(filePath: string): Promise<void> {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;

    const filename = filePath.split(/[\\/]/).pop() ?? "file";

    // Create virtual URIs for old and new content.
    // Use the 'untitled' scheme with a unique label so VS Code doesn't
    // try to read them from disk — content is supplied via openTextDocument.
    const oldUri = vscode.Uri.from({
      scheme: "untitled",
      path: `${filename} (before Champ)`,
    });
    const newUri = vscode.Uri.file(filePath);

    // Write old content into a new untitled document.
    const oldDoc = await vscode.workspace.openTextDocument(
      oldUri.with({ scheme: "untitled" }),
    );
    const edit = new vscode.WorkspaceEdit();
    edit.insert(oldUri, new vscode.Position(0, 0), diff.oldContent);
    await vscode.workspace.applyEdit(edit);

    await vscode.commands.executeCommand(
      "vscode.diff",
      oldDoc.uri,
      newUri,
      `Champ: ${filename} (before ↔ after)`,
      { preview: true },
    );
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
      (h) =>
        !diff.acceptedIndices.has(h.index) &&
        !diff.rejectedIndices.has(h.index),
    );

    // Per-hunk CodeLenses
    for (const hunk of unresolvedHunks) {
      const range = new vscode.Range(
        hunk.newDocStartLine,
        0,
        hunk.newDocStartLine,
        0,
      );
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

      // "Open Diff" CodeLens — opens native VS Code side-by-side diff editor
      const diffRange = new vscode.Range(firstHunkLine, 0, firstHunkLine, 0);
      lenses.push(
        new vscode.CodeLens(diffRange, {
          title: "⊞ Open Diff",
          command: "champ.openDiffEditor",
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
      (h) =>
        !diff.acceptedIndices.has(h.index) &&
        !diff.rejectedIndices.has(h.index),
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

  private _enqueueWrite(filePath: string): void {
    const prev = this.writeQueues.get(filePath) ?? Promise.resolve();
    const next = prev
      .then(() => this._doCheckAllResolved(filePath))
      .catch((err: unknown) => {
        console.error(
          `DiffOverlayController: write failed for ${filePath}:`,
          err,
        );
      });
    this.writeQueues.set(filePath, next);
  }

  private async _doCheckAllResolved(filePath: string): Promise<void> {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;

    const allResolved = diff.hunks.every(
      (h) =>
        diff.acceptedIndices.has(h.index) || diff.rejectedIndices.has(h.index),
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
    this.writeQueues.delete(filePath);
    this._onDidChangeCodeLenses.fire();
  }
}
