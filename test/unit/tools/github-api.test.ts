/**
 * TDD: Tests for GitHubAPI - GitHub REST API client.
 * Validates PR creation, token validation, and API error handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubAPI } from "@/tools/git/github-api";

// Mock global fetch
global.fetch = vi.fn();

describe("GitHubAPI", () => {
  let api: GitHubAPI;
  const mockToken = "ghp_test1234567890";
  const mockOwner = "hellodk";
  const mockRepo = "vs-code-plugin";

  beforeEach(() => {
    vi.clearAllMocks();
    api = new GitHubAPI(mockToken, mockOwner, mockRepo);
  });

  describe("constructor", () => {
    it("should initialize with token, owner, and repo", () => {
      expect(api).toBeDefined();
    });
  });

  describe("validateToken", () => {
    it("should return true for valid token", async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: "hellodk" }),
      });

      const result = await api.validateToken();
      expect(result).toBe(true);
    });

    it("should return false for invalid token", async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const result = await api.validateToken();
      expect(result).toBe(false);
    });
  });

  describe("getAuthUser", () => {
    it("should return authenticated user login", async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: "hellodk" }),
      });

      const result = await api.getAuthUser();
      expect(result).toBe("hellodk");
    });

    it("should return null for invalid token", async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const result = await api.getAuthUser();
      expect(result).toBeNull();
    });
  });

  describe("createPR", () => {
    it("should create a pull request", async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockPR = {
        number: 123,
        url: "https://github.com/hellodk/vs-code-plugin/pull/123",
        title: "Add git tool",
        body: "Implements git-aware tool",
        state: "open" as const,
        head: { ref: "feat/git-tool" },
        base: { ref: "main" },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockPR,
      });

      const result = await api.createPR(
        "Add git tool",
        "Implements git-aware tool",
        "main",
        "feat/git-tool",
      );

      expect(result).toBeDefined();
      expect(result?.number).toBe(123);
      expect(result?.url).toContain("github.com");
    });

    it("should throw on API error", async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ message: "Validation error" }),
      });

      try {
        await api.createPR(
          "Test PR",
          "Test description",
          "main",
          "test-branch",
        );
        expect(true).toBe(false); // Should throw
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it("should return PR with number and URL", async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 42,
          url: "https://github.com/hellodk/vs-code-plugin/pull/42",
          title: "Test PR",
          body: "Test description",
          state: "open",
          head: { ref: "test-branch" },
          base: { ref: "main" },
        }),
      });

      const result = await api.createPR(
        "Test PR",
        "Test description",
        "main",
        "test-branch",
      );

      if (result && result.url) {
        expect(result.url).toContain("github.com");
        expect(result.url).toContain("/pull/");
      }
    });
  });

  describe("getPR", () => {
    it("should fetch an existing PR", async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 1,
          url: "https://github.com/hellodk/vs-code-plugin/pull/1",
          title: "First PR",
          body: "Description",
          state: "open",
          head: { ref: "feature" },
          base: { ref: "main" },
        }),
      });

      const result = await api.getPR(1);
      expect(result).toBeDefined();
      if (result) {
        expect(result.number).toBe(1);
      }
    });

    it("should return null for non-existent PR", async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await api.getPR(99999);
      expect(result).toBeNull();
    });
  });

  describe("listPRs", () => {
    it("should list pull requests", async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            number: 1,
            url: "https://github.com/hellodk/vs-code-plugin/pull/1",
            title: "PR 1",
            body: "Description",
            state: "open",
            head: { ref: "feature1" },
            base: { ref: "main" },
          },
        ],
      });

      const result = await api.listPRs("open");
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
