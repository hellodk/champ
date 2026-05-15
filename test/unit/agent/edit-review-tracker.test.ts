import { describe, it, expect } from "vitest";
import { EditReviewTracker } from "@/agent/edit-review-tracker";

describe("EditReviewTracker", () => {
  it("records a single edit", () => {
    const tracker = new EditReviewTracker();
    tracker.record({ path: "foo.ts", oldContent: "old", newContent: "new" });
    expect(tracker.flush()).toHaveLength(1);
    expect(tracker.flush()[0].path).toBe("foo.ts");
  });

  it("updates in-place when same path edited twice", () => {
    const tracker = new EditReviewTracker();
    tracker.record({ path: "foo.ts", oldContent: "v1", newContent: "v2" });
    tracker.record({ path: "foo.ts", oldContent: "v2", newContent: "v3" });
    const edits = tracker.flush();
    expect(edits).toHaveLength(1);
    expect(edits[0].newContent).toBe("v3");
  });

  it("resets to empty after reset()", () => {
    const tracker = new EditReviewTracker();
    tracker.record({ path: "foo.ts", oldContent: "a", newContent: "b" });
    tracker.reset();
    expect(tracker.flush()).toHaveLength(0);
  });

  it("tracks multiple different files", () => {
    const tracker = new EditReviewTracker();
    tracker.record({ path: "a.ts", oldContent: "a", newContent: "A" });
    tracker.record({ path: "b.ts", oldContent: "b", newContent: "B" });
    expect(tracker.flush()).toHaveLength(2);
  });
});
