/**
 * GitHubAPI: GitHub REST API client for PR operations.
 *
 * Handles authentication, PR creation, and retrieval via GitHub REST API.
 * Uses personal access tokens (ghp_*) for authentication.
 */

export interface PRResponse {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  head: { ref: string };
  base: { ref: string };
}

export class GitHubAPI {
  private token: string;
  private owner: string;
  private repo: string;
  private baseUrl = "https://api.github.com";

  /**
   * Initialize GitHub API client.
   * @param token GitHub personal access token (ghp_...)
   * @param owner Repository owner (username or org)
   * @param repo Repository name
   */
  constructor(token: string, owner: string, repo: string) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  /**
   * Validate that the token has access to the repository.
   * @returns True if token is valid
   */
  async validateToken(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/user`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the authenticated user's login name.
   * @returns The GitHub username
   */
  async getAuthUser(): Promise<string | null> {
    try {
      const response = await fetch(`${this.baseUrl}/user`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as { login: string };
      return data.login;
    } catch (error) {
      return null;
    }
  }

  /**
   * Create a pull request.
   * @param title PR title
   * @param description PR description/body
   * @param base Base branch (e.g., "main")
   * @param head Head branch (e.g., "feat/git-tool")
   * @returns PR response with number and URL
   */
  async createPR(
    title: string,
    description: string,
    base: string,
    head: string,
  ): Promise<PRResponse | null> {
    try {
      const body = {
        title,
        body: description,
        base,
        head,
      };

      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `GitHub API error: ${response.status} - ${JSON.stringify(errorData)}`,
        );
      }

      const data = (await response.json()) as PRResponse;
      return data;
    } catch (error) {
      throw new Error(
        `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get an existing pull request by number.
   * @param prNumber PR number
   * @returns PR response or null if not found
   */
  async getPR(prNumber: number): Promise<PRResponse | null> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${prNumber}`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github.v3+json",
          },
        },
      );

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const data = (await response.json()) as PRResponse;
      return data;
    } catch (error) {
      throw new Error(
        `Failed to fetch PR: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * List pull requests for this repository.
   * @param state Filter by state ("open", "closed", or "all")
   * @returns Array of PR responses
   */
  async listPRs(
    state: "open" | "closed" | "all" = "open",
  ): Promise<PRResponse[]> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls?state=${state}`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github.v3+json",
          },
        },
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const data = (await response.json()) as PRResponse[];
      return data;
    } catch (error) {
      throw new Error(
        `Failed to list PRs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
