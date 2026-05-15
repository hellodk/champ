import { describe, it, expect } from "vitest";
import { runTerminalTool } from "../../../src/tools/run-terminal";

describe("runTerminalTool.getPreview", () => {
  it("returns command preview with type='command'", () => {
    const preview = runTerminalTool.getPreview?.({
      command: "npm test",
      timeout: 30000,
    });
    expect(preview).toBeDefined();
    expect(preview!.type).toBe("command");
    expect(preview!.content).toBe("npm test");
    expect(preview!.label).toBe("Run terminal");
  });

  it("returns undefined when command arg is missing", () => {
    expect(runTerminalTool.getPreview?.({})).toBeUndefined();
  });
});
