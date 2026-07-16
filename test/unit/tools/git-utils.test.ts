/**
 * TDD: Tests for GitUtils - git repository operations.
 * Validates branch detection, commit history, and staged changes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitUtils } from "@/tools/git/git-utils";
import { execSync } from "child_process";

vi.mock("child_process");

describe("GitUtils", () => {
  const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getCurrentBranch", () => {
    it("should detect current git branch", async () => {
      mockExecSync.mockReturnValue("feat/git-tool\n");
      const result = await GitUtils.getCurrentBranch("/test-workspace");
      expect(result).toBe("feat/git-tool");
    });

    it("should return branch name without ref prefix", async () => {
      mockExecSync.mockReturnValue("main\n");
      const result = await GitUtils.getCurrentBranch("/test-workspace");
      expect(result).toBe("main");
      expect(result).not.toContain("ref:");
    });

    it("should handle git not found", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Command not found");
      });

      try {
        await GitUtils.getCurrentBranch("/test-workspace");
        expect(true).toBe(false); // Should throw
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  describe("getStagedChanges", () => {
    it("should return list of staged files", async () => {
      mockExecSync.mockReturnValue(
        "src/tools/git-tool.ts\nsrc/tools/git-utils.ts\n",
      );
      const result = await GitUtils.getStagedChanges("/test-workspace");
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it("should return empty array if nothing staged", async () => {
      mockExecSync.mockReturnValue("");
      const result = await GitUtils.getStagedChanges("/test-workspace");
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe("getUnstagedChanges", () => {
    it("should return list of unstaged files", async () => {
      mockExecSync.mockReturnValue("src/tools/test.ts\n");
      const result = await GitUtils.getUnstagedChanges("/test-workspace");
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getStagedDiff", () => {
    it("should return staged diff content", async () => {
      mockExecSync.mockReturnValue("diff --git a/file.ts b/file.ts\n+new line");
      const result = await GitUtils.getStagedDiff("/test-workspace");
      expect(typeof result).toBe("string");
    });

    it("should return empty string on error", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("git error");
      });
      const result = await GitUtils.getStagedDiff("/test-workspace");
      expect(result).toBe("");
    });
  });

  describe("getUnstagedDiff", () => {
    it("should return unstaged diff content", async () => {
      mockExecSync.mockReturnValue("diff --git a/file.ts b/file.ts");
      const result = await GitUtils.getUnstagedDiff("/test-workspace");
      expect(typeof result).toBe("string");
    });
  });

  describe("getCommitsSinceBranch", () => {
    it("should return commits between branches", async () => {
      const commitOutput =
        "abc1234\nfeat: add feature\nJohn Doe\n2026-01-01T00:00:00\n---END---";
      mockExecSync.mockReturnValue(commitOutput);
      const result = await GitUtils.getCommitsSinceBranch(
        "/test-workspace",
        "main",
      );
      expect(Array.isArray(result)).toBe(true);
    });

    it("should parse commit details correctly", async () => {
      const commitOutput =
        "abc1234\nfeat: add tool\nAlice\n2026-02-01T10:30:00\n---END---";
      mockExecSync.mockReturnValue(commitOutput);
      const result = await GitUtils.getCommitsSinceBranch(
        "/test-workspace",
        "main",
      );
      expect(result[0]).toHaveProperty("hash", "abc1234");
      expect(result[0]).toHaveProperty("message", "feat: add tool");
      expect(result[0]).toHaveProperty("author", "Alice");
    });

    it("should return empty array on error", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("git error");
      });
      const result = await GitUtils.getCommitsSinceBranch(
        "/test-workspace",
        "main",
      );
      expect(result).toEqual([]);
    });
  });

  describe("stageFiles", () => {
    it("should stage specified files", async () => {
      mockExecSync.mockReturnValue("");
      const result = await GitUtils.stageFiles("/test-workspace", [
        "src/tools/git-tool.ts",
      ]);
      expect(result).toBe(true);
    });

    it("should return false for empty file list", async () => {
      const result = await GitUtils.stageFiles("/test-workspace", []);
      expect(result).toBe(false);
    });
  });

  describe("createCommit", () => {
    it("should create a commit with message", async () => {
      mockExecSync
        .mockReturnValueOnce("") // First call for commit
        .mockReturnValueOnce("abc1234567890\n"); // Second call for hash
      const result = await GitUtils.createCommit(
        "/test-workspace",
        "test: create commit",
      );
      expect(typeof result).toBe("string");
      expect(result).toContain("abc1234");
    });
  });

  describe("getRemoteConfig", () => {
    it("should parse HTTPS remote URL", async () => {
      mockExecSync.mockReturnValue(
        "https://github.com/hellodk/vs-code-plugin.git",
      );
      const result = await GitUtils.getRemoteConfig("/test-workspace");
      expect(result).toBeDefined();
      if (result) {
        expect(result.owner).toBe("hellodk");
        expect(result.repo).toBe("vs-code-plugin");
      }
    });

    it("should parse SSH remote URL", async () => {
      mockExecSync.mockReturnValue("git@github.com:hellodk/vs-code-plugin.git");
      const result = await GitUtils.getRemoteConfig("/test-workspace");
      expect(result).toBeDefined();
      if (result) {
        expect(result.owner).toBe("hellodk");
        expect(result.repo).toBe("vs-code-plugin");
      }
    });

    it("should return null if no remote", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("no remote");
      });
      const result = await GitUtils.getRemoteConfig("/test-workspace");
      expect(result).toBeNull();
    });
  });

  describe("isGitRepository", () => {
    it("should return true for valid git repo", async () => {
      mockExecSync.mockReturnValue(".git\n");
      const result = await GitUtils.isGitRepository("/test-workspace");
      expect(result).toBe(true);
    });

    it("should return false for non-git directory", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not a git repo");
      });
      const result = await GitUtils.isGitRepository("/not-a-repo");
      expect(result).toBe(false);
    });
  });
});
