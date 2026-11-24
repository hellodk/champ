import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { EditReviewTracker } from "@/agent/edit-review-tracker";
import { CliReviewStore } from "@/cli/review-store";

function trackerWithEdit(path: string, oldText: string, newText: string) {
  const tracker = new EditReviewTracker();
  tracker.record({ path, oldContent: oldText, newContent: newText });
  return tracker;
}

describe("CLI review store (#147)", () => {
  it("records tracker edits as a pending review", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "champ-review-"));
    const store = new CliReviewStore(workspace);
    const entry = await store.recordFromTracker(
      trackerWithEdit("a.txt", "before\n", "after\n"),
    );
    expect(entry).not.toBeNull();
    expect(entry?.status).toBe("pending");
    expect(entry?.edits[0].path).toBe("a.txt");
    expect((await store.list()).map((item) => item.id)).toContain(entry!.id);
  });

  it("reject restores the original file content", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "champ-review-"));
    await writeFile(join(workspace, "a.txt"), "after\n", "utf8");
    const store = new CliReviewStore(workspace);
    const entry = await store.recordFromTracker(
      trackerWithEdit("a.txt", "before\n", "after\n"),
    );
    await store.reject(entry!.id);
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("before\n");
    expect((await store.get(entry!.id))?.status).toBe("rejected");
  });

  it("accept keeps applied content and marks the entry accepted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "champ-review-"));
    await writeFile(join(workspace, "a.txt"), "after\n", "utf8");
    const store = new CliReviewStore(workspace);
    const entry = await store.recordFromTracker(
      trackerWithEdit("a.txt", "before\n", "after\n"),
    );
    await store.accept(entry!.id);
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("after\n");
    expect((await store.get(entry!.id))?.status).toBe("accepted");
  });

  it("ignores unknown ids instead of throwing", async () => {
    const store = new CliReviewStore(
      await mkdtemp(join(tmpdir(), "champ-review-")),
    );
    await expect(store.reject("missing-id")).resolves.toBeNull();
    await expect(store.accept("missing-id")).resolves.toBeNull();
  });
});
