/**
 * GitUtils: Utilities for reading git state.
 *
 * Provides methods to read current branch, commits, staged changes, and
 * remote configuration from a local git repository.
 */
import { spawn } from "child_process";

export interface GitHubUrlParts {
  owner: string;
  repo: string;
}

export class GitUtils {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Execute a git command and return the output.
   */
  private async executeGitCommand(
    args: string[]
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      const proc = spawn("git", args, {
        cwd: this.workspaceRoot,
      });

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code: number) => {
        if (code !== 0) {
          reject(
            new Error(`Git command failed: ${stderr || stdout}`)
          );
        } else {
          resolve(stdout.trim());
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * Get the current git branch name.
   */
  async getCurrentBranch(): Promise<string> {
    try {
      const output = await this.executeGitCommand([
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      return output;
    } catch (error) {
      throw new Error(`Failed to get current branch: ${error}`);
    }
  }

  /**
   * Get the HEAD commit hash.
   */
  async getHeadCommit(): Promise<string> {
    try {
      const output = await this.executeGitCommand([
        "rev-parse",
        "HEAD",
      ]);
      return output;
    } catch (error) {
      throw new Error(`Failed to get HEAD commit: ${error}`);
    }
  }

  /**
   * Get commits since a base branch.
   */
  async getCommitsSinceBase(baseBranch: string): Promise<string[]> {
    try {
      const output = await this.executeGitCommand([
        "log",
        `${baseBranch}..HEAD`,
        "--oneline",
      ]);
      return output.split("\n").filter((line) => line.length > 0);
    } catch (error) {
      throw new Error(
        `Failed to get commits since base: ${error}`
      );
    }
  }

  /**
   * Get staged changes as a unified diff.
   */
  async getStagedChanges(): Promise<string> {
    try {
      const output = await this.executeGitCommand([
        "diff",
        "--cached",
        "--unified=3",
      ]);
      return output;
    } catch (error) {
      throw new Error(`Failed to get staged changes: ${error}`);
    }
  }

  /**
   * Get the remote origin URL.
   */
  async getRemoteUrl(): Promise<string> {
    try {
      const output = await this.executeGitCommand([
        "config",
        "--get",
        "remote.origin.url",
      ]);
      return output;
    } catch (error) {
      throw new Error(`Failed to get remote URL: ${error}`);
    }
  }

  /**
   * Parse a GitHub repository URL and extract owner and repo.
   */
  parseGitHubUrl(url: string): GitHubUrlParts {
    // Handle SSH URLs: git@github.com:owner/repo.git
    const sshMatch = url.match(
      /git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/
    );
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    // Handle HTTPS URLs: https://github.com/owner/repo.git
    const httpsMatch = url.match(
      /https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/
    );
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    throw new Error(`Invalid GitHub URL: ${url}`);
  }

  /**
   * Get the current working directory of this repo.
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }
}
