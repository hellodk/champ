import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { generateDocTool } from "../../../src/tools/generate-doc";

const ctx = {
  workspaceRoot: os.tmpdir(),
  abortSignal: new AbortController().signal,
  reportProgress: () => {},
  requestApproval: async () => true,
};

const outFile = path.join(os.tmpdir(), "test-arch.md");

afterEach(async () => {
  try {
    await fs.unlink(outFile);
  } catch {
    /* ok */
  }
});

describe("generate_doc tool", () => {
  it("writes a markdown file with type annotation header", async () => {
    const result = await generateDocTool.execute(
      {
        filename: "test-arch.md",
        docType: "architecture",
        content: "# My System\n\nThis is the architecture.",
      },
      ctx,
    );
    expect(result.success).toBe(true);
    const written = await fs.readFile(outFile, "utf-8");
    expect(written).toContain("type: architecture");
    expect(written).toContain("# My System");
  });

  it("creates parent directories", async () => {
    const deep = path.join(os.tmpdir(), "champ-docs", "spec.md");
    const result = await generateDocTool.execute(
      { filename: deep, docType: "technical", content: "# Spec" },
      ctx,
    );
    expect(result.success).toBe(true);
    await fs.unlink(deep);
    await fs.rmdir(path.dirname(deep));
  });

  it("rejects paths outside workspace", async () => {
    const result = await generateDocTool.execute(
      { filename: "/etc/shadow.md", docType: "architecture", content: "x" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("not allowed");
  });
});
