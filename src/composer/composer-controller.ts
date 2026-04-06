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
import type { AgentOrchestrator, WorkflowResult } from "../agent/orchestrator";
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
    };

    // Create branch BEFORE applying so the working tree is clean when
    // the branch is cut. Any apply failures will be on the new branch.
    if (options.createBranch) {
      try {
        const branchName = await this.deps.gitIntegration.createBranch(
          this.generateBranchName(),
        );
        result.branchName = branchName;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to create branch: ${message}`);
        result.success = false;
        return result;
      }
    }

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
      }
    }

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
    return `aidev/composer-${timestamp}`;
  }

  private generateCommitMessage(files: string[]): string {
    if (files.length === 1) return `AIDev: edit ${files[0]}`;
    return `AIDev: edit ${files.length} files`;
  }
}
