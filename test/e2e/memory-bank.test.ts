/**
 * E2E tests for MemoryBank — real filesystem I/O in a temp directory.
 *
 * Each test suite gets its own temp dir so tests are fully isolated.
 * Tests verify: persistence, pin/unpin/delete, concurrent writes, eviction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { MemoryBank } from "../../src/memory/memory-bank";

// ── helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "champ-memory-test-"));
}

async function cleanupTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function makeEntry(
  n: number,
): Omit<import("../../src/memory/memory-bank").MemoryItem, "id" | "timestamp"> {
  return {
    userQuery: `query ${n}`,
    assistantSummary: `summary for item ${n}`,
    sessionId: `session-${n}`,
  };
}

// ── Store & Load ─────────────────────────────────────────────────────────────

describe("MemoryBank: store and load persistence", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("stores a memory and getAll returns it", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.store(makeEntry(1));
    const all = bank.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].userQuery).toBe("query 1");
    expect(all[0].assistantSummary).toBe("summary for item 1");
    expect(typeof all[0].id).toBe("string");
    expect(all[0].id.startsWith("mem-")).toBe(true);
  });

  it("persists across instances (load reads what was stored)", async () => {
    const bank1 = new MemoryBank(tmpDir);
    await bank1.load();
    await bank1.store(makeEntry(42));

    // Create a second instance pointing at the same directory
    const bank2 = new MemoryBank(tmpDir);
    await bank2.load();

    const all = bank2.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].userQuery).toBe("query 42");
  });

  it("isLoaded() is false before load() and true after", async () => {
    const bank = new MemoryBank(tmpDir);
    expect(bank.isLoaded()).toBe(false);
    await bank.load();
    expect(bank.isLoaded()).toBe(true);
  });

  it("load() silently handles missing memory.json (ENOENT)", async () => {
    const bank = new MemoryBank(tmpDir);
    await expect(bank.load()).resolves.not.toThrow();
    expect(bank.isLoaded()).toBe(true);
    expect(bank.getAll()).toHaveLength(0);
  });

  it("stores multiple entries and they all persist", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.store(makeEntry(1));
    await bank.store(makeEntry(2));
    await bank.store(makeEntry(3));

    const bank2 = new MemoryBank(tmpDir);
    await bank2.load();
    expect(bank2.getAll()).toHaveLength(3);
  });

  it("caps assistantSummary at 1000 characters", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.store({
      userQuery: "long query",
      assistantSummary: "x".repeat(2000),
      sessionId: "sess-1",
    });
    const all = bank.getAll();
    expect(all[0].assistantSummary.length).toBe(1000);
  });
});

// ── Pin / Unpin / Delete ──────────────────────────────────────────────────────

describe("MemoryBank: pin/unpin/delete round-trip", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("pin sets pinned=true on the item", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.store(makeEntry(1));
    const id = bank.getAll()[0].id;

    await bank.pin(id);
    expect(bank.getAll()[0].pinned).toBe(true);
  });

  it("unpin sets pinned=false on the item", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.store(makeEntry(1));
    const id = bank.getAll()[0].id;
    await bank.pin(id);
    await bank.unpin(id);
    expect(bank.getAll()[0].pinned).toBe(false);
  });

  it("pin persists across instances", async () => {
    const bank1 = new MemoryBank(tmpDir);
    await bank1.load();
    await bank1.store(makeEntry(1));
    const id = bank1.getAll()[0].id;
    await bank1.pin(id);

    const bank2 = new MemoryBank(tmpDir);
    await bank2.load();
    expect(bank2.getAll()[0].pinned).toBe(true);
  });

  it("delete removes the item permanently", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.store(makeEntry(1));
    await bank.store(makeEntry(2));
    const id = bank.getAll()[0].id;

    await bank.delete(id);
    expect(bank.getAll()).toHaveLength(1);

    // Verify persistence
    const bank2 = new MemoryBank(tmpDir);
    await bank2.load();
    expect(bank2.getAll()).toHaveLength(1);
  });

  it("delete is a no-op for unknown ids", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.store(makeEntry(1));
    await expect(bank.delete("non-existent-id")).resolves.not.toThrow();
    expect(bank.getAll()).toHaveLength(1);
  });

  it("getAll returns pinned items first, then by timestamp", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.store(makeEntry(1));
    await bank.store(makeEntry(2));
    await bank.store(makeEntry(3));
    const all = bank.getAll();
    const id2 = all[1].id;
    await bank.pin(id2); // pin the middle item

    const sorted = bank.getAll();
    expect(sorted[0].pinned).toBe(true);
    // Non-pinned should be in timestamp order
    expect(sorted[1].pinned).toBeFalsy();
    expect(sorted[2].pinned).toBeFalsy();
  });
});

// ── Concurrent writes ─────────────────────────────────────────────────────────

describe("MemoryBank: concurrent writes do not corrupt data", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("10 concurrent store calls all persist without corruption", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();

    // Fire 10 stores concurrently
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => bank.store(makeEntry(i))),
    );

    const all = bank.getAll();
    expect(all).toHaveLength(10);

    // Load from disk to verify persistence
    const bank2 = new MemoryBank(tmpDir);
    await bank2.load();
    expect(bank2.getAll()).toHaveLength(10);
  });

  it("concurrent stores produce valid JSON on disk", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => bank.store(makeEntry(i))),
    );

    const filePath = path.join(tmpDir, ".champ", "memory.json");
    const raw = await fs.readFile(filePath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(5);
  });
});

// ── Eviction ──────────────────────────────────────────────────────────────────

describe("MemoryBank: eviction at MAX_MEMORIES (50)", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("evicts oldest non-pinned entry when over cap", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();

    // Store 50 items
    for (let i = 0; i < 50; i++) {
      await bank.store(makeEntry(i));
    }
    expect(bank.getAll()).toHaveLength(50);

    // Store one more — should evict oldest non-pinned
    await bank.store(makeEntry(50));
    expect(bank.getAll()).toHaveLength(50);

    // Item 0 should be gone (oldest non-pinned)
    const queries = bank.getAll().map((m) => m.userQuery);
    expect(queries).not.toContain("query 0");
  });

  it("pinned items survive eviction", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();

    // Store 50 items
    for (let i = 0; i < 50; i++) {
      await bank.store(makeEntry(i));
    }

    // Pin the oldest item
    const all = bank.getAll();
    const pinnedId = all.find((m) => m.userQuery === "query 0")!.id;
    await bank.pin(pinnedId);

    // Add one more — should evict the next oldest non-pinned (item 1)
    await bank.store(makeEntry(50));
    expect(bank.getAll()).toHaveLength(50);

    const queries = bank.getAll().map((m) => m.userQuery);
    expect(queries).toContain("query 0"); // pinned — survives
    expect(queries).not.toContain("query 1"); // evicted
  });
});

// ── addManual ─────────────────────────────────────────────────────────────────

describe("MemoryBank: addManual", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("addManual stores entry with sessionId=manual", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.addManual("Remember: use tabs not spaces");
    const all = bank.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].sessionId).toBe("manual");
    expect(all[0].assistantSummary).toBe("Remember: use tabs not spaces");
  });
});

// ── Context rendering ─────────────────────────────────────────────────────────

describe("MemoryBank: context rendering", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("getRecentContext returns empty string when no items", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    expect(bank.getRecentContext()).toBe("");
  });

  it("getRecentContext includes last N non-pinned items", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    for (let i = 0; i < 7; i++) await bank.store(makeEntry(i));
    const ctx = bank.getRecentContext(3);
    expect(ctx).toContain("## Recent conversation history");
    // Should contain 3 entries (last 3)
    const lineCount = (ctx.match(/^- User asked/gm) ?? []).length;
    expect(lineCount).toBe(3);
  });

  it("getPinnedContext returns empty string when nothing pinned", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.store(makeEntry(1));
    expect(bank.getPinnedContext()).toBe("");
  });

  it("getPinnedContext includes pinned items", async () => {
    const bank = new MemoryBank(tmpDir);
    await bank.load();
    await bank.store(makeEntry(1));
    const id = bank.getAll()[0].id;
    await bank.pin(id);
    const ctx = bank.getPinnedContext();
    expect(ctx).toContain("## Pinned project context");
    expect(ctx).toContain("summary for item 1");
  });
});

// ── Global memory bank path ───────────────────────────────────────────────────

describe("MemoryBank: global path at ~/.champ", () => {
  it("GlobalMemoryBank instantiates with ~/.champ/memory.json path", async () => {
    // Import the GlobalMemoryBank to verify it instantiates with the home dir path
    const { GlobalMemoryBank } =
      await import("../../src/memory/global-memory-bank");
    const globalBank = new GlobalMemoryBank(os.homedir());
    // Should not throw; the path will be within os.homedir()
    expect(globalBank).toBeDefined();
    // Verify the file path includes .champ — access private field via cast
    const filePath = (globalBank as unknown as { filePath: string }).filePath;
    expect(filePath).toContain(".champ");
    expect(filePath).toContain(os.homedir());
    expect(filePath).toContain("memory.json");
  });

  it("GlobalMemoryBank with custom homeDir uses custom path", async () => {
    const { GlobalMemoryBank } =
      await import("../../src/memory/global-memory-bank");
    const customHome = "/custom/home";
    const globalBank = new GlobalMemoryBank(customHome);
    const filePath = (globalBank as unknown as { filePath: string }).filePath;
    expect(filePath).toContain(customHome);
    expect(filePath).toContain(".champ");
  });
});
