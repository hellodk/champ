/**
 * Headless tool layer.
 *
 * Exposes the fs-backed implementations in `./fs-tools` plus a registry
 * factory so CLI/bench/test code can wire the agent to a working tool set
 * without touching `src/extension.ts` (which imports `vscode`).
 *
 * Must not import `vscode`.
 */
import { ToolRegistry } from "../registry";
import { headlessFsTools } from "./fs-tools";

export * from "./fs-tools";

/**
 * Build a `ToolRegistry` pre-populated with the headless fs tools.
 *
 * Approval-taking tools still go through `ToolRegistry.execute`, so the caller
 * supplies the approval policy via `ToolExecutionContext.requestApproval`
 * (auto-approve for one-shot runs, prompt for the REPL).
 */
export function createHeadlessToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of headlessFsTools) {
    registry.register(tool);
  }
  return registry;
}
