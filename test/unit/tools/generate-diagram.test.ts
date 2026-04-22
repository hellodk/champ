import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { generateDiagramTool } from "../../../src/tools/generate-diagram";

const ctx = {
  workspaceRoot: os.tmpdir(),
  abortSignal: new AbortController().signal,
  reportProgress: () => {},
  requestApproval: async () => true,
};

const outFile = path.join(os.tmpdir(), "test-diagram.md");

afterEach(async () => {
  try {
    await fs.unlink(outFile);
  } catch {
    /* ok */
  }
});

describe("generate_diagram tool", () => {
  it("writes a .md file with mermaid fencing", async () => {
    const result = await generateDiagramTool.execute(
      {
        filename: "test-diagram.md",
        title: "Auth Flow",
        diagramType: "sequenceDiagram",
        content: "User->>Server: login\nServer-->>User: token",
      },
      ctx,
    );
    expect(result.success).toBe(true);
    const written = await fs.readFile(outFile, "utf-8");
    expect(written).toContain("# Auth Flow");
    expect(written).toContain("```mermaid");
    expect(written).toContain("User->>Server: login");
    expect(written).toContain("```");
  });

  it("creates parent directories if missing", async () => {
    const deep = path.join(os.tmpdir(), "champ-test-diagrams", "flow.md");
    const result = await generateDiagramTool.execute(
      {
        filename: deep,
        title: "T",
        diagramType: "flowchart",
        content: "A-->B",
      },
      ctx,
    );
    expect(result.success).toBe(true);
    await fs.unlink(deep);
    await fs.rmdir(path.dirname(deep));
  });

  it("rejects absolute paths outside the workspace", async () => {
    const result = await generateDiagramTool.execute(
      {
        filename: "/etc/passwd.md",
        title: "T",
        diagramType: "flowchart",
        content: "A",
      },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("not allowed");
  });
});
