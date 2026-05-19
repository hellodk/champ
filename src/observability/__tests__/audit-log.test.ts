import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { AuditLog, type AuditEntry } from "../audit-log";

/**
 * Helper: create a temp directory that is cleaned up after each test.
 */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "audit-log-test-"));
}

describe("AuditLog", () => {
  let tmpDir: string;
  let auditLog: AuditLog;

  beforeEach(() => {
    tmpDir = makeTempDir();
    auditLog = new AuditLog(tmpDir);
  });

  afterEach(async () => {
    await auditLog.close();
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── initialize ──────────────────────────────────────────────────────────

  it("initialize() creates the .champ directory if it does not exist", async () => {
    await auditLog.initialize();
    expect(fs.existsSync(path.join(tmpDir, ".champ"))).toBe(true);
  });

  it("initialize() starts fresh when log file does not exist", async () => {
    await auditLog.initialize();
    auditLog.record("session_start", "session=abc");
    await auditLog.close();

    const lines = fs
      .readFileSync(path.join(tmpDir, ".champ", "audit.log"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
  });

  it("initialize() reads last hash from existing log to continue the chain", async () => {
    // First session — write two entries
    const log1 = new AuditLog(tmpDir);
    await log1.initialize();
    log1.record("session_start", "first");
    log1.record("tool_call", "second");
    await log1.close();

    // Second session — should continue from where log1 left off
    const log2 = new AuditLog(tmpDir);
    await log2.initialize();
    log2.record("session_end", "third");
    await log2.close();

    // Verify the whole chain is intact
    const verifyLog = new AuditLog(tmpDir);
    const result = await verifyLog.verify();
    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(3);
  });

  // ── record ──────────────────────────────────────────────────────────────

  it("record() writes a valid JSON line with all required fields", async () => {
    await auditLog.initialize();
    auditLog.record("tool_call", "tool=read_file args={}", "sess-1");
    await auditLog.close();

    const raw = fs.readFileSync(auditLog.logPath, "utf-8");
    const entry = JSON.parse(raw.trim()) as AuditEntry;
    expect(entry.action).toBe("tool_call");
    expect(entry.details).toBe("tool=read_file args={}");
    expect(entry.sessionId).toBe("sess-1");
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.hash).toHaveLength(64);
  });

  it("record() truncates details at 500 characters", async () => {
    await auditLog.initialize();
    const longDetails = "x".repeat(600);
    auditLog.record("terminal_run", longDetails);
    await auditLog.close();

    const raw = fs.readFileSync(auditLog.logPath, "utf-8");
    const entry = JSON.parse(raw.trim()) as AuditEntry;
    expect(entry.details).toHaveLength(500);
    expect(entry.details).toBe("x".repeat(500));
  });

  it("record() is a no-op when stream is not open", () => {
    // Do NOT call initialize() — stream is undefined
    expect(() => {
      auditLog.record("tool_call", "should not throw");
    }).not.toThrow();
  });

  // ── hash chain integrity ─────────────────────────────────────────────────

  it("hash chain is intact across multiple entries", async () => {
    await auditLog.initialize();
    auditLog.record("session_start", "session=s1", "s1");
    auditLog.record("tool_call", "tool=read_file", "s1");
    auditLog.record("file_edit", "path=src/foo.ts", "s1");
    auditLog.record("terminal_run", "cmd=npm test", "s1");
    auditLog.record("session_end", "session=s1", "s1");
    await auditLog.close();

    const result = await auditLog.verify();
    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(5);
    expect(result.firstBrokenAt).toBeUndefined();
  });

  it("verify() correctly chains each entry's hash to the previous", async () => {
    await auditLog.initialize();
    auditLog.record("tool_call", "a");
    auditLog.record("tool_call", "b");
    auditLog.record("tool_call", "c");
    await auditLog.close();

    const lines = fs.readFileSync(auditLog.logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);

    // Manually recompute hashes
    let prevHash = "0".repeat(64);
    for (const line of lines) {
      const entry = JSON.parse(line) as AuditEntry;
      const { hash, ...rest } = entry;
      const expected = crypto
        .createHash("sha256")
        .update(prevHash + JSON.stringify(rest))
        .digest("hex");
      expect(hash).toBe(expected);
      prevHash = hash;
    }
  });

  // ── tamper detection ─────────────────────────────────────────────────────

  it("verify() detects tampering when an entry is modified", async () => {
    await auditLog.initialize();
    auditLog.record("session_start", "legit", "s1");
    auditLog.record("tool_call", "legit2", "s1");
    auditLog.record("file_edit", "legit3", "s1");
    await auditLog.close();

    const raw = fs.readFileSync(auditLog.logPath, "utf-8");
    const lines = raw.trim().split("\n");

    // Tamper with the second entry's details
    const tampered = JSON.parse(lines[1]) as AuditEntry;
    tampered.details = "TAMPERED";
    lines[1] = JSON.stringify(tampered);

    fs.writeFileSync(auditLog.logPath, lines.join("\n") + "\n");

    const result = await auditLog.verify();
    expect(result.valid).toBe(false);
    expect(result.firstBrokenAt).toBe(2);
    expect(result.totalEntries).toBe(3);
  });

  it("verify() reports firstBrokenAt=1 when the first entry is tampered", async () => {
    await auditLog.initialize();
    auditLog.record("tool_call", "original");
    auditLog.record("tool_call", "second");
    await auditLog.close();

    const raw = fs.readFileSync(auditLog.logPath, "utf-8");
    const lines = raw.trim().split("\n");

    // Tamper with the very first entry
    const tampered = JSON.parse(lines[0]) as AuditEntry;
    tampered.action = "file_edit";
    lines[0] = JSON.stringify(tampered);

    fs.writeFileSync(auditLog.logPath, lines.join("\n") + "\n");

    const result = await auditLog.verify();
    expect(result.valid).toBe(false);
    expect(result.firstBrokenAt).toBe(1);
  });

  // ── verify edge cases ────────────────────────────────────────────────────

  it("verify() on empty file returns valid: true, totalEntries: 0", async () => {
    await auditLog.initialize();
    await auditLog.close();

    const result = await auditLog.verify();
    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(0);
    expect(result.firstBrokenAt).toBeUndefined();
  });

  it("verify() on non-existent log returns valid: false, totalEntries: 0", async () => {
    // Don't call initialize — log file doesn't exist
    const result = await auditLog.verify();
    expect(result.valid).toBe(false);
    expect(result.totalEntries).toBe(0);
  });

  it("verify() on single valid entry returns valid: true, totalEntries: 1", async () => {
    await auditLog.initialize();
    auditLog.record("llm_call", "model=claude");
    await auditLog.close();

    const result = await auditLog.verify();
    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(1);
  });
});
