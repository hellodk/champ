// src/ui/__tests__/concurrent-runs.test.ts
// Tests for the activeRunCounts logic used in champ.runTeam concurrent runs.
import { describe, it, expect, beforeEach } from "vitest";

/**
 * Mirrors the logic in extension.ts for managing concurrent run counts
 * and generating panel titles.  Tested in isolation so no VS Code runtime
 * is required.
 */

function getPanelTitle(
  activeRunCounts: Map<string, number>,
  teamName: string,
): { title: string; count: number } {
  const count = (activeRunCounts.get(teamName) ?? 0) + 1;
  activeRunCounts.set(teamName, count);
  const title = count > 1 ? `${teamName} [${count}]` : teamName;
  return { title, count };
}

function onRunComplete(
  activeRunCounts: Map<string, number>,
  teamName: string,
): void {
  const current = activeRunCounts.get(teamName) ?? 1;
  if (current <= 1) {
    activeRunCounts.delete(teamName);
  } else {
    activeRunCounts.set(teamName, current - 1);
  }
}

describe("activeRunCounts — panel title generation", () => {
  let counts: Map<string, number>;

  beforeEach(() => {
    counts = new Map();
  });

  it("first run uses plain team name (no counter)", () => {
    const { title } = getPanelTitle(counts, "DevOps Deploy");
    expect(title).toBe("DevOps Deploy");
  });

  it("second concurrent run appends [2]", () => {
    getPanelTitle(counts, "DevOps Deploy"); // run 1
    const { title } = getPanelTitle(counts, "DevOps Deploy"); // run 2
    expect(title).toBe("DevOps Deploy [2]");
  });

  it("third concurrent run appends [3]", () => {
    getPanelTitle(counts, "DevOps Deploy"); // run 1
    getPanelTitle(counts, "DevOps Deploy"); // run 2
    const { title } = getPanelTitle(counts, "DevOps Deploy"); // run 3
    expect(title).toBe("DevOps Deploy [3]");
  });

  it("different team names are tracked independently", () => {
    const { title: t1 } = getPanelTitle(counts, "Team A");
    const { title: t2 } = getPanelTitle(counts, "Team B");
    expect(t1).toBe("Team A");
    expect(t2).toBe("Team B");
    // Second run for Team A should be [2], Team B still at 1 (will become [2])
    const { title: t3 } = getPanelTitle(counts, "Team A");
    expect(t3).toBe("Team A [2]");
    const { title: t4 } = getPanelTitle(counts, "Team B");
    expect(t4).toBe("Team B [2]");
  });
});

describe("activeRunCounts — cleanup on run complete", () => {
  let counts: Map<string, number>;

  beforeEach(() => {
    counts = new Map();
  });

  it("deletes entry when the last run completes", () => {
    getPanelTitle(counts, "MyTeam"); // count = 1
    onRunComplete(counts, "MyTeam");
    expect(counts.has("MyTeam")).toBe(false);
  });

  it("decrements count when one of multiple concurrent runs completes", () => {
    getPanelTitle(counts, "MyTeam"); // count = 1
    getPanelTitle(counts, "MyTeam"); // count = 2
    onRunComplete(counts, "MyTeam"); // count -> 1
    expect(counts.get("MyTeam")).toBe(1);
  });

  it("after all runs complete, entry is removed", () => {
    getPanelTitle(counts, "MyTeam"); // 1
    getPanelTitle(counts, "MyTeam"); // 2
    onRunComplete(counts, "MyTeam"); // 1
    onRunComplete(counts, "MyTeam"); // removed
    expect(counts.has("MyTeam")).toBe(false);
  });

  it("cleanup for one team does not affect another", () => {
    getPanelTitle(counts, "Alpha"); // 1
    getPanelTitle(counts, "Beta"); // 1
    onRunComplete(counts, "Alpha");
    expect(counts.has("Alpha")).toBe(false);
    expect(counts.get("Beta")).toBe(1);
  });

  it("handles cleanup when called without a prior run (graceful)", () => {
    // Should not throw even if no prior registration
    expect(() => onRunComplete(counts, "Ghost")).not.toThrow();
    expect(counts.has("Ghost")).toBe(false);
  });
});

describe("activeRunCounts — counter returned on run start", () => {
  it("returns count = 1 for first run", () => {
    const counts = new Map<string, number>();
    const { count } = getPanelTitle(counts, "X");
    expect(count).toBe(1);
  });

  it("returns count = 2 for second concurrent run", () => {
    const counts = new Map<string, number>();
    getPanelTitle(counts, "X");
    const { count } = getPanelTitle(counts, "X");
    expect(count).toBe(2);
  });
});
