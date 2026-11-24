import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import { parseCliArgs } from "@/cli/args";
import { EditReviewTracker } from "@/agent/edit-review-tracker";
import { CliReviewStore } from "@/cli/review-store";
import { runReviewCommand } from "@/cli/review-commands";

function deps(workspace: string) {
  return {
    workspace,
    store: new CliReviewStore(workspace),
    stdout: vi.fn(),
    stderr: vi.fn(),
  };
}

describe("review CLI (#147)", () => {
  it("parses list, show, accept and reject", () => {
    for (const action of ["list", "show", "accept", "reject"]) {
      const parsed = parseCliArgs(["review", action, "rev_1"], {
        stdinIsTTY: true,
      });
      expect(parsed.kind).toBe("review-command");
      if (parsed.kind === "review-command") {
        expect(parsed.command.name).toBe(action);
        expect(parsed.command.id).toBe("rev_1");
      }
    }
  });

  it("lists recorded reviews through the command runner", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "champ-review-cmd-"));
    const d = deps(workspace);
    const tracker = new EditReviewTracker();
    tracker.record({ path: "a.txt", oldContent: "old", newContent: "new" });
    const entry = await d.store.recordFromTracker(tracker);

    const code = await runReviewCommand({ name: "list" }, d);

    expect(code).toBe(0);
    expect(d.stdout.mock.calls.flat().join("")).toContain(entry!.id);
  });

  it("rejects a review through the command runner", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "champ-review-cmd-"));
    await writeFile(join(workspace, "a.txt"), "new", "utf8");
    const d = deps(workspace);
    const tracker = new EditReviewTracker();
    tracker.record({ path: "a.txt", oldContent: "old", newContent: "new" });
    const entry = await d.store.recordFromTracker(tracker);

    const code = await runReviewCommand({ name: "reject", id: entry!.id }, d);

    expect(code).toBe(0);
    expect(await readFileOrEmpty(join(workspace, "a.txt"))).toBe("old");
  });
});

async function readFileOrEmpty(file: string): Promise<string> {
  const { readFile } = await import("fs/promises");
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}
