/**
 * Reliable watcher for the user-level config file (~/.champ/config.yaml).
 *
 * Issue #129: the previous implementation relied on
 * vscode.workspace.createFileSystemWatcher with a RelativePattern rooted at
 * os.homedir(). Watching a path OUTSIDE the active workspace via
 * FileSystemWatcher is unreliable on Linux (microsoft/vscode out-of-workspace
 * watching), so edits made from a terminal/external tool were frequently
 * missed — the provider kept a stale config until a full window restart.
 *
 * This combines two signals, both debounced:
 *   - An injected native watcher (the VS Code FileSystemWatcher fast path),
 *     which fires immediately for in-VS-Code edits.
 *   - A content signal poller: it stats the file's mtime every pollIntervalMs
 *     and schedules a reload only when the mtime actually changes. This is
 *     platform-independent and catches edits made outside the workspace.
 *
 * The poller is self-contained and dependency-injected so it is unit-testable
 * with a fake clock and a fake stat() — no VS Code API required.
 */

export interface ConfigWatcherDeps {
  /** Absolute path of the config file to watch. */
  path: string;
  /** Debounced callback invoked when the config file changes. */
  onChange: () => void;
  /** Debounce window in ms before onChange fires. Default 300. */
  debounceMs?: number;
  /** Poll interval in ms. Default 2000. */
  pollIntervalMs?: number;
  /** Injectable clock for tests. */
  now: () => number;
  setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn: (id: ReturnType<typeof setInterval>) => void;
  setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn: (id: ReturnType<typeof setTimeout>) => void;
  /** Stat the file's mtime. Return null when the file is missing. */
  stat: (path: string) => Promise<{ mtimeMs: number } | null>;
}

export class ConfigWatcher {
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last observed mtime (null until baseline established). */
  private lastMtimeMs: number | null = null;
  private disposed = false;

  constructor(private readonly deps: ConfigWatcherDeps) {
    this.debounceMs = deps.debounceMs ?? 300;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
  }

  start(): void {
    if (this.intervalId !== undefined) return;
    this.intervalId = this.deps.setIntervalFn(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.intervalId !== undefined) {
      this.deps.clearIntervalFn(this.intervalId);
      this.intervalId = undefined;
    }
    if (this.debounceTimer !== undefined) {
      this.deps.clearTimeoutFn(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  /** Called when the native watcher (or any caller) reports a change. */
  signalChanged(): void {
    this.scheduleReload();
  }

  private async poll(): Promise<void> {
    let mtime: number | null;
    try {
      const stat = await this.deps.stat(this.deps.path);
      mtime = stat ? stat.mtimeMs : null;
    } catch {
      // stat failure is treated as "missing" — surface a reload once.
      mtime = null;
    }

    // First observation establishes the baseline without firing.
    if (this.lastMtimeMs === null) {
      this.lastMtimeMs = mtime;
      return;
    }

    if (mtime !== this.lastMtimeMs) {
      this.lastMtimeMs = mtime;
      this.scheduleReload();
    }
  }

  private scheduleReload(): void {
    if (this.disposed) return;
    if (this.debounceTimer !== undefined) {
      this.deps.clearTimeoutFn(this.debounceTimer);
    }
    this.debounceTimer = this.deps.setTimeoutFn(() => {
      this.debounceTimer = undefined;
      this.deps.onChange();
    }, this.debounceMs);
  }
}
