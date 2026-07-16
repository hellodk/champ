import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubAPI } from "../../../src/tools/git/github-api";

// Mock fetch globally
global.fetch = vi.fn();

describe("GitHubAPI", () => {
  let githubAPI: GitHubAPI;
  const mockToken = "ghp_test123";
  const mockOwner = "hellodk";
  const mockRepo = "champ";

  beforeEach(() => {
    githubAPI = new GitHubAPI(mockToken);
    vi.clearAllMocks();
  });

  describe("createPullRequest", () => {
    it("creates a pull request successfully", async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 1,
          number: 42,
          html_url: "https://github.com/hellodk/champ/pull/42",
          title: "Test PR",
          state: "open",
        }),
      });

      const result = await githubAPI.createPullRequest({
        owner: mockOwner,
        repo: mockRepo,
        title: "Test PR",
        body: "Test description",
        head: "feat/test",
        base: "main",
      });

      expect(result.success).toBe(true);
      expect(result.prUrl).toContain("pull/42");
      expect(result.prNumber).toBe(42);
    });

    it("returns error when API call fails", async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ message: "Bad credentials" }),
      });

      const result = await githubAPI.createPullRequest({
        owner: mockOwner,
        repo: mockRepo,
        title: "Test PR",
        body: "Test description",
        head: "feat/test",
        base: "main",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("includes token in authorization header", async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 1,
          number: 42,
          html_url: "https://github.com/hellodk/champ/pull/42",
        }),
      });

      await githubAPI.createPullRequest({
        owner: mockOwner,
        repo: mockRepo,
        title: "Test PR",
        body: "Test description",
        head: "feat/test",
        base: "main",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockToken}`,
          }),
        })
      );
    });
  });

  describe("validateToken", () => {
    it("returns true for valid token", async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: "hellodk" }),
      });

      const isValid = await githubAPI.validateToken();
      expect(isValid).toBe(true);
    });

    it("returns false for invalid token", async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const isValid = await githubAPI.validateToken();
      expect(isValid).toBe(false);
    });
  });

  describe("getPullRequest", () => {
    it("retrieves a pull request by number", async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 42,
          title: "Test PR",
          state: "open",
          html_url: "https://github.com/hellodk/champ/pull/42",
        }),
      });

      const pr = await githubAPI.getPullRequest(
        mockOwner,
        mockRepo,
        42
      );

      expect(pr.number).toBe(42);
      expect(pr.title).toBe("Test PR");
      expect(pr.state).toBe("open");
    });
  });
});
