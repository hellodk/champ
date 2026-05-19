// src/memory/__tests__/memory-bank-ui.test.ts
import { describe, it, expect } from "vitest";
import { MemoryBank } from "../memory-bank";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

async function makeTempBank(): Promise<MemoryBank> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "champ-mem-"));
  return new MemoryBank(dir);
}

describe("MemoryBank.addManual", () => {
  it("stores a manual memory with userQuery=manual and given text as summary", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.addManual("Always use Postgres not MySQL");
    const all = bank.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].assistantSummary).toBe("Always use Postgres not MySQL");
    expect(all[0].userQuery).toBe("manual");
  });
});

describe("MemoryBank.pin/unpin", () => {
  it("sets pinned=true on the identified item", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.store({
      userQuery: "q",
      assistantSummary: "s",
      sessionId: "sess1",
    });
    const id = bank.getAll()[0].id;
    await bank.pin(id);
    expect(bank.getAll()[0].pinned).toBe(true);
  });

  it("sets pinned=false on unpin", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.store({
      userQuery: "q",
      assistantSummary: "s",
      sessionId: "sess1",
    });
    const id = bank.getAll()[0].id;
    await bank.pin(id);
    await bank.unpin(id);
    expect(bank.getAll()[0].pinned).toBe(false);
  });
});

describe("MemoryBank.delete", () => {
  it("removes the item with the given id", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.store({
      userQuery: "q",
      assistantSummary: "s",
      sessionId: "sess1",
    });
    const id = bank.getAll()[0].id;
    await bank.delete(id);
    expect(bank.getAll()).toHaveLength(0);
  });

  it("is a no-op for unknown id", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.delete("non-existent");
    expect(bank.getAll()).toHaveLength(0);
  });
});

describe("MemoryBank.getPinnedContext", () => {
  it("returns markdown block with only pinned items", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.store({
      userQuery: "q1",
      assistantSummary: "use Postgres",
      sessionId: "s1",
    });
    await bank.store({
      userQuery: "q2",
      assistantSummary: "use TypeScript",
      sessionId: "s2",
    });
    const id = bank.getAll()[0].id;
    await bank.pin(id);
    const ctx = bank.getPinnedContext();
    expect(ctx).toContain("use Postgres");
    expect(ctx).not.toContain("use TypeScript");
  });

  it("returns empty string when no pinned items", async () => {
    const bank = await makeTempBank();
    await bank.load();
    expect(bank.getPinnedContext()).toBe("");
  });
});

describe("MemoryBank entry size cap", () => {
  it("store() caps assistantSummary at 1000 characters", async () => {
    const bank = await makeTempBank();
    await bank.load();
    const longText = "a".repeat(2000);
    await bank.store({
      userQuery: "q",
      assistantSummary: longText,
      sessionId: "s1",
    });
    const all = bank.getAll();
    expect(all[0].assistantSummary).toHaveLength(1000);
  });

  it("addManual() caps text at 1000 characters", async () => {
    const bank = await makeTempBank();
    await bank.load();
    const longText = "b".repeat(1500);
    await bank.addManual(longText);
    const all = bank.getAll();
    expect(all[0].assistantSummary).toHaveLength(1000);
  });

  it("short entries are stored without truncation", async () => {
    const bank = await makeTempBank();
    await bank.load();
    await bank.addManual("short text");
    const all = bank.getAll();
    expect(all[0].assistantSummary).toBe("short text");
  });
});

describe("MemoryBank atomic persist", () => {
  it("persists to disk and can be reloaded after store()", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "champ-atomic-"));
    const bank1 = new MemoryBank(dir);
    await bank1.load();
    await bank1.store({
      userQuery: "q",
      assistantSummary: "atomic write check",
      sessionId: "s1",
    });

    // Load a fresh instance from the same directory
    const bank2 = new MemoryBank(dir);
    await bank2.load();
    const all = bank2.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].assistantSummary).toBe("atomic write check");

    // Cleanup
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("leaves no .tmp file after successful persist", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "champ-tmp-"));
    const bank = new MemoryBank(dir);
    await bank.load();
    await bank.store({
      userQuery: "q",
      assistantSummary: "no tmp leftover",
      sessionId: "s1",
    });

    const files = await fs.readdir(path.join(dir, ".champ"));
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
