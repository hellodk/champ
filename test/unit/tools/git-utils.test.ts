import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitUtils } from "../../../src/tools/git/git-utils";
import { spawn } from "child_process";

// Mock child_process
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

describe("GitUtils", () => {
  let gitUtils: GitUtils;
  const mockWorkspaceRoot = "/test/workspace";

  beforeEach(() => {
    gitUtils = new GitUtils(mockWorkspaceRoot);
    vi.clearAllMocks();
  });

  describe("getCurrentBranch", () => {
    it("returns the current git branch name", async () => {
      const mockSpawn = spawn as any;
      mockSpawn.mockReturnValue({
        stdout: { on: vi.fn().mockImplementation((event, callback) => {
          if (event === "data") callback(Buffer.from("main\n"));
        }) },
        stderr: { on: vi.fn() },
        on: vi.fn().mockImplementation((event, callback) => {
          if (event === "close") callback(0);
        }),
      });

      const branch = await gitUtils.getCurrentBranch();
      expect(branch).toBe("main");
    });

    it("throws error when git command fails", async () => {
      const mockSpawn = spawn as any;
      mockSpawn.mockReturnValue({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn().mockImplementation((event, callback) => {
          if (event === "close") callback(1);
        }),
      });

      await expect(gitUtils.getCurrentBranch()).rejects.toThrow(
        "Failed to get current branch"
      );
    });
  });

  describe("getCommitSinceBase", () => {
    it("returns commits since a base branch", async () => {
      const mockSpawn = spawn as any;
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        const isFirstCall = callCount === 0;
        callCount++;
        return {
          stdout: {
            on: vi.fn().mockImplementation((event, callback) => {
              if (event === "data") {
                const data = isFirstCall
                  ? "commit1\ncommit2\n"
                  : "commit1\ncommit2\n";
                callback(Buffer.from(data));
              }
            }),
          },
          stderr: { on: vi.fn() },
          on: vi.fn().mockImplementation((event, callback) => {
            if (event === "close") callback(0);
          }),
        };
      });

      const commits = await gitUtils.getCommitsSinceBase("main");
      expect(Array.isArray(commits)).toBe(true);
      expect(commits.length).toBeGreaterThan(0);
    });
  });

  describe("getStagedChanges", () => {
    it("returns staged changes as diff", async () => {
      const mockSpawn = spawn as any;
      mockSpawn.mockReturnValue({
        stdout: {
          on: vi.fn().mockImplementation((event, callback) => {
            if (event === "data") {
              callback(Buffer.from("diff --git a/file.ts b/file.ts\n"));
            }
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn().mockImplementation((event, callback) => {
          if (event === "close") callback(0);
        }),
      });

      const diff = await gitUtils.getStagedChanges();
      expect(diff).toContain("diff");
    });
  });

  describe("getRemoteUrl", () => {
    it("returns the git remote URL", async () => {
      const mockSpawn = spawn as any;
      mockSpawn.mockReturnValue({
        stdout: {
          on: vi.fn().mockImplementation((event, callback) => {
            if (event === "data") {
              callback(Buffer.from("git@github.com:user/repo.git\n"));
            }
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn().mockImplementation((event, callback) => {
          if (event === "close") callback(0);
        }),
      });

      const url = await gitUtils.getRemoteUrl();
      expect(url).toContain("github.com");
    });

    it("extracts owner and repo from GitHub URL", () => {
      const result = gitUtils.parseGitHubUrl(
        "git@github.com:hellodk/champ.git"
      );
      expect(result).toEqual({ owner: "hellodk", repo: "champ" });
    });

    it("handles HTTPS GitHub URLs", () => {
      const result = gitUtils.parseGitHubUrl(
        "https://github.com/hellodk/champ.git"
      );
      expect(result).toEqual({ owner: "hellodk", repo: "champ" });
    });
  });

  describe("getHeadCommit", () => {
    it("returns the HEAD commit hash", async () => {
      const mockSpawn = spawn as any;
      mockSpawn.mockReturnValue({
        stdout: {
          on: vi.fn().mockImplementation((event, callback) => {
            if (event === "data") {
              callback(Buffer.from("abc123def456\n"));
            }
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn().mockImplementation((event, callback) => {
          if (event === "close") callback(0);
        }),
      });

      const commit = await gitUtils.getHeadCommit();
      expect(commit).toBe("abc123def456");
    });
  });
});
