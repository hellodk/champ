import { describe, expect, it } from "vitest";
import {
  deleteSession,
  forkSession,
  moveSessionTab,
  renameSession,
  sessionChildren,
  sessionLineage,
} from "@/tui/session-ops";
import type { TuiSessionSummary } from "@/tui/state";

const sessions: TuiSessionSummary[] = [
  { id: "root", label: "Root", updatedAt: "1" },
  { id: "child", label: "Child", updatedAt: "2", parentId: "root" },
  { id: "other", label: "Other", updatedAt: "3" },
];

describe("session operations", () => {
  it("renames a session without changing identity", () => {
    const renamed = renameSession(sessions, "child", "Renamed");
    expect(renamed.find((session) => session.id === "child")?.label).toBe(
      "Renamed",
    );
    expect(renamed).toHaveLength(3);
  });

  it("forks a session as a child and records lineage", () => {
    const forked = forkSession(sessions, "child", "fork-1", "Fork");
    expect(forked.find((session) => session.id === "fork-1")).toMatchObject({
      parentId: "child",
    });
    expect(
      sessionLineage(forked, "fork-1").map((session) => session.id),
    ).toEqual(["root", "child", "fork-1"]);
  });

  it("re-parents children when their parent is deleted", () => {
    const left = deleteSession(sessions, "root");
    expect(left.some((session) => session.id === "root")).toBe(false);
    expect(
      left.find((session) => session.id === "child")?.parentId,
    ).toBeUndefined();
  });

  it("lists children and wraps tab navigation", () => {
    expect(
      sessionChildren(sessions, "root").map((session) => session.id),
    ).toEqual(["child"]);
    expect(moveSessionTab(["a", "b", "c"], 2, 1)).toBe(0);
    expect(moveSessionTab(["a", "b", "c"], 0, -1)).toBe(2);
  });
});
