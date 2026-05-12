import * as vscode from "vscode";
import type { TriggerDefinition } from "../config/config-loader";

const DEFAULT_DEBOUNCE_MS = 2000;

export class TriggerManager {
  private watchers: vscode.Disposable[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  loadTriggers(
    defs: TriggerDefinition[],
    runAgent: (agentName: string, filePath: string) => Promise<void>,
  ): void {
    this.disposeAll();
    for (const def of defs) {
      const debounce = def.debounceMs ?? DEFAULT_DEBOUNCE_MS;

      const handler = (uri: vscode.Uri) => {
        const key = `${def.name}::${uri.fsPath}`;
        const existing = this.timers.get(key);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.timers.delete(key);
          void runAgent(def.run, uri.fsPath).catch((err) => {
            console.error(`Champ trigger "${def.name}" failed:`, err);
          });
        }, debounce);
        this.timers.set(key, timer);
      };

      if (def.on === "change") {
        // Use FileSystemWatcher for change events.
        const watcher = vscode.workspace.createFileSystemWatcher(def.glob);
        const disposable = watcher.onDidChange(handler);
        this.watchers.push(watcher, disposable);
      } else {
        // Use onDidSaveTextDocument for save events — filters by glob manually.
        const disposable = vscode.workspace.onDidSaveTextDocument((doc) => {
          // Match the glob against the relative path.
          const rel = vscode.workspace.asRelativePath(doc.uri);
          if (this.matchesGlob(rel, def.glob)) {
            handler(doc.uri);
          }
        });
        this.watchers.push(disposable);
      }
    }
  }

  /** Minimal glob matcher for trigger path filtering. */
  private matchesGlob(filePath: string, glob: string): boolean {
    // Convert glob to regex: ** matches anything, * matches non-separator.
    const normalized = filePath.replace(/\\/g, "/");
    const pattern = glob
      .replace(/\\/g, "/")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "⟦DSTAR⟧")
      .replace(/\*/g, "[^/]*")
      .replace(/⟦DSTAR⟧/g, ".*");
    return new RegExp(`^${pattern}$`).test(normalized) ||
      new RegExp(`(^|/)${pattern}$`).test(normalized);
  }

  disposeAll(): void {
    for (const [, timer] of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
  }
}
