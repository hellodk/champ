import { describe, it, expect, vi, beforeEach } from "vitest";
import { gitToolProvider } from "../../../src/tools/git-tool";
import type { ToolExecutionContext } from "../../../src/tools/types";

// Mock the git utilities and GitHub API
vi.mock("../../../src/tools/git/git-utils", () => ({
  GitUtils: vi.fn(() => ({
    getCurrentBranch: vi.fn(async () => "feat/test-feature"),
    getRemoteUrl: vi.fn(async () => "git@github.com:hellodk/champ.git"),
    getStagedChanges: vi.fn(async () => "diff --git changes"),
    getCommitsSinceBase: vi.fn(async () => ["commit1", "commit2"]),
    getHeadCommit: vi.fn(async () => "abc123"),
    parseGitHubUrl: vi.fn((url: string) => ({
      owner: "hellodk",
      repo: "champ",
    })),
  })),
}));

vi.mock("../../../src/tools/git/github-api", () => ({
  GitHubAPI: vi.fn(() => ({
    validateToken: vi.fn(async () => true),
    createPullRequest: vi.fn(async () => ({
      success: true,
      prUrl: "https://github.com/hellodk/champ/pull/123",
      prNumber: 123,
    })),
  })),
}));

function makeContext(): ToolExecutionContext {
  return {
    workspaceRoot: "/test/workspace",
    abortSignal: new AbortController().signal,
    reportProgress: vi.fn(),
    requestApproval: vi.fn(async () => true),
  };
}

describe("gitToolProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Tool metadata", () => {
    it("has correct name", () => {
      const tools = gitToolProvider.tools();
      const createPrTool = tools.find((t) => t.name === "git_create_pr");
      expect(createPrTool).toBeDefined();
      expect(createPrTool?.description).toContain("pull request");
    });

    it("requires approval", () => {
      const tools = gitToolProvider.tools();
      const createPrTool = tools.find((t) => t.name === "git_create_pr");
      expect(createPrTool?.requiresApproval).toBe(true);
    });

    it("has correct parameters schema", () => {
      const tools = gitToolProvider.tools();
      const createPrTool = tools.find((t) => t.name === "git_create_pr");
      expect(createPrTool?.parameters.properties).toBeDefined();
      expect(createPrTool?.parameters.required).toContain("title");
      expect(createPrTool?.parameters.required).toContain("base");
    });
  });

  describe("git_create_pr tool execution", () => {
    it("creates a pull request successfully", async () => {
      const tools = gitToolProvider.tools();
      const createPrTool = tools.find((t) => t.name === "git_create_pr");
      expect(createPrTool).toBeDefined();

      if (!createPrTool) throw new Error("Tool not found");

      const context = makeContext();
      const result = await createPrTool.execute(
        {
          title: "Test Feature",
          body: "This is a test PR",
          base: "main",
          token: "ghp_test123",
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("Pull request created successfully");
    });

    it("returns error when missing required parameters", async () => {
      const tools = gitToolProvider.tools();
      const createPrTool = tools.find((t) => t.name === "git_create_pr");
      expect(createPrTool).toBeDefined();

      if (!createPrTool) throw new Error("Tool not found");

      const context = makeContext();
      const result = await createPrTool.execute(
        {
          // Missing title and base
          body: "This is a test PR",
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("required");
    });

    it("uses current branch as head branch", async () => {
      const tools = gitToolProvider.tools();
      const createPrTool = tools.find((t) => t.name === "git_create_pr");
      expect(createPrTool).toBeDefined();

      if (!createPrTool) throw new Error("Tool not found");

      const context = makeContext();
      const result = await createPrTool.execute(
        {
          title: "Test Feature",
          body: "This is a test PR",
          base: "main",
          token: "ghp_test123",
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("feat/test-feature");
    });
  });

  describe("git_get_status tool", () => {
    it("returns git status information", async () => {
      const tools = gitToolProvider.tools();
      const statusTool = tools.find((t) => t.name === "git_get_status");
      expect(statusTool).toBeDefined();

      if (!statusTool) throw new Error("Tool not found");

      const context = makeContext();
      const result = await statusTool.execute({}, context);

      expect(result.success).toBe(true);
      expect(result.output).toContain("Branch");
    });
  });

  describe("Tool preview", () => {
    it("shows PR creation preview", () => {
      const tools = gitToolProvider.tools();
      const createPrTool = tools.find((t) => t.name === "git_create_pr");
      expect(createPrTool).toBeDefined();

      if (!createPrTool) throw new Error("Tool not found");

      const preview = createPrTool.getPreview?.({
        title: "Test PR",
        base: "main",
      });

      expect(preview).toBeDefined();
      expect(preview?.type).toBe("command");
    });
  });
});
