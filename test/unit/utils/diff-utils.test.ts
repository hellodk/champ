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
    const newText = "A\nb\nc\nd\nE";
    const hunks = splitIntoHunks(old, newText);
    expect(hunks).toHaveLength(2);
    const result = applyHunks(old, hunks, [0]);
    expect(result).toBe("A\nb\nc\nd\ne");
  });
});
