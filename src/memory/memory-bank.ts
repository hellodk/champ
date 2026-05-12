/**
 * MemoryBank: persists cross-session conversation facts and injects
 * them into the system prompt of new sessions.
 *
 * Facts are stored as JSON in <workspaceRoot>/.champ/memory.json and
 * loaded on startup. The bank caps at MAX_MEMORIES items, evicting the
 * oldest entry when the limit is exceeded.
 */
import * as path from "path";
import * as fs from "fs/promises";

export interface MemoryItem {
  id: string;
  timestamp: number;
  userQuery: string;
  assistantSummary: string;
  sessionId: string;
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
   * this.items, evicts oldest when > MAX_MEMORIES, then persists.
   */
  async store(entry: Omit<MemoryItem, "id" | "timestamp">): Promise<void> {
    const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const item: MemoryItem = {
      id,
      timestamp: Date.now(),
      ...entry,
    };
    this.items.push(item);
    // Evict oldest entries beyond the cap.
    while (this.items.length > MAX_MEMORIES) {
      this.items.shift();
    }
    await this.persist();
  }

  /**
   * Returns whether the memory bank has been loaded.
   */
  isLoaded(): boolean {
    return this._loaded;
  }

  /**
   * Returns the last n items formatted as a markdown block for injection
   * into the system prompt. Returns "" when there are no items.
   */
  getRecentContext(n = 5): string {
    if (this.items.length === 0) return "";
    const recent = this.items.slice(-n);
    const lines = recent.map(
      (item) =>
        `- User asked: "${item.userQuery}" → "${item.assistantSummary}"`,
    );
    return `## Recent conversation history\n${lines.join("\n")}`;
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
