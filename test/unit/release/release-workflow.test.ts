import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string =>
  readFileSync(path.join(ROOT, rel), "utf8");

describe("release automation", () => {
  const workflow = read(".github/workflows/release.yml");
  const script = read("scripts/champ");
  const docs = read("docs/RELEASING.md");

  it("runs on every push to master", () => {
    expect(workflow).toContain("name: Release");
    expect(workflow).toMatch(/on:\s*\n\s*push:\s*\n\s*branches: \[master\]/);
  });

  it("cannot recurse on its own release commit", () => {
    expect(workflow).toContain("github.actor != 'github-actions[bot]'");
    expect(workflow).toContain("group: release-master");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("does not run Husky hooks for the automated version commit", () => {
    expect(workflow).toMatch(/HUSKY:\s*"0"/);
  });

  it("publishes the tag without pushing to protected master first", () => {
    expect(workflow).toContain('git push origin "${TAG}"');
    expect(workflow).not.toContain("git push origin HEAD:master");
  });

  it("skips a release when HEAD is its own version commit", () => {
    expect(workflow).toContain("git log -1 --pretty=%s");
    expect(workflow).toContain("^chore(release):");
  });

  it("computes the next patch version through the unified script", () => {
    expect(workflow).toContain("scripts/champ version next");
    expect(script).toContain("cmd_version()");
    expect(script).toContain("_next_version()");
  });

  it("bumps package.json, commits and tags before publishing", () => {
    expect(workflow).toMatch(/pnpm version "\$NEXT" --no-git-tag-version/);
    expect(workflow).toContain("git add package.json");
    expect(workflow).toContain('git commit -m "chore(release): ${NEXT}"');
    expect(workflow).toContain('git tag "${TAG}"');
  });

  it("builds and verifies a single version for CLI and extension", () => {
    expect(workflow).toContain("pnpm exec vsce package --no-dependencies");
    expect(workflow).toContain("node dist/cli.js --version");
    expect(workflow).toContain("p.version !== process.env.NEXT");
  });

  it("publishes the VSIX as the release asset", () => {
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain(
      "VSIX: champ-${{ steps.meta.outputs.next }}.vsix",
    );
    expect(workflow).toContain("--generate-notes");
  });

  it("does not create a second release from the local script", () => {
    expect(script).not.toContain("gh release create");
    expect(script).toContain("Release workflow will publish");
  });

  it("documents the single version source", () => {
    expect(docs).toContain("package.json` has the only release version");
    expect(docs).toContain("scripts/champ release");
  });
});
