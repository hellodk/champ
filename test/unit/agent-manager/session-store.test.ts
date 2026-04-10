/**
 * TDD: Tests for SessionStore — filesystem persistence for sessions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "@/agent-manager/session-store";
import type { SerializedSession } from "@/agent-manager/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "champ-store-test-"));
}

function sampleSession(id = "sess-abc"): SerializedSession {
  return {
    version: 1,
    metadata: {
      id,
      label: "test session",
      state: "idle",
      createdAt: 1700000000000,
      lastActivityAt: 1700000001000,
      mode: "agent",
      messageCount: 2,
      modifiedFiles: [],
      archived: false,
    },
    history: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ],
  };
}

describe("SessionStore", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save + loadAll round-trips a serialized session", async () => {
    const session = sampleSession();
    await store.save(session);
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].metadata.id).toBe("sess-abc");
    expect(loaded[0].history).toHaveLength(2);
    expect(loaded[0].version).toBe(1);
  });

  it("loadAll returns empty array when directory doesn't exist", async () => {
    const emptyStore = new SessionStore(path.join(tmpDir, "nonexistent"));
    const loaded = await emptyStore.loadAll();
    expect(loaded).toEqual([]);
  });

  it("corrupted files are skipped without crashing", async () => {
    // Write a valid session.
    await store.save(sampleSession("good"));
    // Write a corrupt file.
    fs.writeFileSync(path.join(tmpDir, "bad.json"), "NOT VALID JSON{{{");
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].metadata.id).toBe("good");
  });

  it("delete removes the session file", async () => {
    await store.save(sampleSession("to-delete"));
    await store.delete("to-delete");
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(0);
  });

  it("save creates the storage directory if missing", async () => {
    const nested = path.join(tmpDir, "deep", "nested");
    const deepStore = new SessionStore(nested);
    await deepStore.save(sampleSession("deep-session"));
    const loaded = await deepStore.loadAll();
    expect(loaded).toHaveLength(1);
  });

  it("pruneOlderThan removes old sessions", async () => {
    const old = sampleSession("old");
    old.metadata.lastActivityAt = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90 days ago
    const recent = sampleSession("recent");
    recent.metadata.lastActivityAt = Date.now();
    await store.save(old);
    await store.save(recent);
    const pruned = await store.pruneOlderThan(30);
    expect(pruned).toBe(1);
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].metadata.id).toBe("recent");
  });

  it("saves multiple sessions and loads them all", async () => {
    await store.save(sampleSession("a"));
    await store.save(sampleSession("b"));
    await store.save(sampleSession("c"));
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(3);
  });
});
