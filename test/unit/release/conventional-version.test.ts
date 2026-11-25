/**
 * TDD: release versions must be derived from conventional commits, not from a
 * blind patch bump. Both the extension and the headless CLI read package.json,
 * so one bump must keep both in step.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";

function nextVersion(current: string, tag: string, commits: string[]): string {
  return execFileSync(
    "bash",
    ["scripts/champ", "version", "next", current, tag],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CHAMP_VERSION_COMMITS: commits.join("\n") },
    },
  ).trim();
}

describe("conventional-commit release versioning", () => {
  it("bumps minor for a feat commit", () => {
    expect(nextVersion("1.2.3", "v1.2.3", ["feat: add browser install"])).toBe(
      "1.3.0",
    );
  });

  it("bumps patch for a fix commit", () => {
    expect(nextVersion("1.2.3", "v1.2.3", ["fix: guard cancellation"])).toBe(
      "1.2.4",
    );
  });

  it("bumps major for a breaking change", () => {
    expect(
      nextVersion("1.2.3", "v1.2.3", [
        "feat!: remove legacy status API",
        "BREAKING CHANGE: callers must use Check Runs",
      ]),
    ).toBe("2.0.0");
  });

  it("uses the greater of the manifest and the latest tag as the base", () => {
    expect(nextVersion("1.2.3", "v2.0.0", ["fix: patch"])).toBe("2.0.1");
  });

  it("still bumps a patch when no commit carries a release type", () => {
    expect(nextVersion("1.2.3", "v1.2.3", ["docs: tidy readme"])).toBe("1.2.4");
  });

  it("passes the conventional commit subjects from the release workflow", () => {
    const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain("CHAMP_VERSION_COMMITS");
    expect(workflow).toContain("scripts/champ version next");
  });

  it("syncs the version commit back to master through a PR, not only the tag", () => {
    const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
    // master is protected by required checks: the release commit goes to a
    // release branch and a PR carries it back after those checks pass.
    expect(workflow).not.toContain("git push origin HEAD:master");
    expect(workflow).toContain(
      'git push --force origin "HEAD:refs/heads/release/${TAG}"',
    );
    expect(workflow).toContain("gh pr create");
  });

  it("keeps CLI and extension on a single manifest version", () => {
    const cli = fs.readFileSync("src/cli.ts", "utf8");
    expect(cli).toContain('path.join(__dirname, "..", "package.json")');
    expect(cli).not.toMatch(/version:\s*["']\d+\.\d+\.\d+["']/);
  });
});
