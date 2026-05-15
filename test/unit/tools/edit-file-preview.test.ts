import { describe, it, expect } from "vitest";
import { editFileTool } from "../../../src/tools/edit-file";

describe("editFileTool.getPreview", () => {
  it("returns diff preview with type='diff'", () => {
    const preview = editFileTool.getPreview?.({
      path: "src/foo.ts",
      old_content: "const x = 1;\n",
      new_content: "const x = 2;\n",
    });
    expect(preview).toBeDefined();
    expect(preview!.type).toBe("diff");
    expect(preview!.content).toContain("-");
    expect(preview!.content).toContain("+");
  });

  it("returns undefined when old_content === new_content", () => {
    const preview = editFileTool.getPreview?.({
      path: "src/foo.ts",
      old_content: "same\n",
      new_content: "same\n",
    });
    expect(preview).toBeUndefined();
  });

  it("limits output to 5 hunks", () => {
    const old_lines: string[] = [];
    const new_lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      old_lines.push(`old_${i}`);
      new_lines.push(`new_${i}`);
      for (let j = 0; j < 5; j++) {
        old_lines.push(`ctx_${i}_${j}`);
        new_lines.push(`ctx_${i}_${j}`);
      }
    }
    const preview = editFileTool.getPreview?.({
      path: "src/foo.ts",
      old_content: old_lines.join("\n"),
      new_content: new_lines.join("\n"),
    });
    expect(preview).toBeDefined();
    const minusLines = (preview!.content.match(/^-/gm) ?? []).length;
    expect(minusLines).toBeLessThanOrEqual(5);
  });
});
