/**
 * MemoryBank: persists cross-session conversation facts and injects
 * them into the system prompt of new sessions.
 *
 * Facts are stored as JSON in <workspaceRoot>/.champ/memory.json and
 * loaded on startup. The bank caps at MAX_MEMORIES items, evicting the
 * oldest non-pinned entry when the limit is exceeded.
 */
import * as path from "path";
import * as fs from "fs/promises";

export interface MemoryItem {
  id: string;
  timestamp: number;
  userQuery: string;
  assistantSummary: string;
  sessionId: string;
  /** When true, always injected into system prompt regardless of recency. */
  pinned?: boolean;
}

const MAX_MEMORIES = 50;

export class MemoryBank {
  private items: MemoryItem[] = [];
  private readonly filePath: string;
  private _loaded = false;

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, ".champ", "memory.json");
  }

  /**
   * Reads filePath, parses JSON array, stores in this.items.
   * Silently ignores ENOENT. Warns on other errors. Sets this.loaded = true.
   */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw as string) as MemoryItem[];
      if (Array.isArray(parsed)) {
        this.items = parsed;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Champ MemoryBank: failed to load memory.json:", err);
      }
    }
    this._loaded = true;
  }

  /**
   * Stores a new memory entry. Generates a unique id, pushes to
   * this.items, evicts oldest non-pinned entry when > MAX_MEMORIES, then persists.
   */
  async store(entry: Omit<MemoryItem, "id" | "timestamp">): Promise<void> {
    const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const item: MemoryItem = {
      id,
      timestamp: Date.now(),
      ...entry,
    };
    this.items.push(item);
    // Evict oldest non-pinned entries beyond the cap; fall back to oldest if all pinned.
    while (this.items.length > MAX_MEMORIES) {
      const evictIdx = this.items.findIndex((m) => !m.pinned);
      this.items.splice(evictIdx === -1 ? 0 : evictIdx, 1);
    }
    await this.persist();
  }

  /** Add a manually entered fact (not tied to a specific session interaction). */
  async addManual(text: string): Promise<void> {
    await this.store({
      userQuery: "manual",
      assistantSummary: text,
      sessionId: "manual",
    });
  }

  /** Pin a memory so it is always injected into the system prompt. */
  async pin(id: string): Promise<void> {
    const item = this.items.find((m) => m.id === id);
    if (item) {
      item.pinned = true;
      await this.persist();
    }
  }

  /** Unpin a memory (reverts to recency-based injection). */
  async unpin(id: string): Promise<void> {
    const item = this.items.find((m) => m.id === id);
    if (item) {
      item.pinned = false;
      await this.persist();
    }
  }

  /** Permanently remove a memory entry. No-op for unknown ids. */
  async delete(id: string): Promise<void> {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length !== before) {
      await this.persist();
    }
  }

  /** Returns all stored memories (pinned first, then by insertion order / timestamp asc). */
  getAll(): MemoryItem[] {
    return [...this.items].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return a.timestamp - b.timestamp;
    });
  }

  /**
   * Returns whether the memory bank has been loaded.
   */
  isLoaded(): boolean {
    return this._loaded;
  }

  /**
   * Returns the last n non-pinned items formatted as a markdown block for
   * injection into the system prompt. Returns "" when there are no items.
   * Pinned items are handled separately by getPinnedContext().
   */
  getRecentContext(n = 5): string {
    if (this.items.length === 0) return "";
    const recent = this.items.filter((m) => !m.pinned).slice(-n);
    if (recent.length === 0) return "";
    const lines = recent.map(
      (item) =>
        `- User asked: "${item.userQuery}" → "${item.assistantSummary}"`,
    );
    return `## Recent conversation history\n${lines.join("\n")}`;
  }

  /** Returns all pinned memories as a markdown block (always injected). */
  getPinnedContext(): string {
    const pinned = this.items.filter((m) => m.pinned);
    if (pinned.length === 0) return "";
    const lines = pinned.map((item) => `- ${item.assistantSummary}`);
    return `## Pinned project context\n${lines.join("\n")}`;
  }

  /**
   * Write the current items array to disk. Creates the directory if
   * needed. Silently warns on errors — a write failure must not
   * break the agent loop.
   */
  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(
        this.filePath,
        JSON.stringify(this.items, null, 2),
        "utf-8",
      );
    } catch (err) {
      console.warn("Champ MemoryBank: failed to persist memory.json:", err);
    }
  }
}
