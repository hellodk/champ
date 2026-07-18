/**
 * ComposerController: multi-file edit workflow.
 *
 * Wraps the multi-agent orchestrator with a "Plan -> Diff -> Apply"
 * workflow optimized for multi-file changes. The user sees the plan
 * first, then a diff view for each affected file, and can accept or
 * reject on a per-file (or per-hunk) basis. Accepted changes are
 * applied and optionally committed to a new git branch so the edit
 * is easy to roll back.
 */
import * as vscode from "vscode";
import type {
  AgentOrchestrator,
  WorkflowResult,
} from "../agent/multi-agent-runner";
import type { Diff, Plan, PlanStep } from "../agent/agents/types";
import { resolveInWorkspace } from "../utils/workspace-path";

/**
 * Git-related operations the composer needs. Kept as an interface so
 * tests can mock it and so the production implementation (in
 * src/composer/git-integration.ts) can be swapped for a different VCS.
 */
export interface GitIntegration {
  createBranch(name: string): Promise<string>;
  commit(message: string): Promise<string>;
  rollback(): Promise<void>;
}

export interface ComposerDeps {
  orchestrator: AgentOrchestrator;
  gitIntegration: GitIntegration;
  /** Workspace root; defaults to process.cwd() for tests. */
  workspaceRoot?: string;
}

export interface DiffsResult {
  diffs: Diff[];
  plan?: Plan | PlanStep[];
}

export interface ApplyOptions {
  /** Indices into the diffs array that the user approved. */
  approved: number[];
  /** Indices that were explicitly rejected (for reporting only). */
  rejected?: number[];
  /** If true, create a new git branch before applying. */
  createBranch?: boolean;
  /** If true, automatically commit applied changes. */
  autoCommit?: boolean;
  /** Custom commit message when autoCommit is true. */
  commitMessage?: string;
}

export interface ApplyResult {
  success: boolean;
  filesModified: string[];
  filesSkipped: string[];
  errors: string[];
  branchName?: string;
  commitSha?: string;
  /** Atomic transaction status: "validated" (pre-flight passed), "committed" (all applied), "rolled_back" (validation or apply failed) */
  transactionStatus?: "validated" | "committed" | "rolled_back";
}

const COMPOSER_WORKFLOW = ["planner", "context", "code"];

export class ComposerController {
  private lastResult: WorkflowResult | null = null;

  constructor(private readonly deps: ComposerDeps) {}

  /**
   * Generate a structured plan for the user request. The plan is
   * displayed in the composer UI for review before moving to the
   * diff-generation step.
   */
  async generatePlan(userRequest: string): Promise<Plan> {
    const result = await this.deps.orchestrator.executeWorkflow(userRequest, [
      "planner",
    ]);
    this.lastResult = result;

    // The orchestrator stores the Planner's plan in its output field.
    // Normalize the two valid shapes (Plan object or PlanStep[] array)
    // into a Plan object so the UI always sees { steps: [...] }.
    if (result.plan) {
      if (Array.isArray(result.plan)) {
        return { steps: result.plan };
      }
      return result.plan;
    }

    return { steps: [] };
  }

  /**
   * Run the full planner -> context -> code workflow and return the
   * proposed diffs. The returned diffs are NOT yet applied to disk.
   */
  async generateDiffs(userRequest: string): Promise<DiffsResult> {
    const result = await this.deps.orchestrator.executeWorkflow(
      userRequest,
      COMPOSER_WORKFLOW,
    );
    this.lastResult = result;

    return {
      diffs: result.diffs ?? [],
      plan: result.plan,
    };
  }

  /**
   * Apply the subset of diffs the user approved. Optionally wraps the
   * application in a git branch + auto-commit so the whole change can
   * be rolled back as a unit.
   *
   * ATOMIC SEMANTICS: Validates all diffs BEFORE applying any. If validation
   * fails, no files are modified and any created branch is rolled back.
   * On success, all approved diffs are applied together as an atomic transaction.
   */
  async applyDiffs(diffs: Diff[], options: ApplyOptions): Promise<ApplyResult> {
    const approved = new Set(options.approved);
    const rejected = new Set(options.rejected ?? []);
    const workspaceRoot = this.deps.workspaceRoot ?? process.cwd();

    const result: ApplyResult = {
      success: true,
      filesModified: [],
      filesSkipped: [],
      errors: [],
      transactionStatus: undefined,
    };

    // Create branch BEFORE validation so the working tree is clean when
    // the branch is cut. If validation fails, we'll rollback the branch.
    let branchCreated = false;
    if (options.createBranch) {
      try {
        const branchName = await this.deps.gitIntegration.createBranch(
          this.generateBranchName(),
        );
        result.branchName = branchName;
        branchCreated = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to create branch: ${message}`);
        result.success = false;
        result.transactionStatus = "rolled_back";
        return result;
      }
    }

    // PRE-FLIGHT VALIDATION: Validate all approved diffs before applying any.
    // This is the "atomicity" guard: we catch errors upfront, and if any fail,
    // we rollback the branch (if created) and return without modifying any files.
    const validationErrors = await this.validateDiffs(
      diffs,
      approved,
      rejected,
      workspaceRoot,
    );
    if (validationErrors.length > 0) {
      result.success = false;
      result.errors = validationErrors;
      result.transactionStatus = "rolled_back";

      // Rollback the branch if we created one
      if (branchCreated) {
        try {
          await this.deps.gitIntegration.rollback();
        } catch (rollbackErr) {
          const msg =
            rollbackErr instanceof Error
              ? rollbackErr.message
              : String(rollbackErr);
          result.errors.push(`Rollback failed: ${msg}`);
        }
      }

      return result;
    }

    result.transactionStatus = "validated";

    // All validations passed. Now apply all approved diffs together.
    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      if (rejected.has(i) || !approved.has(i)) {
        result.filesSkipped.push(diff.filePath);
        continue;
      }

      const applied = await this.applyDiff(diff, workspaceRoot);
      if (applied.success) {
        result.filesModified.push(diff.filePath);
      } else {
        result.errors.push(
          `${diff.filePath}: ${applied.error ?? "unknown error"}`,
        );
        result.success = false;
        result.transactionStatus = "rolled_back";

        // If apply fails, rollback the branch if we created one
        if (branchCreated) {
          try {
            await this.deps.gitIntegration.rollback();
          } catch (rollbackErr) {
            const msg =
              rollbackErr instanceof Error
                ? rollbackErr.message
                : String(rollbackErr);
            result.errors.push(`Rollback failed: ${msg}`);
          }
        }

        return result;
      }
    }

    // All diffs applied successfully
    result.transactionStatus = "committed";

    if (options.autoCommit && result.filesModified.length > 0) {
      try {
        const sha = await this.deps.gitIntegration.commit(
          options.commitMessage ??
            this.generateCommitMessage(result.filesModified),
        );
        result.commitSha = sha;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`Commit failed: ${message}`);
        result.success = false;
        result.transactionStatus = "rolled_back";

        // If commit fails, rollback the branch
        if (branchCreated) {
          try {
            await this.deps.gitIntegration.rollback();
          } catch (rollbackErr) {
            const msg =
              rollbackErr instanceof Error
                ? rollbackErr.message
                : String(rollbackErr);
            result.errors.push(`Rollback failed: ${msg}`);
          }
        }
      }
    }

    return result;
  }

  /**
   * Roll back the last composer operation via git. Useful when the user
   * applies a batch of diffs, realizes they're wrong, and wants to undo
   * the whole thing at once.
   */
  async rollback(): Promise<void> {
    await this.deps.gitIntegration.rollback();
    this.lastResult = null;
  }

  /** Most recent workflow result; exposed for UI observability. */
  getLastResult(): WorkflowResult | null {
    return this.lastResult;
  }

  /**
   * Pre-flight validation: Check that all approved diffs can be applied
   * before applying any of them. Returns empty array if all validations pass,
   * otherwise returns an array of error messages.
   *
   * This ensures atomic (all-or-nothing) semantics: we validate everything
   * upfront, and only apply if ALL validations pass.
   */
  private async validateDiffs(
    diffs: Diff[],
    approved: Set<number>,
    rejected: Set<number>,
    workspaceRoot: string,
  ): Promise<string[]> {
    const errors: string[] = [];

    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];

      // Skip unapproved and rejected diffs
      if (rejected.has(i) || !approved.has(i)) {
        continue;
      }

      const resolved = resolveInWorkspace(workspaceRoot, diff.filePath);
      if (!resolved) {
        errors.push(`${diff.filePath}: Path outside workspace`);
        continue;
      }

      try {
        const uri = vscode.Uri.file(resolved);

        // Check if file exists and read its content
        let existing: string | null = null;
        try {
          const data = await vscode.workspace.fs.readFile(uri);
          if (data && data.length !== undefined && data.length > 0) {
            existing = new TextDecoder().decode(data);
          }
        } catch {
          // File does not exist — this is OK, we'll create it
        }

        // If file exists, validate that oldContent is present
        if (existing !== null && !existing.includes(diff.oldContent)) {
          errors.push(
            `${diff.filePath}: old_content not found (file exists but pattern doesn't match)`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${diff.filePath}: ${message}`);
      }
    }

    return errors;
  }

  private async applyDiff(
    diff: Diff,
    workspaceRoot: string,
  ): Promise<{ success: boolean; error?: string }> {
    const resolved = resolveInWorkspace(workspaceRoot, diff.filePath);
    if (!resolved) {
      return { success: false, error: "Path outside workspace" };
    }

    try {
      const uri = vscode.Uri.file(resolved);

      // Read existing content. Treat any read failure (file missing, no
      // data returned, throw) as "create a new file with the new
      // content".
      let existing: string | null = null;
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        if (data && data.length !== undefined && data.length > 0) {
          existing = new TextDecoder().decode(data);
        }
      } catch {
        // File does not exist yet — fall through to create.
      }

      if (existing === null) {
        await vscode.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode(diff.newContent),
        );
        return { success: true };
      }

      // Search-and-replace within the existing content.
      if (!existing.includes(diff.oldContent)) {
        return {
          success: false,
          error: `old_content not found in ${diff.filePath}`,
        };
      }
      const updated = existing.replace(diff.oldContent, diff.newContent);
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(updated),
      );
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private generateBranchName(): string {
    const timestamp = Date.now().toString(36);
    return `champ/composer-${timestamp}`;
  }

  private generateCommitMessage(files: string[]): string {
    if (files.length === 1) return `Champ: edit ${files[0]}`;
    return `Champ: edit ${files.length} files`;
  }
}
