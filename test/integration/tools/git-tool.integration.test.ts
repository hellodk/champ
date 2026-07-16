import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { GitUtils } from "../../../src/tools/git/git-utils";

describe("GitTool Integration Tests", () => {
  let testRepoPath: string;

  beforeAll(() => {
    // Create a temporary git repository for testing
    testRepoPath = `/tmp/test-git-tool-${Date.now()}`;
    fs.mkdirSync(testRepoPath, { recursive: true });

    // Initialize git repository
    execSync("git init", { cwd: testRepoPath });
    execSync('git config user.email "test@example.com"', { cwd: testRepoPath });
    execSync('git config user.name "Test User"', { cwd: testRepoPath });

    // Create initial commit
    fs.writeFileSync(path.join(testRepoPath, "README.md"), "# Test Repo\n");
    execSync("git add .", { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

    // Create and checkout a feature branch
    execSync("git checkout -b feat/test-feature", { cwd: testRepoPath });

    // Make some changes
    fs.appendFileSync(
      path.join(testRepoPath, "README.md"),
      "\n## Features\n- Test feature\n"
    );
  });

  afterAll(() => {
    // Clean up test repository
    if (fs.existsSync(testRepoPath)) {
      execSync(`rm -rf ${testRepoPath}`);
    }
  });

  describe("GitUtils with real git repository", () => {
    let gitUtils: GitUtils;

    beforeAll(() => {
      gitUtils = new GitUtils(testRepoPath);
    });

    it("detects current branch correctly", async () => {
      const branch = await gitUtils.getCurrentBranch();
      expect(branch).toBe("feat/test-feature");
    });

    it("gets HEAD commit hash", async () => {
      const commit = await gitUtils.getHeadCommit();
      expect(commit).toMatch(/^[a-f0-9]{40}$/);
    });

    it("lists commits since main branch", async () => {
      // Create main branch first
      const gitUtilsMain = new GitUtils(testRepoPath);
      execSync("git checkout -b main", { cwd: testRepoPath });
      fs.writeFileSync(path.join(testRepoPath, "file1.txt"), "content1");
      execSync("git add .", { cwd: testRepoPath });
      execSync('git commit -m "Main commit"', { cwd: testRepoPath });

      // Back to feature branch
      execSync("git checkout feat/test-feature", { cwd: testRepoPath });

      const commits = await gitUtilsMain.getCommitsSinceBase("main");
      expect(Array.isArray(commits)).toBe(true);
    });

    it("detects staged changes correctly", async () => {
      // Stage the changes
      execSync("git add .", { cwd: testRepoPath });

      const diff = await gitUtils.getStagedChanges();
      expect(diff).toBeTruthy();
      expect(diff.length).toBeGreaterThan(0);
    });

    it("parses GitHub URLs correctly", () => {
      const sshUrl = "git@github.com:hellodk/champ.git";
      const result = gitUtils.parseGitHubUrl(sshUrl);

      expect(result.owner).toBe("hellodk");
      expect(result.repo).toBe("champ");
    });

    it("parses HTTPS GitHub URLs", () => {
      const httpsUrl = "https://github.com/hellodk/champ.git";
      const result = gitUtils.parseGitHubUrl(httpsUrl);

      expect(result.owner).toBe("hellodk");
      expect(result.repo).toBe("champ");
    });

    it("handles URLs with trailing slashes", () => {
      const urlWithSlash = "https://github.com/hellodk/champ/";
      const result = gitUtils.parseGitHubUrl(urlWithSlash);

      expect(result.owner).toBe("hellodk");
      expect(result.repo).toBe("champ");
    });
  });
});
