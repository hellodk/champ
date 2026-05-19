// src/memory/__tests__/global-memory-bank.test.ts
/**
 * Tests for GlobalMemoryBank.
 *
 * A temp directory is passed as the optional homeDir parameter so the tests
 * never touch the real ~/.champ directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { GlobalMemoryBank } from "../global-memory-bank";

// ── helpers ──────────────────────────────────────────────────────────────────

let tempDir: string;

function makeBank(): GlobalMemoryBank {
  return new GlobalMemoryBank(tempDir);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GlobalMemoryBank", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "champ-global-mem-test-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("constructs without throwing", () => {
    const bank = makeBank();
    expect(bank).toBeDefined();
  });

  it("stores data in <homeDir>/.champ/memory.json", async () => {
    const bank = makeBank();
    await bank.load();
    await bank.addManual("Prefer TypeScript over JavaScript");

    const expectedFile = path.join(tempDir, ".champ", "memory.json");
    const raw = await fs.readFile(expectedFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("persists and reloads entries across instances", async () => {
    const bank1 = makeBank();
    await bank1.load();
    await bank1.addManual("Always use strict mode");

    const bank2 = makeBank();
    await bank2.load();
    const all = bank2.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].assistantSummary).toBe("Always use strict mode");
  });

  it("pin/unpin work via inherited MemoryBank methods", async () => {
    const bank = makeBank();
    await bank.load();
    await bank.store({
      userQuery: "preference",
      assistantSummary: "Use 2-space indentation",
      sessionId: "session-x",
    });
    const id = bank.getAll()[0].id;
    await bank.pin(id);
    expect(bank.getAll()[0].pinned).toBe(true);
    await bank.unpin(id);
    expect(bank.getAll()[0].pinned).toBe(false);
  });

  it("getPinnedContext returns content for pinned items", async () => {
    const bank = makeBank();
    await bank.load();
    await bank.store({
      userQuery: "pref",
      assistantSummary: "Use single quotes in JS",
      sessionId: "s1",
    });
    const id = bank.getAll()[0].id;
    await bank.pin(id);
    const ctx = bank.getPinnedContext();
    expect(ctx).toContain("Use single quotes in JS");
    expect(ctx).toContain("Pinned project context");
  });

  it("getPinnedContext returns empty string when nothing is pinned", async () => {
    const bank = makeBank();
    await bank.load();
    await bank.addManual("Some unpinned fact");
    expect(bank.getPinnedContext()).toBe("");
  });

  it("isLoaded() is false before load() and true after", async () => {
    const bank = makeBank();
    expect(bank.isLoaded()).toBe(false);
    await bank.load();
    expect(bank.isLoaded()).toBe(true);
  });

  it("delete removes entry from global bank", async () => {
    const bank = makeBank();
    await bank.load();
    await bank.addManual("Temporary preference");
    const id = bank.getAll()[0].id;
    await bank.delete(id);
    expect(bank.getAll()).toHaveLength(0);
  });

  it("defaults to os.homedir() when no homeDir is provided", () => {
    // Just verify construction doesn't throw — we can't easily test the
    // exact path without touching the real home dir.
    expect(() => new GlobalMemoryBank()).not.toThrow();
  });
});
