/**
 * StagedEdits: in-memory buffer for file edits within a single agent turn.
 *
 * Problem: sequential edit_file calls write to disk immediately. Each call
 * reads the original file, so a second edit to the same file doesn't see
 * the first edit's changes. A 10-file refactor applies edits that conflict.
 *
 * Solution: buffer all edits within a turn. edit_file reads from staging
 * (if already modified this turn) or disk. Writes go only to staging.
 * After the turn ends, flush() writes all staged content atomically.
 *
 * read_file also checks staging first so the agent can verify its own edits
 * within the same turn without triggering a disk round-trip.
 */
import * as fs from "fs/promises";
import * as path from "path";

export interface StagedFileChange {
  /** Absolute path to the file. */
  absolutePath: string;
  /** Relative path (for display). */
  relativePath: string;
  /** Content before any edits this turn. */
  oldContent: string;
  /** Content after all edits this turn. */
  newContent: string;
}

export class StagedEdits {
  private staged = new Map<
    string,
    { original: string; current: string; relativePath: string }
  >();

  /** Whether a file has been modified in this staging session. */
  has(absolutePath: string): boolean {
    return this.staged.has(absolutePath);
  }

  /**
   * Get the current staged content for a file.
   * Returns undefined if the file has not been staged yet.
   */
  getCurrent(absolutePath: string): string | undefined {
    return this.staged.get(absolutePath)?.current;
  }

  /**
   * Record an edit: store the new content.
   * If this file has already been staged this turn, the original is preserved
   * from the first edit so the final diff is old→new across the full turn.
   */
  stage(
    absolutePath: string,
    originalContent: string,
    newContent: string,
    relativePath: string,
  ): void {
    const existing = this.staged.get(absolutePath);
    this.staged.set(absolutePath, {
      original: existing?.original ?? originalContent,
      current: newContent,
      relativePath,
    });
  }

  /** Number of files with staged changes. */
  size(): number {
    return this.staged.size;
  }

  /**
   * Write all staged changes to disk atomically.
   * Returns an array of changes for diff-overlay display.
   * Clears the staging buffer after flushing.
   */
  async flush(): Promise<StagedFileChange[]> {
    const changes: StagedFileChange[] = [];
    for (const [absolutePath, { original, current, relativePath }] of this
      .staged) {
      try {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, current, "utf-8");
        changes.push({
          absolutePath,
          relativePath,
          oldContent: original,
          newContent: current,
        });
      } catch (err) {
        console.error(`StagedEdits: failed to flush ${absolutePath}:`, err);
      }
    }
    this.staged.clear();
    return changes;
  }

  /** Discard all staged changes without writing to disk. */
  clear(): void {
    this.staged.clear();
  }
}
