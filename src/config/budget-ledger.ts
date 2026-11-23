/**
 * Cross-process daily spend ledger.
 *
 * A plain in-memory BudgetEnforcer cannot bound spend across CLI invocations
 * or extension-host restarts. This ledger stores day totals on disk and uses
 * an exclusive lock file so concurrent processes cannot lose each other's
 * writes. Missing ledger files are normal; malformed ones are an error rather
 * than an implicit budget reset.
 */
import * as fs from "fs";
import * as path from "path";

export interface BudgetTotals {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface BudgetLedger {
  read(key: string): BudgetTotals | null;
  write(key: string, totals: BudgetTotals): void;
  update(
    key: string,
    fn: (current: BudgetTotals) => BudgetTotals,
  ): BudgetTotals;
}

interface LedgerFile {
  version: 1;
  entries: Record<string, BudgetTotals>;
}

const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 5_000;
const sleep = new Int32Array(new SharedArrayBuffer(4));

export class FileBudgetLedger implements BudgetLedger {
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  private withLock<T>(fn: () => T): T {
    const lockFile = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, "wx");
        try {
          return fn();
        } finally {
          fs.closeSync(fd);
          try {
            fs.unlinkSync(lockFile);
          } catch {
            // best effort: a stale lock is reclaimed below
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS) {
            fs.unlinkSync(lockFile);
            continue;
          }
        } catch {
          // lock disappeared between stat and unlink: retry
        }
        if (Date.now() > deadline) {
          throw new Error(`budget ledger lock timeout: ${lockFile}`);
        }
        Atomics.wait(sleep, 0, 0, 5);
      }
    }
  }

  private load(): LedgerFile {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, entries: {} };
      }
      throw err;
    }
    const parsed = JSON.parse(text) as Partial<LedgerFile>;
    if (
      parsed.version !== 1 ||
      !parsed.entries ||
      typeof parsed.entries !== "object"
    ) {
      throw new Error(`unsupported budget ledger format: ${this.file}`);
    }
    return { version: 1, entries: parsed.entries };
  }

  private save(data: LedgerFile): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, this.file);
  }

  read(key: string): BudgetTotals | null {
    return this.withLock(() => this.load().entries[key] ?? null);
  }

  write(key: string, totals: BudgetTotals): void {
    this.withLock(() => {
      const data = this.load();
      data.entries[key] = totals;
      this.save(data);
    });
  }

  update(
    key: string,
    fn: (current: BudgetTotals) => BudgetTotals,
  ): BudgetTotals {
    return this.withLock(() => {
      const data = this.load();
      const current: BudgetTotals = data.entries[key] ?? {
        inputTokens: 0,
        outputTokens: 0,
        usd: 0,
      };
      const next = fn(current);
      data.entries[key] = next;
      this.save(data);
      return next;
    });
  }
}
