/**
 * git-tool: Structured git operations and autonomous PR creation.
 *
 * Provides LLM-callable actions for:
 * - Reading git repository state (branch, staged/unstaged changes, commits)
 * - Generating diffs for review
 * - Creating commits autonomously (with user approval)
 * - Creating pull requests with auto-detected context
 *
 * All destructive operations (commit, PR) require explicit user approval.
 */
import type {
  Tool,
  ToolResult,
  ToolExecutionContext,
  ToolPreview,
} from "./types";
import { GitUtils } from "./git/git-utils";
import { GitHubAPI } from "./git/github-api";

export const gitTool: Tool = {
  name: "git",
  description:
    "Structured Git operations: query repository state, generate diffs, create commits and pull requests autonomously.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          "The git action to perform: git_status, git_diff, git_commit, git_create_pr",
        enum: ["git_status", "git_diff", "git_commit", "git_create_pr"],
      },
      type: {
        type: "string",
        description: "For git_diff: 'staged' or 'unstaged'",
        enum: ["staged", "unstaged"],
      },
      message: {
        type: "string",
        description:
          "For git_commit: the commit message (conventional format preferred)",
      },
      files: {
        type: "array",
        description: "For git_commit: array of file paths to stage and commit",
        items: { type: "string" },
      },
      title: {
        type: "string",
        description: "For git_create_pr: the PR title",
      },
      description: {
        type: "string",
        description: "For git_create_pr: the PR body/description",
      },
      base: {
        type: "string",
        description: 'For git_create_pr: the base branch (e.g., "main")',
      },
      head: {
        type: "string",
        description:
          'For git_create_pr: the head branch (e.g., "feat/git-tool")',
      },
      githubToken: {
        type: "string",
        description:
          "Optional GitHub personal access token for PR creation. If not provided, looks for GITHUB_TOKEN env var.",
      },
    },
    required: ["action"],
  },
  requiresApproval: true,

  getPreview(args: Record<string, unknown>): ToolPreview | undefined {
    const action = args.action as string;

    switch (action) {
      case "git_commit": {
        const message = args.message as string;
        const files = args.files as string[];
        return {
          type: "command",
          content: `git add ${files.join(" ")}\ngit commit -m "${message}"`,
          label: "Staged files and commit message",
        };
      }
      case "git_create_pr": {
        const title = args.title as string;
        const description = args.description as string;
        return {
          type: "command",
          content: `Create Pull Request:\nTitle: ${title}\n\nDescription:\n${description}`,
          label: "PR details",
        };
      }
      default:
        return undefined;
    }
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const action = args.action as string;

    // Validate git repository
    const isGitRepo = await GitUtils.isGitRepository(context.workspaceRoot);
    if (!isGitRepo) {
      return {
        success: false,
        output: "Error: workspace is not a git repository",
      };
    }

    switch (action) {
      case "git_status":
        return await handleGitStatus(context);
      case "git_diff":
        return await handleGitDiff(args, context);
      case "git_commit":
        return await handleGitCommit(args, context);
      case "git_create_pr":
        return await handleGitCreatePR(args, context);
      default:
        return {
          success: false,
          output: `Error: unknown git action "${action}"`,
        };
    }
  },
};

/**
 * Handle git_status action: return current branch and repository state.
 */
async function handleGitStatus(
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const branch = await GitUtils.getCurrentBranch(context.workspaceRoot);
    const staged = await GitUtils.getStagedChanges(context.workspaceRoot);
    const unstaged = await GitUtils.getUnstagedChanges(context.workspaceRoot);
    const commits = await GitUtils.getCommitsSinceBranch(
      context.workspaceRoot,
      "main",
    );

    let output = `Current branch: ${branch}\n\n`;
    output += `Staged changes: ${staged.length} file(s)\n`;
    if (staged.length > 0) {
      output += staged.map((f) => `  - ${f}`).join("\n") + "\n";
    }
    output += `\nUnstaged changes: ${unstaged.length} file(s)\n`;
    if (unstaged.length > 0) {
      output += unstaged.map((f) => `  - ${f}`).join("\n") + "\n";
    }
    output += `\nCommits since main: ${commits.length}\n`;
    if (commits.length > 0) {
      output += commits
        .slice(0, 5)
        .map((c) => `  - ${c.hash.substring(0, 7)}: ${c.message}`)
        .join("\n");
      if (commits.length > 5) {
        output += `\n  ... and ${commits.length - 5} more`;
      }
    }

    return {
      success: true,
      output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: `Error reading git status: ${message}`,
    };
  }
}

/**
 * Handle git_diff action: return staged or unstaged diff.
 */
async function handleGitDiff(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const diffType = (args.type as string) || "staged";
    const isStaged = diffType === "staged";

    const diff = isStaged
      ? await GitUtils.getStagedDiff(context.workspaceRoot)
      : await GitUtils.getUnstagedDiff(context.workspaceRoot);

    if (!diff || diff.trim() === "") {
      return {
        success: true,
        output: `No ${diffType} changes to display.`,
      };
    }

    // Truncate very large diffs to avoid context bloat
    const maxChars = 5000;
    if (diff.length > maxChars) {
      return {
        success: true,
        output:
          diff.substring(0, maxChars) +
          `\n\n[truncated - ${diff.length} total characters]`,
      };
    }

    return {
      success: true,
      output: diff,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: `Error generating diff: ${message}`,
    };
  }
}

/**
 * Handle git_commit action: stage files and create a commit (requires approval).
 */
async function handleGitCommit(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const message = args.message as string;
    const files = (args.files as string[]) || [];

    if (!message) {
      return {
        success: false,
        output: "Error: commit message is required",
      };
    }

    if (files.length === 0) {
      return {
        success: false,
        output: "Error: at least one file is required for commit",
      };
    }

    // Request approval before making changes
    const approved = await context.requestApproval(
      `Create commit with message: "${message}"`,
      {
        type: "command",
        content: `git add ${files.join(" ")}\ngit commit -m "${message}"`,
        label: "Files to commit",
      },
    );

    if (!approved) {
      return {
        success: false,
        output: "Commit creation denied by user",
      };
    }

    // Stage the files
    await GitUtils.stageFiles(context.workspaceRoot, files);
    context.reportProgress(`Staged ${files.length} file(s)`);

    // Create the commit
    const hash = await GitUtils.createCommit(context.workspaceRoot, message);
    context.reportProgress(`Commit created: ${hash.substring(0, 7)}`);

    return {
      success: true,
      output: `Successfully created commit ${hash.substring(0, 7)}\nMessage: ${message}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: `Error creating commit: ${message}`,
    };
  }
}

/**
 * Handle git_create_pr action: create a pull request on GitHub (requires approval).
 */
async function handleGitCreatePR(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const title = args.title as string;
    const description = args.description as string;
    const base = (args.base as string) || "main";
    const head = args.head as string;

    // Validate required parameters
    if (!title || !description || !head) {
      return {
        success: false,
        output:
          "Error: title, description, and head branch are required parameters",
      };
    }

    // Get remote config
    const remote = await GitUtils.getRemoteConfig(context.workspaceRoot);
    if (!remote || !remote.owner || !remote.repo) {
      return {
        success: false,
        output: "Error: Could not determine GitHub owner/repo from git remote",
      };
    }

    // Get GitHub token
    const token =
      (args.githubToken as string) || process.env.GITHUB_TOKEN || "";
    if (!token) {
      return {
        success: false,
        output:
          "Error: GITHUB_TOKEN not provided and GITHUB_TOKEN env var not set",
      };
    }

    // Request approval before creating PR
    const approved = await context.requestApproval(
      `Create pull request on ${remote.owner}/${remote.repo}`,
      {
        type: "command",
        content: `Create Pull Request:\nTitle: ${title}\nBase: ${base}\nHead: ${head}\n\nDescription:\n${description}`,
        label: "PR details",
      },
    );

    if (!approved) {
      return {
        success: false,
        output: "Pull request creation denied by user",
      };
    }

    // Create GitHub API client
    const api = new GitHubAPI(token, remote.owner, remote.repo);

    // Validate token
    const isValid = await api.validateToken();
    if (!isValid) {
      return {
        success: false,
        output: "Error: GitHub token is invalid or does not have access",
      };
    }

    context.reportProgress("Creating pull request...");

    // Create the PR
    const pr = await api.createPR(title, description, base, head);
    if (!pr) {
      return {
        success: false,
        output: "Error: Failed to create pull request",
      };
    }

    context.reportProgress(`PR created: ${pr.url}`);

    return {
      success: true,
      output: `Successfully created pull request #${pr.number}\nURL: ${pr.url}\nTitle: ${pr.title}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: `Error creating pull request: ${message}`,
    };
  }
}
