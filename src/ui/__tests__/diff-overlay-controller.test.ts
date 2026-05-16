// src/ui/__tests__/diff-overlay-controller.test.ts
import { describe, it, expect } from "vitest";
import {
  computeHunks,
  applyOverlayHunks,
  type PendingFileDiff,
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
      (h) =>
        h.addedLines.includes(targetLine) || h.deletionPoint === targetLine,
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
      (h) =>
        diff.acceptedIndices.has(h.index) || diff.rejectedIndices.has(h.index),
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
    const allResolved = diff.hunks.every((h) =>
      diff.acceptedIndices.has(h.index),
    );
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
    const allResolved = diff.hunks.every((h) =>
      diff.rejectedIndices.has(h.index),
    );
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
