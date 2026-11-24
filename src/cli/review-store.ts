/**
 * Persistent CLI review store for file edits made during a turn.
 *
 * The VS Code extension reviews edits in its diff overlay. The headless CLI
 * needs the same accept/reject workflow without a webview, so each completed
 * turn with edits is recorded under `<workspace>/.champ/reviews.json` and can
 * be inspected from `champ review` or the TUI Review screen.
 */
import * as fs from "fs/promises";
import * as nodePath from "path";
import type { EditRecord } from "../agent/edit-review-tracker";

export type ReviewStatus = "pending" | "accepted" | "rejected";

export interface ReviewEntry {
  id: string;
  createdAt: string;
  status: ReviewStatus;
  edits: EditRecord[];
}

interface ReviewDocument {
  version: 1;
  entries: ReviewEntry[];
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `rev_${Date.now().toString(36)}_${counter}`;
}

export class CliReviewStore {
  private readonly file: string;

  constructor(private readonly workspace: string) {
    this.file = nodePath.join(workspace, ".champ", "reviews.json");
  }

  get path(): string {
    return this.file;
  }

  private async read(): Promise<ReviewDocument> {
    try {
      const text = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(text) as ReviewDocument;
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) return parsed;
    } catch {
      // Missing or corrupt store starts empty; never crash a turn over it.
    }
    return { version: 1, entries: [] };
  }

  private async write(doc: ReviewDocument): Promise<void> {
    await fs.mkdir(nodePath.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    await fs.rename(temp, this.file);
  }

  async list(): Promise<ReviewEntry[]> {
    return (await this.read()).entries;
  }

  async get(id: string): Promise<ReviewEntry | null> {
    return (await this.read()).entries.find((entry) => entry.id === id) ?? null;
  }

  /** Consume the tracker's pending edits and persist them as one review. */
  async recordFromTracker(tracker: {
    flush(): EditRecord[];
    reset(): void;
  }): Promise<ReviewEntry | null> {
    const edits = tracker.flush();
    tracker.reset();
    if (edits.length === 0) return null;
    const entry: ReviewEntry = {
      id: nextId(),
      createdAt: new Date().toISOString(),
      status: "pending",
      edits: edits.map((edit) => ({ ...edit })),
    };
    const doc = await this.read();
    doc.entries.push(entry);
    // Keep the store bounded; accepted/rejected history is still useful, but
    // an unbounded JSON file would slow every turn down over time.
    doc.entries = doc.entries.slice(-200);
    await this.write(doc);
    return entry;
  }

  private async apply(
    id: string,
    status: "accepted" | "rejected",
  ): Promise<ReviewEntry | null> {
    const doc = await this.read();
    const entry = doc.entries.find((item) => item.id === id);
    if (!entry) return null;
    for (const edit of entry.edits) {
      const target = nodePath.resolve(this.workspace, edit.path);
      const relative = nodePath.relative(this.workspace, target);
      if (relative.startsWith("..") || nodePath.isAbsolute(relative)) continue;
      const content = status === "accepted" ? edit.newContent : edit.oldContent;
      await fs.mkdir(nodePath.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    }
    entry.status = status;
    await this.write(doc);
    return entry;
  }

  async accept(id: string): Promise<ReviewEntry | null> {
    return this.apply(id, "accepted");
  }

  async reject(id: string): Promise<ReviewEntry | null> {
    return this.apply(id, "rejected");
  }
}
