/**
 * GlobalMemoryBank: user-level cross-workspace memory stored at
 * ~/.champ/memory.json (not in the workspace, not in VS Code
 * extension storage — persists across workspace switches and reinstalls).
 *
 * Pinned global facts are always injected into every new session,
 * regardless of workspace.
 *
 * An optional `homeDir` parameter overrides `os.homedir()`, which is
 * useful for testing without touching the real home directory.
 */
import * as os from "os";
import { MemoryBank } from "./memory-bank";

export class GlobalMemoryBank extends MemoryBank {
  constructor(homeDir?: string) {
    // MemoryBank appends ".champ/memory.json" to the workspaceRoot it receives,
    // so pass the home directory directly — the file will be stored at
    // ~/.champ/memory.json.
    super(homeDir ?? os.homedir());
  }
}
