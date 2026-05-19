/**
 * AuditLog: append-only tamper-evident log of all agent actions.
 *
 * Each entry contains:
 *   - ISO timestamp
 *   - Action type (file_edit, terminal_run, llm_call, tool_call, session_start, session_end)
 *   - Details (truncated at 500 chars)
 *   - SHA256 of (previous hash + this entry's JSON) — hash chain
 *
 * Stored at: <workspaceRoot>/.champ/audit.log (one JSON line per entry)
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export type AuditActionType =
  | "file_edit"
  | "terminal_run"
  | "llm_call"
  | "tool_call"
  | "session_start"
  | "session_end";

export interface AuditEntry {
  timestamp: string;
  action: AuditActionType;
  details: string;
  sessionId?: string;
  hash: string; // SHA256(prevHash + JSON of this entry without the hash field)
}

export class AuditLog {
  private prevHash = "0".repeat(64); // genesis hash
  readonly logPath: string;
  private readonly maxEntrySizeBytes = 500;
  /** Hard cap on the pre-init pending queue. Prevents unbounded growth if
   *  initialize() never completes (e.g. disk full or workspace root missing). */
  private readonly MAX_PENDING = 100;
  private stream?: fs.WriteStream;
  private pendingQueue: Array<{
    action: AuditActionType;
    details: string;
    sessionId?: string;
  }> = [];
  private initialized = false;

  constructor(workspaceRoot: string) {
    this.logPath = path.join(workspaceRoot, ".champ", "audit.log");
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.logPath), { recursive: true });
    // Read last hash from existing log to continue the chain
    try {
      const content = await fs.promises.readFile(this.logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
        this.prevHash = last.hash;
      }
    } catch {
      // New log — start fresh
    }
    // Open append stream
    this.stream = fs.createWriteStream(this.logPath, {
      flags: "a",
      encoding: "utf-8",
    });
    this.initialized = true;

    // Drain any records that arrived before initialization
    for (const pending of this.pendingQueue) {
      this._writeEntry(pending.action, pending.details, pending.sessionId);
    }
    this.pendingQueue = [];
  }

  record(action: AuditActionType, details: string, sessionId?: string): void {
    if (!this.initialized) {
      // Queue until stream is ready; drop silently once the cap is hit to
      // prevent OOM if initialize() never completes (disk full, missing dir, etc.)
      if (this.pendingQueue.length >= this.MAX_PENDING) return;
      this.pendingQueue.push({ action, details, sessionId });
      return;
    }
    if (!this.stream?.writable) return;
    this._writeEntry(action, details, sessionId);
  }

  private _writeEntry(
    action: AuditActionType,
    details: string,
    sessionId?: string,
  ): void {
    const truncated = details.slice(0, this.maxEntrySizeBytes);
    const timestamp = new Date().toISOString();
    const entryWithoutHash = {
      timestamp,
      action,
      details: truncated,
      sessionId,
    };
    const hash = crypto
      .createHash("sha256")
      .update(this.prevHash + JSON.stringify(entryWithoutHash))
      .digest("hex");

    const entry: AuditEntry = { ...entryWithoutHash, hash };
    this.prevHash = hash;

    this.stream!.write(JSON.stringify(entry) + "\n");
  }

  async verify(): Promise<{
    valid: boolean;
    totalEntries: number;
    firstBrokenAt?: number;
    tooLarge?: boolean;
  }> {
    try {
      const stat = await fs.promises.stat(this.logPath);
      if (stat.size > 50 * 1024 * 1024) {
        // 50MB limit — reading into memory would risk OOM
        return { valid: false, totalEntries: -1, tooLarge: true };
      }
      const content = await fs.promises.readFile(this.logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        return { valid: true, totalEntries: 0 };
      }
      let prevHash = "0".repeat(64);
      for (let i = 0; i < lines.length; i++) {
        const entry = JSON.parse(lines[i]) as AuditEntry;
        const { hash, ...rest } = entry;
        const expected = crypto
          .createHash("sha256")
          .update(prevHash + JSON.stringify(rest))
          .digest("hex");
        if (expected !== hash) {
          return {
            valid: false,
            totalEntries: lines.length,
            firstBrokenAt: i + 1,
          };
        }
        prevHash = hash;
      }
      return { valid: true, totalEntries: lines.length };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist — not tampered, just empty/new log
        return { valid: true, totalEntries: 0 };
      }
      return { valid: false, totalEntries: 0 };
    }
  }

  /** Synchronous close: ends the stream non-blocking (OS flushes on process exit). */
  closeSync(): void {
    if (this.stream) {
      const s = this.stream;
      this.stream = undefined;
      // Suppress any post-end errors (e.g. ENOENT if the underlying fd closed early)
      s.on("error", () => undefined);
      s.end();
    }
    // Pending entries at close time are discarded — acceptable for shutdown path.
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) {
        resolve();
        return;
      }
      const stream = this.stream;
      this.stream = undefined;
      stream.end(() => resolve());
    });
  }
}
