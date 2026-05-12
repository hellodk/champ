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
      const watcher = vscode.workspace.createFileSystemWatcher(def.glob);

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

      const saveDisposable =
        def.on === "change"
          ? watcher.onDidChange(handler)
          : ((
              watcher as vscode.FileSystemWatcher & {
                onDidSave?: (
                  handler: (uri: vscode.Uri) => void,
                ) => vscode.Disposable;
              }
            ).onDidSave?.(handler) ?? watcher.onDidChange(handler));

      this.watchers.push(watcher, saveDisposable);
    }
  }

  disposeAll(): void {
    for (const [, timer] of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
  }
}
