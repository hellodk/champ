/**
 * GitUtils: Low-level git operations.
 *
 * SECURITY (issue #103): every invocation passes arguments as individual
 * argv entries via execFileSync("git", [...]). No command string is ever
 * composed, so LLM-controlled branch names, file paths and commit messages
 * cannot break out through a shell (quotes, backticks, $() are inert).
 */
import { execFileSync } from "child_process";

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

interface RunOptions {
  maxBuffer?: number;
}

/** Run git with plain argv. Throws on non-zero exit like execSync did. */
function run(cwd: string, args: string[], opts: RunOptions = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
  }) as string;
}

export class GitUtils {
  /**
   * Get the current git branch name.
   * @param workspaceRoot The git repository root
   * @returns The branch name (e.g., "feat/git-tool")
   */
  static async getCurrentBranch(workspaceRoot: string): Promise<string> {
    try {
      return run(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
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
      const result = run(workspaceRoot, [
        "diff",
        "--cached",
        "--name-only",
      ]).trim();
      return result ? result.split("\n").filter((f) => f) : [];
    } catch {
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
      const result = run(workspaceRoot, ["diff", "--name-only"]).trim();
      return result ? result.split("\n").filter((f) => f) : [];
    } catch {
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
      return run(workspaceRoot, ["diff", "--cached"], {
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
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
      return run(workspaceRoot, ["diff"], {
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
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
      const result = run(workspaceRoot, [
        "log",
        `${baseBranch}..HEAD`,
        "--pretty=format:%H%n%s%n%an%n%ai%n---END---",
      ]).trim();

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
    } catch {
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
      run(workspaceRoot, ["add", ...files]);
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
      run(workspaceRoot, ["commit", "-m", message]);
      return run(workspaceRoot, ["rev-parse", "HEAD"]).trim();
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
      const url = run(workspaceRoot, [
        "config",
        "--get",
        "remote.origin.url",
      ]).trim();

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
    } catch {
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
      run(workspaceRoot, ["rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }
}
