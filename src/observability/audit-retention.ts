/**
 * Secure audit retention and export helpers.
 *
 * - `exportAuditLog` verifies the hash chain before copying bytes out, so a
 *   tampered log can never be exported as trusted evidence, and writes a
 *   SHA256 sidecar for the exported file.
 * - `pruneArchives` deletes only timestamped rotated archives past their
 *   retention window; the active `audit.log` is never removed.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AuditLog } from "./audit-log";

export interface AuditExportResult {
  ok: boolean;
  reason?: string;
  entries?: number;
  checksum?: string;
}

const GENESIS = "0".repeat(64);

async function readGenesis(logPath: string): Promise<string> {
  try {
    const raw = await fs.promises.readFile(`${logPath}.genesis`, "utf-8");
    const value = raw.trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : GENESIS;
  } catch {
    return GENESIS;
  }
}

/** Verify, then copy a log to `destination` with a `.sha256` sidecar. */
export async function exportAuditLog(
  logPath: string,
  destination: string,
): Promise<AuditExportResult> {
  const verification = await AuditLog.verifyFile(
    logPath,
    await readGenesis(logPath),
  );
  if (!verification.valid) {
    return {
      ok: false,
      reason: verification.tooLarge
        ? "log exceeds the verification size limit"
        : `hash chain invalid at entry ${verification.firstBrokenAt ?? "unknown"}`,
    };
  }
  const bytes = await fs.promises.readFile(logPath);
  const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.writeFile(destination, bytes);
  await fs.promises.writeFile(
    `${destination}.sha256`,
    `${checksum}  ${path.basename(destination)}\n`,
    "utf-8",
  );
  return { ok: true, entries: verification.totalEntries, checksum };
}

/**
 * Delete rotated `audit-<timestamp>.log` archives older than `maxAgeDays`.
 * The active `audit.log` and all non-matching files are left untouched.
 */
export function pruneArchives(
  champDir: string,
  maxAgeDays: number,
  now = new Date(),
): string[] {
  const deleted: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(champDir);
  } catch {
    return deleted;
  }
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const name of names) {
    const match = /^audit-(\d{4}-\d{2}-\d{2})T.*\.log$/.exec(name);
    if (!match) continue;
    const time = Date.parse(`${match[1]}T00:00:00Z`);
    if (!Number.isFinite(time) || time >= cutoff) continue;
    const full = path.join(champDir, name);
    try {
      fs.unlinkSync(full);
      deleted.push(full);
    } catch {
      // A concurrent prune may have removed it already.
    }
  }
  return deleted;
}
