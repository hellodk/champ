/**
 * Multi-agent safety primitives: bounded concurrency, ownership contracts and
 * detached worktrees. No routine in this module merges work back into the
 * shared workspace; changes must be reviewed explicitly.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ConcurrencyLimiterOptions {
  maxGlobal?: number;
  maxPerProvider?: number;
  maxQueued?: number;
}

interface Waiter {
  provider: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
}

export class ConcurrencyLimiter {
  private readonly maxGlobal: number;
  private readonly maxPerProvider: number;
  private readonly maxQueued: number;
  private activeGlobal = 0;
  private activeByProvider = new Map<string, number>();
  private waiters: Waiter[] = [];

  constructor(opts: ConcurrencyLimiterOptions = {}) {
    this.maxGlobal = Math.max(1, opts.maxGlobal ?? 4);
    this.maxPerProvider = Math.max(1, opts.maxPerProvider ?? 2);
    this.maxQueued = Math.max(0, opts.maxQueued ?? 32);
  }

  private canStart(provider: string): boolean {
    return (
      this.activeGlobal < this.maxGlobal &&
      (this.activeByProvider.get(provider) ?? 0) < this.maxPerProvider
    );
  }

  acquire(provider: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("acquire aborted"));
    }
    if (this.canStart(provider)) {
      return Promise.resolve(this.start(provider));
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(
        new Error(`backpressure: delegation queue is full (${this.maxQueued})`),
      );
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { provider, resolve, reject, signal };
      signal?.addEventListener(
        "abort",
        () => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error("acquire aborted"));
        },
        { once: true },
      );
      this.waiters.push(waiter);
      this.pump();
    });
  }

  private start(provider: string): () => void {
    this.activeGlobal++;
    this.activeByProvider.set(
      provider,
      (this.activeByProvider.get(provider) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeGlobal--;
      const next = Math.max(0, (this.activeByProvider.get(provider) ?? 1) - 1);
      this.activeByProvider.set(provider, next);
      this.pump();
    };
  }

  private pump(): void {
    const remaining: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("acquire aborted"));
        continue;
      }
      if (this.canStart(waiter.provider)) {
        waiter.resolve(this.start(waiter.provider));
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  stats(): {
    activeGlobal: number;
    queued: number;
    activeByProvider: Record<string, number>;
  } {
    return {
      activeGlobal: this.activeGlobal,
      queued: this.waiters.length,
      activeByProvider: Object.fromEntries(this.activeByProvider),
    };
  }

  cancelQueued(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(new Error("acquire aborted"));
  }
}

export type OwnershipMode = "exclusive" | "shared";

interface Claim {
  owner: string;
  paths: string[];
  mode: OwnershipMode;
}

function normalize(filePath: string): string {
  return path.resolve(filePath).replace(/\/+$/, "");
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export class OwnershipRegistry {
  private claims = new Map<string, Claim>();

  claim(owner: string, paths: string[], mode: OwnershipMode): void {
    const normalized = paths.map(normalize);
    for (const [otherOwner, claim] of this.claims) {
      if (otherOwner === owner) continue;
      const conflict = normalized.some((mine) =>
        claim.paths.some(
          (theirs) =>
            overlaps(mine, theirs) &&
            (mode === "exclusive" || claim.mode === "exclusive"),
        ),
      );
      if (conflict) {
        throw new Error(
          `ownership conflict: ${owner} cannot claim ${normalized.join(", ")} (held by ${otherOwner})`,
        );
      }
    }
    this.claims.set(owner, { owner, paths: normalized, mode });
  }

  release(owner: string): void {
    this.claims.delete(owner);
  }

  claimsFor(owner: string): string[] {
    return [...(this.claims.get(owner)?.paths ?? [])];
  }
}

type WorktreeRunner = (
  command: string,
  args: string[],
  cwd?: string,
) => Promise<string>;

export interface WorktreeHandle {
  path: string;
  /** Review-only diff; no merge is applied. */
  diff(): Promise<string>;
  cleanup(): Promise<void>;
}

export interface WorktreeManagerOptions {
  run?: WorktreeRunner;
  baseDir?: string;
}

export class WorktreeManager {
  private readonly run: WorktreeRunner;
  private readonly baseDir: string;

  constructor(opts: WorktreeManagerOptions = {}) {
    this.baseDir = opts.baseDir ?? path.join(os.tmpdir(), "champ-worktrees");
    this.run =
      opts.run ??
      (async (command, args, cwd) => {
        const { stdout } = await execFileAsync(command, args, { cwd });
        return stdout;
      });
  }

  async create(workspaceRoot: string, taskId: string): Promise<WorktreeHandle> {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId) || taskId.includes("..")) {
      throw new Error(`invalid worktree task id: ${taskId}`);
    }
    fs.mkdirSync(this.baseDir, { recursive: true });
    const target = path.join(this.baseDir, taskId);
    await this.run(
      "git",
      ["-C", workspaceRoot, "worktree", "add", "--detach", target, "HEAD"],
      workspaceRoot,
    );
    return {
      path: target,
      diff: () =>
        this.run(
          "git",
          ["-C", workspaceRoot, "diff", "--no-ext-diff", "--", target],
          workspaceRoot,
        ),
      cleanup: async () => {
        await this.run(
          "git",
          ["-C", workspaceRoot, "worktree", "remove", "--force", target],
          workspaceRoot,
        );
        await fs.promises.rm(target, { recursive: true, force: true });
      },
    };
  }
}
