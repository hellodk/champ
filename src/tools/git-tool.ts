/**
 * Git-aware tool: autonomous PR creation and git state inspection.
 *
 * Provides tools for:
 * - Reading git branch, commits, and staged changes
 * - Creating pull requests on GitHub with full context
 * - Getting repository status and metadata
 */

import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import { GitUtils } from "./git/git-utils";
import { GitHubAPI } from "./git/github-api";

interface ToolProvider {
  tools: () => Tool[];
}

/**
 * Tool for getting current git status: branch, commits, staged changes.
 */
const gitGetStatusTool: Tool = {
  name: "git_get_status",
  description:
    "Get current git status: branch name, commits since base, staged changes, and remote URL",
  parameters: {
    type: "object",
    properties: {
      base_branch: {
        type: "string",
        description: "Base branch to compare against (default: main)",
      },
    },
    required: [],
  },
  requiresApproval: false,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    try {
      const baseBranch = (args.base_branch as string) || "main";
      const gitUtils = new GitUtils(context.workspaceRoot);

      const branch = await gitUtils.getCurrentBranch();
      const headCommit = await gitUtils.getHeadCommit();
      const stagedChanges = await gitUtils.getStagedChanges();
      const remoteUrl = await gitUtils.getRemoteUrl();

      let commitsSinceBase: string[] = [];
      try {
        commitsSinceBase = await gitUtils.getCommitsSinceBase(baseBranch);
      } catch {
        // Might fail if base branch doesn't exist locally
        commitsSinceBase = [];
      }

      const output = `
Git Status:
- Branch: ${branch}
- HEAD commit: ${headCommit}
- Remote: ${remoteUrl}
- Commits since ${baseBranch}: ${commitsSinceBase.length}
- Staged changes: ${stagedChanges.length > 0 ? "yes" : "no"}

${stagedChanges.length > 0 ? `Staged changes:\n${stagedChanges}` : ""}
`.trim();

      return {
        success: true,
        output,
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `Failed to get git status: ${errorMsg}`,
      };
    }
  },
};

/**
 * Tool for creating a GitHub pull request autonomously.
 */
const gitCreatePrTool: Tool = {
  name: "git_create_pr",
  description:
    "Create a pull request on GitHub with automatic branch detection and context from staged changes",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Pull request title",
      },
      body: {
        type: "string",
        description: "Pull request description/body",
      },
      base: {
        type: "string",
        description: "Base branch (default: main)",
      },
      head: {
        type: "string",
        description:
          "Head branch (default: current branch). Uses auto-detection if not provided",
      },
      token: {
        type: "string",
        description:
          "GitHub API token for authentication (or set via GITHUB_TOKEN env var)",
      },
    },
    required: ["title", "base"],
  },
  requiresApproval: true,

  getPreview(
    args: Record<string, unknown>
  ): import("./types").ToolPreview | undefined {
    const title = args.title as string;
    const base = args.base as string;
    const preview = `Creating PR:
Title: ${title}
Base: ${base}

This will create a pull request using your GitHub token.`;
    return {
      type: "command",
      content: preview,
      label: "Create Pull Request",
    };
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    // Validate required parameters
    const title = args.title as string;
    const base = (args.base as string) || "main";
    let head = args.head as string | undefined;
    const token =
      (args.token as string) ||
      process.env.GITHUB_TOKEN;

    if (!title) {
      return {
        success: false,
        output: "title is required",
      };
    }

    if (!base) {
      return {
        success: false,
        output: "base is required",
      };
    }

    if (!token) {
      return {
        success: false,
        output:
          "GitHub token required: pass as 'token' parameter or set GITHUB_TOKEN env var",
      };
    }

    try {
      const gitUtils = new GitUtils(context.workspaceRoot);
      const githubApi = new GitHubAPI(token);

      // Validate token
      const tokenValid = await githubApi.validateToken();
      if (!tokenValid) {
        return {
          success: false,
          output: "Invalid GitHub token",
        };
      }

      // Auto-detect head branch if not provided
      if (!head) {
        head = await gitUtils.getCurrentBranch();
      }

      // Get repository info from remote URL
      const remoteUrl = await gitUtils.getRemoteUrl();
      const repoInfo = gitUtils.parseGitHubUrl(remoteUrl);

      // Build PR description with context
      let body = args.body as string;
      if (!body) {
        body = "PR created by Champ AI coding agent";
      }

      // Try to include staged changes in the PR description
      try {
        const stagedChanges = await gitUtils.getStagedChanges();
        if (stagedChanges) {
          body += `\n\n## Changes\n\`\`\`diff\n${stagedChanges.slice(0, 2000)}\n\`\`\``;
        }
      } catch {
        // If we can't get staged changes, continue without them
      }

      // Create the pull request
      const result = await githubApi.createPullRequest({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        title,
        body,
        head,
        base,
      });

      if (!result.success) {
        return {
          success: false,
          output: `Failed to create pull request: ${result.error}`,
        };
      }

      return {
        success: true,
        output: `Pull request created successfully!
Branch: ${head} → ${base}
Title: ${title}
URL: ${result.prUrl}
PR #${result.prNumber}`,
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `Failed to create pull request: ${errorMsg}`,
      };
    }
  },
};

/**
 * Export the tool provider.
 */
export const gitToolProvider: ToolProvider = {
  tools: () => [gitGetStatusTool, gitCreatePrTool],
};
