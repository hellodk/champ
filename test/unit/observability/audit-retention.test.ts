/**
 * Secure audit retention and export.
 *
 * Audit logs are hash-chained and must remain verifiable after rotation and
 * export. Rotation carries the chain's last hash forward as the new genesis,
 * export refuses tampered logs, and pruning never touches the active log.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AuditLog } from "@/observability/audit-log";
import { exportAuditLog, pruneArchives } from "@/observability/audit-retention";

describe("audit retention and export", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-retention-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rotates the active log and continues the hash chain in the new file", async () => {
    const log = new AuditLog(dir);
    await log.initialize();
    log.record("session_start", "before rotation", "s1");
    await log.close();

    const archive = await AuditLog.rotate(dir);
    expect(archive).toBeDefined();
    expect(fs.existsSync(archive!)).toBe(true);

    const archivedChain = await AuditLog.verifyFile(archive!);
    expect(archivedChain.valid).toBe(true);

    const restarted = new AuditLog(dir);
    await restarted.initialize();
    restarted.record("session_start", "after rotation", "s2");
    await restarted.close();
    const current = await restarted.verify();
    expect(current.valid).toBe(true);
  });

  it("prunes only expired archives and never the active log", () => {
    const champDir = path.join(dir, ".champ");
    fs.mkdirSync(champDir, { recursive: true });
    const active = path.join(champDir, "audit.log");
    fs.writeFileSync(active, "active\n");
    const old = path.join(champDir, "audit-2020-01-01T00-00-00.log");
    const recent = path.join(
      champDir,
      `audit-${new Date().toISOString().slice(0, 10)}T00-00-00.log`,
    );
    fs.writeFileSync(old, "old\n");
    fs.writeFileSync(recent, "recent\n");

    const deleted = pruneArchives(champDir, 30, new Date("2026-11-22"));
    expect(deleted).toContain(old);
    expect(deleted).not.toContain(recent);
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("records a trace id on audit entries so logs correlate with spans", async () => {
    const log = new AuditLog(dir);
    await log.initialize();
    log.record("tool_call", "read_file", "s1", "a".repeat(32));
    await log.close();
    const lines = fs.readFileSync(log.logPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).traceId).toBe("a".repeat(32));
    expect((await log.verify()).valid).toBe(true);
  });

  it("exports a valid log with a checksum sidecar and refuses a tampered log", async () => {
    const log = new AuditLog(dir);
    await log.initialize();
    log.record("tool_call", "read_file", "s1");
    await log.close();

    const destination = path.join(dir, "export", "audit.jsonl");
    const result = await exportAuditLog(log.logPath, destination);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(destination)).toBe(true);
    expect(fs.existsSync(`${destination}.sha256`)).toBe(true);

    // Tamper with a line and export must fail closed.
    const lines = fs.readFileSync(log.logPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    entry.details = "tampered";
    fs.writeFileSync(log.logPath, JSON.stringify(entry) + "\n");
    const bad = await exportAuditLog(log.logPath, destination);
    expect(bad.ok).toBe(false);
  });
});
