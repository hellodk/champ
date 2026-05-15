import { describe, it, expect } from "vitest";
import { splitIntoHunks } from "../../../src/utils/diff-utils";
import { editFileTool } from "../../../src/tools/edit-file";
import { runTerminalTool } from "../../../src/tools/run-terminal";

describe("approval preview integration", () => {
  it("editFileTool preview produces valid diff lines", () => {
    const preview = editFileTool.getPreview?.({
      path: "greet.ts",
      old_content: "function hello() {\n  return 'world';\n}\n",
      new_content: "function hello() {\n  return 'earth';\n}\n",
    });
    expect(preview?.type).toBe("diff");
    const lines = (preview?.content ?? "")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("…"));
    for (const line of lines) {
      expect(line).toMatch(/^[-+]/);
    }
  });

  it("runTerminalTool preview content equals command verbatim", () => {
    const cmd = "npx jest --coverage";
    expect(runTerminalTool.getPreview?.({ command: cmd })?.content).toBe(cmd);
  });

  it("identical content produces no preview", () => {
    const same = "const x = 1;\n";
    expect(splitIntoHunks(same, same)).toHaveLength(0);
    expect(
      editFileTool.getPreview?.({
        path: "f.ts",
        old_content: same,
        new_content: same,
      }),
    ).toBeUndefined();
  });
});
