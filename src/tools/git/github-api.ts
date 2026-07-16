/**
 * GitHubAPI: Client for GitHub REST API operations.
 *
 * Handles authentication and pull request creation via GitHub API.
 */

export interface CreatePRRequest {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface CreatePRResponse {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

export class GitHubAPI {
  private token: string;
  private baseUrl = "https://api.github.com";

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Validate the GitHub token by making a simple API request.
   */
  async validateToken(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/user`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Create a pull request.
   */
  async createPullRequest(
    request: CreatePRRequest
  ): Promise<CreatePRResponse> {
    try {
      const url = `${this.baseUrl}/repos/${request.owner}/${request.repo}/pulls`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: request.title,
          body: request.body,
          head: request.head,
          base: request.base,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        return {
          success: false,
          error: `GitHub API error: ${error.message || response.statusText}`,
        };
      }

      const pr = await response.json();
      return {
        success: true,
        prUrl: pr.html_url,
        prNumber: pr.number,
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to create pull request: ${errorMsg}`,
      };
    }
  }

  /**
   * Get a specific pull request by number.
   */
  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<GitHubPR> {
    const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get PR: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Check if a branch exists in the repository.
   */
  async branchExists(
    owner: string,
    repo: string,
    branch: string
  ): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/repos/${owner}/${repo}/branches/${branch}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
