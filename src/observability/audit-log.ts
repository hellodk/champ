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
  private stream?: fs.WriteStream;

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
  }

  record(action: AuditActionType, details: string, sessionId?: string): void {
    if (!this.stream?.writable) return;

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

    this.stream.write(JSON.stringify(entry) + "\n");
  }

  async verify(): Promise<{
    valid: boolean;
    totalEntries: number;
    firstBrokenAt?: number;
  }> {
    try {
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
    } catch {
      return { valid: false, totalEntries: 0 };
    }
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
