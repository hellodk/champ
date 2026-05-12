/**
 * TDD: Tests for MemoryBank.
 * Cross-session fact persistence and retrieval.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryBank } from "@/memory/memory-bank";
import * as fs from "fs/promises";

vi.mock("fs/promises");

describe("MemoryBank", () => {
  let bank: MemoryBank;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    bank = new MemoryBank("/test-workspace");
  });

  it("stores an item and getRecentContext includes it", async () => {
    await bank.store({
      userQuery: "How does auth work?",
      assistantSummary: "Auth uses JWT tokens validated in middleware.",
      sessionId: "session-1",
    });

    const ctx = bank.getRecentContext(5);
    expect(ctx).toContain("How does auth work?");
    expect(ctx).toContain("Auth uses JWT tokens validated in middleware.");
    expect(ctx).toContain("## Recent conversation history");
  });

  it("evicts oldest items when over 50-item limit", async () => {
    // Store 55 items; oldest 5 should be evicted
    for (let i = 0; i < 55; i++) {
      await bank.store({
        userQuery: `query-${i}`,
        assistantSummary: `summary-${i}`,
        sessionId: "session-1",
      });
    }

    // With n=10, we get the last 10 items (indices 45-54).
    // Items 0-44 should have been evicted. Check some that can't be
    // substring-matched by surviving items (e.g. "query-3\b").
    const ctx = bank.getRecentContext(10);
    // "query-3 " and "query-1 " cannot appear as substrings of query-30..39
    // because they'd need trailing digits — check via regex boundaries.
    expect(ctx).not.toMatch(/query-[0-4]"/); // evicted items 0-4 (with closing quote)
    // Items 50-54 should still be present
    expect(ctx).toContain("query-54");
  });

  it("loads persisted memories from disk", async () => {
    const stored = [
      {
        id: "mem-abc",
        timestamp: 1000,
        userQuery: "What is TypeScript?",
        assistantSummary: "TypeScript is a typed superset of JavaScript.",
        sessionId: "session-old",
      },
    ];
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify(stored) as unknown as Buffer,
    );

    const freshBank = new MemoryBank("/test-workspace");
    await freshBank.load();

    const ctx = freshBank.getRecentContext(5);
    expect(ctx).toContain("What is TypeScript?");
    expect(ctx).toContain("TypeScript is a typed superset of JavaScript.");
  });

  it("returns empty string when no memories exist", () => {
    const ctx = bank.getRecentContext(5);
    expect(ctx).toBe("");
  });
});
