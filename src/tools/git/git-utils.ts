/**
 * GitUtils: Low-level git operations using shell commands.
 *
 * Provides a structured API for reading repository state:
 * - Current branch, commits, staged/unstaged changes
 * - Diffs for staged and unstaged changes
 * - Remote configuration (owner/repo for PR creation)
 */
import { execSync } from "child_process";

export interface Commit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface RemoteConfig {
  url: string;
  owner: string;
  repo: string;
}

export class GitUtils {
  /**
   * Get the current git branch name.
   * @param workspaceRoot The git repository root
   * @returns The branch name (e.g., "feat/git-tool")
   */
  static async getCurrentBranch(workspaceRoot: string): Promise<string> {
    try {
      const result = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: workspaceRoot,
        encoding: "utf-8",
      }).trim();
      return result;
    } catch (error) {
      throw new Error(
        `Failed to get current branch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get list of staged files ready to commit.
   * @param workspaceRoot The git repository root
   * @returns Array of file paths that are staged
   */
  static async getStagedChanges(workspaceRoot: string): Promise<string[]> {
    try {
      const result = execSync("git diff --cached --name-only", {
        cwd: workspaceRoot,
        encoding: "utf-8",
      }).trim();
      return result ? result.split("\n").filter((f) => f) : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get list of unstaged files.
   * @param workspaceRoot The git repository root
   * @returns Array of file paths that have unstaged changes
   */
  static async getUnstagedChanges(workspaceRoot: string): Promise<string[]> {
    try {
      const result = execSync("git diff --name-only", {
        cwd: workspaceRoot,
        encoding: "utf-8",
      }).trim();
      return result ? result.split("\n").filter((f) => f) : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get diff of staged changes (ready to be committed).
   * @param workspaceRoot The git repository root
   * @returns The diff content
   */
  static async getStagedDiff(workspaceRoot: string): Promise<string> {
    try {
      return execSync("git diff --cached", {
        cwd: workspaceRoot,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      return "";
    }
  }

  /**
   * Get diff of unstaged changes.
   * @param workspaceRoot The git repository root
   * @returns The diff content
   */
  static async getUnstagedDiff(workspaceRoot: string): Promise<string> {
    try {
      return execSync("git diff", {
        cwd: workspaceRoot,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      return "";
    }
  }

  /**
   * Get commits since a given base branch.
   * @param workspaceRoot The git repository root
   * @param baseBranch The base branch to compare against (e.g., "main")
   * @returns Array of commits with hash, message, author, and date
   */
  static async getCommitsSinceBranch(
    workspaceRoot: string,
    baseBranch: string,
  ): Promise<Commit[]> {
    try {
      const result = execSync(
        `git log ${baseBranch}..HEAD --pretty=format:%H%n%s%n%an%n%ai%n---END---`,
        {
          cwd: workspaceRoot,
          encoding: "utf-8",
        },
      ).trim();

      if (!result) {
        return [];
      }

      const commits: Commit[] = [];
      const blocks = result.split("---END---").filter((b) => b.trim());

      for (const block of blocks) {
        const lines = block.trim().split("\n");
        if (lines.length >= 4) {
          commits.push({
            hash: lines[0],
            message: lines[1],
            author: lines[2],
            date: lines[3],
          });
        }
      }

      return commits;
    } catch (error) {
      return [];
    }
  }

  /**
   * Stage specific files for commit.
   * @param workspaceRoot The git repository root
   * @param files Array of file paths to stage
   * @returns True if successful
   */
  static async stageFiles(
    workspaceRoot: string,
    files: string[],
  ): Promise<boolean> {
    try {
      if (files.length === 0) {
        return false;
      }
      execSync(`git add ${files.map((f) => `"${f}"`).join(" ")}`, {
        cwd: workspaceRoot,
      });
      return true;
    } catch (error) {
      throw new Error(
        `Failed to stage files: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Create a commit with the given message.
   * @param workspaceRoot The git repository root
   * @param message The commit message
   * @returns The commit hash
   */
  static async createCommit(
    workspaceRoot: string,
    message: string,
  ): Promise<string> {
    try {
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: workspaceRoot,
      });
      // Get the new commit hash
      const hash = execSync("git rev-parse HEAD", {
        cwd: workspaceRoot,
        encoding: "utf-8",
      }).trim();
      return hash;
    } catch (error) {
      throw new Error(
        `Failed to create commit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get remote URL and parse owner/repo from it.
   * @param workspaceRoot The git repository root
   * @returns Remote configuration including URL, owner, and repo
   */
  static async getRemoteConfig(
    workspaceRoot: string,
  ): Promise<RemoteConfig | null> {
    try {
      const url = execSync("git config --get remote.origin.url", {
        cwd: workspaceRoot,
        encoding: "utf-8",
      }).trim();

      if (!url) {
        return null;
      }

      // Parse URL - handle both HTTPS and SSH formats
      // HTTPS: https://github.com/owner/repo.git
      // SSH: git@github.com:owner/repo.git
      let owner = "";
      let repo = "";

      if (url.includes("github.com")) {
        const match = url.match(
          /(?:https:\/\/|git@)github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/,
        );
        if (match) {
          [, owner, repo] = match;
          repo = repo.replace(/\.git$/, "");
        }
      }

      return { url, owner, repo };
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if a working directory is a valid git repository.
   * @param workspaceRoot The directory to check
   * @returns True if it's a git repository
   */
  static async isGitRepository(workspaceRoot: string): Promise<boolean> {
    try {
      execSync("git rev-parse --git-dir", {
        cwd: workspaceRoot,
        stdio: "pipe",
      });
      return true;
    } catch (error) {
      return false;
    }
  }
}
