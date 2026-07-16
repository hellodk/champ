/**
 * TDD: Tests for git-tool and git operations.
 * Validates git status queries, diff generation, and PR creation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { gitTool } from "@/tools/git-tool";
import type { ToolExecutionContext } from "@/tools/types";
import * as GitUtilsModule from "@/tools/git/git-utils";

// Mock GitUtils
vi.mock("@/tools/git/git-utils");

describe("git-tool", () => {
  let context: ToolExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      workspaceRoot: "/test-workspace",
      abortSignal: new AbortController().signal,
      reportProgress: vi.fn(),
      requestApproval: vi.fn(),
    };

    // Mock GitUtils methods
    const GitUtils = GitUtilsModule.GitUtils as unknown as {
      isGitRepository: ReturnType<typeof vi.fn>;
      getCurrentBranch: ReturnType<typeof vi.fn>;
      getStagedChanges: ReturnType<typeof vi.fn>;
      getUnstagedChanges: ReturnType<typeof vi.fn>;
      getStagedDiff: ReturnType<typeof vi.fn>;
      getUnstagedDiff: ReturnType<typeof vi.fn>;
      getCommitsSinceBranch: ReturnType<typeof vi.fn>;
      stageFiles: ReturnType<typeof vi.fn>;
      createCommit: ReturnType<typeof vi.fn>;
      getRemoteConfig: ReturnType<typeof vi.fn>;
    };

    GitUtils.isGitRepository = vi.fn().mockResolvedValue(true);
    GitUtils.getCurrentBranch = vi.fn().mockResolvedValue("feat/git-tool");
    GitUtils.getStagedChanges = vi.fn().mockResolvedValue([]);
    GitUtils.getUnstagedChanges = vi.fn().mockResolvedValue([]);
    GitUtils.getStagedDiff = vi.fn().mockResolvedValue("");
    GitUtils.getUnstagedDiff = vi.fn().mockResolvedValue("");
    GitUtils.getCommitsSinceBranch = vi.fn().mockResolvedValue([]);
    GitUtils.stageFiles = vi.fn().mockResolvedValue(true);
    GitUtils.createCommit = vi.fn().mockResolvedValue("abc1234567890");
    GitUtils.getRemoteConfig = vi.fn().mockResolvedValue({
      url: "https://github.com/hellodk/vs-code-plugin",
      owner: "hellodk",
      repo: "vs-code-plugin",
    });
  });

  it("should have correct metadata for git-tool", () => {
    expect(gitTool.name).toBe("git");
    expect(gitTool.description).toBeDefined();
    expect(gitTool.parameters.properties).toBeDefined();
  });

  describe("git_status action", () => {
    it("should read current branch", async () => {
      const result = await gitTool.execute({ action: "git_status" }, context);
      expect(result.success).toBe(true);
      expect(result.output).toContain("branch");
    });

    it("should include staged changes in status", async () => {
      const result = await gitTool.execute({ action: "git_status" }, context);
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/branch|staged|unstaged/i);
    });

    it("should handle not a git repo", async () => {
      const GitUtils = GitUtilsModule.GitUtils as unknown as {
        isGitRepository: ReturnType<typeof vi.fn>;
      };
      GitUtils.isGitRepository = vi.fn().mockResolvedValue(false);

      const result = await gitTool.execute({ action: "git_status" }, context);
      expect(result.success).toBe(false);
      expect(result.output).toContain("not a git repository");
    });
  });

  describe("git_diff action", () => {
    it("should return diff for staged changes", async () => {
      const result = await gitTool.execute(
        { action: "git_diff", type: "staged" },
        context,
      );
      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });

    it("should return diff for unstaged changes", async () => {
      const result = await gitTool.execute(
        { action: "git_diff", type: "unstaged" },
        context,
      );
      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });

    it("should handle no changes gracefully", async () => {
      const GitUtils = GitUtilsModule.GitUtils as unknown as {
        getStagedDiff: ReturnType<typeof vi.fn>;
      };
      GitUtils.getStagedDiff = vi.fn().mockResolvedValue("");

      const result = await gitTool.execute(
        { action: "git_diff", type: "staged" },
        context,
      );
      expect(result.success).toBe(true);
    });
  });

  describe("git_commit action", () => {
    it("should require approval for commit", async () => {
      (context.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue(
        true,
      );

      await gitTool.execute(
        {
          action: "git_commit",
          message: "test: add git tool",
          files: ["src/tools/git-tool.ts"],
        },
        context,
      );

      expect(context.requestApproval).toHaveBeenCalled();
    });

    it("should accept a commit message", async () => {
      (context.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue(
        true,
      );

      const result = await gitTool.execute(
        {
          action: "git_commit",
          message: "feat: add git-aware tool",
          files: ["src/tools/git-tool.ts"],
        },
        context,
      );

      expect(result.output).toContain("commit");
    });

    it("should reject commit if user denies approval", async () => {
      (context.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue(
        false,
      );

      const result = await gitTool.execute(
        {
          action: "git_commit",
          message: "test commit",
          files: ["src/tools/git-tool.ts"],
        },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("denied");
    });

    it("should require commit message", async () => {
      const result = await gitTool.execute(
        {
          action: "git_commit",
          files: ["src/tools/git-tool.ts"],
        },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("required");
    });

    it("should require files to commit", async () => {
      const result = await gitTool.execute(
        {
          action: "git_commit",
          message: "test commit",
          files: [],
        },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("required");
    });
  });

  describe("git_create_pr action", () => {
    it("should require approval for PR creation", async () => {
      (context.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue(
        true,
      );

      await gitTool.execute(
        {
          action: "git_create_pr",
          title: "Add git tool",
          description: "Implements git-aware tool",
          base: "main",
          head: "feat/git-tool",
          githubToken: "ghp_test1234567890",
        },
        context,
      );

      expect(context.requestApproval).toHaveBeenCalled();
    });

    it("should reject PR if user denies approval", async () => {
      (context.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue(
        false,
      );

      const result = await gitTool.execute(
        {
          action: "git_create_pr",
          title: "Add git tool",
          description: "Implements git-aware tool",
          base: "main",
          head: "feat/git-tool",
          githubToken: "ghp_test1234567890",
        },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("denied");
    });

    it("should validate required parameters", async () => {
      const result = await gitTool.execute(
        {
          action: "git_create_pr",
          // Missing required parameters
        },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("required");
    });

    it("should require title", async () => {
      const result = await gitTool.execute(
        {
          action: "git_create_pr",
          description: "Test",
          base: "main",
          head: "feature",
          githubToken: "token",
        },
        context,
      );

      expect(result.success).toBe(false);
    });

    it("should require head branch", async () => {
      const result = await gitTool.execute(
        {
          action: "git_create_pr",
          title: "Test PR",
          description: "Test",
          base: "main",
          githubToken: "token",
        },
        context,
      );

      expect(result.success).toBe(false);
    });
  });

  it("should reject invalid actions", async () => {
    const result = await gitTool.execute({ action: "invalid_action" }, context);

    expect(result.success).toBe(false);
    expect(result.output).toContain("unknown");
  });

  it("should have requiresApproval set to true", () => {
    expect(gitTool.requiresApproval).toBe(true);
  });

  describe("getPreview", () => {
    it("should provide preview for git_commit", () => {
      const preview = gitTool.getPreview?.({
        action: "git_commit",
        message: "test: add feature",
        files: ["file.ts"],
      });

      expect(preview).toBeDefined();
      expect(preview?.type).toBe("command");
      expect(preview?.content).toContain("git commit");
    });

    it("should provide preview for git_create_pr", () => {
      const preview = gitTool.getPreview?.({
        action: "git_create_pr",
        title: "Test PR",
        description: "Description",
      });

      expect(preview).toBeDefined();
      expect(preview?.type).toBe("command");
      expect(preview?.content).toContain("Pull Request");
    });

    it("should not provide preview for read-only actions", () => {
      const preview = gitTool.getPreview?.({
        action: "git_status",
      });

      expect(preview).toBeUndefined();
    });
  });
});
