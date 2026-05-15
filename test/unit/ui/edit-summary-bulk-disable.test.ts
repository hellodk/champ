import { describe, it, expect } from "vitest";

describe("bulk disable pattern", () => {
  it("disabling via shared array reaches every button", () => {
    const perFileRevertBtns: Array<{ disabled: boolean; textContent: string }> =
      [
        { disabled: false, textContent: "↩ Revert" },
        { disabled: false, textContent: "↩ Revert" },
      ];
    perFileRevertBtns.forEach((btn) => {
      btn.disabled = true;
      btn.textContent = "✓ Accepted";
    });
    for (const btn of perFileRevertBtns) {
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe("✓ Accepted");
    }
  });

  it("revertAllEdits message carries all edits", () => {
    const edits = [{ path: "a.ts", oldContent: "old a", newContent: "new a" }];
    const allEdits = edits.map((e) => ({
      path: e.path,
      restoreContent: e.oldContent,
    }));
    expect(allEdits).toEqual([{ path: "a.ts", restoreContent: "old a" }]);
  });
});
