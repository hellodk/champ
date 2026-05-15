import { describe, it, expect } from "vitest";
import {
  isAcceptAllEditsRequest,
  isRevertAllEditsRequest,
} from "../../../src/ui/messages";

describe("bulk edit message routing", () => {
  it("isRevertAllEditsRequest correctly identifies message", () => {
    const msg = {
      type: "revertAllEdits" as const,
      edits: [
        { path: "a.ts", restoreContent: "old" },
        { path: "b.ts", restoreContent: "old b" },
      ],
    };
    expect(isRevertAllEditsRequest(msg)).toBe(true);
  });

  it("iterates edits correctly for revert-all logic", () => {
    const calls: Array<[string, string]> = [];
    const fakeRevert = (path: string, content: string) =>
      calls.push([path, content]);
    const msg = {
      type: "revertAllEdits" as const,
      edits: [
        { path: "a.ts", restoreContent: "old a" },
        { path: "b.ts", restoreContent: "old b" },
      ],
    };
    if (isRevertAllEditsRequest(msg)) {
      for (const edit of msg.edits) fakeRevert(edit.path, edit.restoreContent);
    }
    expect(calls).toEqual([
      ["a.ts", "old a"],
      ["b.ts", "old b"],
    ]);
  });

  it("isAcceptAllEditsRequest returns true for acceptAllEdits", () => {
    expect(isAcceptAllEditsRequest({ type: "acceptAllEdits" })).toBe(true);
  });
});
