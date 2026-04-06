/**
 * AutoFixService: LSP diagnostics -> LLM fix loop.
 *
 * After an agent run edits files, VS Code's language servers re-analyze
 * and report any new errors. This service detects those errors, feeds
 * them back into the agent as a system message asking for a fix, runs
 * another agent iteration, and repeats until errors are resolved or a
 * maximum iteration count is hit (default 3).
 *
 * The iteration cap is critical: without it, a stubborn error can
 * cause the agent to loop indefinitely, burning through tokens.
 */
import * as vscode from "vscode";

export interface FileErrors {
  filePath: string;
  diagnostics: vscode.Diagnostic[];
}

/**
 * Minimal interface the AgentController must provide for auto-fix
 * integration. Declared inline so the service doesn't need a circular
 * dependency on the full AgentController type.
 */
export interface AgentControllerLike {
  isActiveSession(): boolean;
  getLastModifiedFiles(): string[];
  injectSystemMessage(message: string): Promise<void>;
  runAgentLoop(): Promise<void>;
  postMessageToUI(message: { type: string; message?: string }): void;
}

const DEFAULT_MAX_ITERATIONS = 3;
/**
 * Delay between running the agent and re-checking diagnostics. LSPs
 * need a moment to re-analyze after file changes; without this delay
 * we'd read stale diagnostics and prematurely conclude "still broken".
 */
const LSP_SETTLE_DELAY_MS = 500;

export class AutoFixService {
  constructor(
    private readonly agent: AgentControllerLike,
    private readonly maxIterations: number = DEFAULT_MAX_ITERATIONS,
  ) {}

  /**
   * Query VS Code for current diagnostics on the given files and
   * collect any errors. Returns empty when no active session is running
   * so a stale auto-fix doesn't fire after the user has moved on.
   */
  checkForErrors(filePaths: string[]): FileErrors[] {
    if (!this.agent.isActiveSession()) return [];

    const results: FileErrors[] = [];
    for (const filePath of filePaths) {
      const uri = vscode.Uri.file(filePath);
      const diagnostics = vscode.languages.getDiagnostics(
        uri,
      ) as vscode.Diagnostic[];
      const errors = diagnostics.filter(
        (d) =>
          d.severity === vscode.DiagnosticSeverity.Error ||
          (d.severity as number) === 0,
      );
      if (errors.length > 0) {
        results.push({ filePath, diagnostics: errors });
      }
    }
    return results;
  }

  /**
   * Run the auto-fix loop: re-check current LSP state, inject error
   * context into the agent, run it, and repeat. Stops when errors
   * clear or maxIterations is hit.
   *
   * On the first attempt, an empty LSP check falls back to the caller's
   * initialErrors — LSPs often haven't re-analyzed yet when auto-fix
   * kicks in right after an agent edit, and we don't want to skip the
   * fix loop because of a timing gap.
   */
  async runAutoFixLoop(initialErrors: FileErrors[]): Promise<void> {
    if (initialErrors.length === 0) return;

    const filePaths = initialErrors.map((e) => e.filePath);
    let errors: FileErrors[] = initialErrors;

    for (let attempt = 1; attempt <= this.maxIterations; attempt++) {
      const current = this.checkForErrors(filePaths);

      if (current.length > 0) {
        errors = current;
      } else if (attempt > 1) {
        // On later attempts, an empty check means the fix worked.
        return;
      }
      // On attempt 1 with empty LSP check, keep the initialErrors —
      // the LSP may simply not have caught up yet.

      if (errors.length === 0) return;

      const summary = this.formatErrors(errors);
      await this.agent.injectSystemMessage(
        `The following errors were detected after your edits (attempt ${attempt}/${this.maxIterations}). Please fix them:\n\n${summary}`,
      );
      await this.agent.runAgentLoop();

      // Give the LSP a moment to re-analyze before the next iteration.
      await new Promise((resolve) => setTimeout(resolve, LSP_SETTLE_DELAY_MS));
    }

    // All iterations exhausted — if errors still linger, notify the UI.
    const final = this.checkForErrors(filePaths);
    if (final.length > 0) {
      this.agent.postMessageToUI({
        type: "error",
        message: `Auto-fix reached maximum iterations (${this.maxIterations}). Some errors remain. Please review manually.`,
      });
    }
  }

  /**
   * Format a set of file errors into a compact summary suitable for
   * injection into the LLM context.
   */
  private formatErrors(errors: FileErrors[]): string {
    const sections: string[] = [];
    for (const fileErr of errors) {
      const lines = fileErr.diagnostics.map((d) => {
        const range = d.range as vscode.Range | undefined;
        const line = range ? range.start.line + 1 : "?";
        const source = (d as { source?: string }).source ?? "unknown";
        return `  Line ${line}: ${d.message} [${source}]`;
      });
      sections.push(`File: ${fileErr.filePath}\n${lines.join("\n")}`);
    }
    return sections.join("\n\n");
  }
}
