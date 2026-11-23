import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitUtils } from "../../../src/tools/git/git-utils";

describe("GitTool Integration Tests", () => {
  let testRepoPath: string;

  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: testRepoPath, stdio: "ignore" });
  };

  beforeAll(() => {
    // os.tmpdir() keeps this portable (the old hardcoded /tmp path broke Windows).
    testRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "champ-git-tool-"));
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");

    fs.writeFileSync(path.join(testRepoPath, "README.md"), "# Test Repo\n");
    git("add", ".");
    git("commit", "-m", "Initial commit");
    git("branch", "main");

    git("checkout", "-b", "feat/test-feature");
    fs.writeFileSync(path.join(testRepoPath, "feature.txt"), "feature\n");
    git("add", ".");
    git("commit", "-m", "Feature commit");
  });

  afterAll(() => {
    if (fs.existsSync(testRepoPath)) {
      fs.rmSync(testRepoPath, { recursive: true, force: true });
    }
  });

  describe("GitUtils with real git repository", () => {
    it("detects current branch correctly", async () => {
      expect(await GitUtils.getCurrentBranch(testRepoPath)).toBe(
        "feat/test-feature",
      );
    });

    it("gets HEAD commit hash", async () => {
      expect(await GitUtils.getHeadCommit(testRepoPath)).toMatch(
        /^[a-f0-9]{40}$/,
      );
    });

    it("lists commits since main branch", async () => {
      const commits = await GitUtils.getCommitsSinceBranch(
        testRepoPath,
        "main",
      );
      expect(commits.length).toBe(1);
      expect(commits[0]).toMatchObject({
        message: "Feature commit",
        author: "Test User",
      });
    });

    it("detects staged changes correctly", async () => {
      fs.writeFileSync(path.join(testRepoPath, "staged.txt"), "staged\n");
      git("add", "staged.txt");
      expect(await GitUtils.getStagedChanges(testRepoPath)).toContain(
        "staged.txt",
      );
    });

    it("parses GitHub URLs correctly", () => {
      expect(
        GitUtils.parseGitHubUrl("git@github.com:hellodk/champ.git"),
      ).toEqual({ owner: "hellodk", repo: "champ" });
    });

    it("parses HTTPS GitHub URLs", () => {
      expect(
        GitUtils.parseGitHubUrl("https://github.com/hellodk/champ.git"),
      ).toEqual({ owner: "hellodk", repo: "champ" });
    });

    it("handles URLs with trailing slashes", () => {
      expect(
        GitUtils.parseGitHubUrl("https://github.com/hellodk/champ/"),
      ).toEqual({ owner: "hellodk", repo: "champ" });
    });
  });
});
