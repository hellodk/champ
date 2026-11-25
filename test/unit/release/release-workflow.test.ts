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

  it("publishes on PR merge and on manual dispatch, not only on push", () => {
    expect(workflow).toMatch(/pull_request:\s*\n\s*types: \[closed\]/);
    expect(workflow).toMatch(/^\s*workflow_dispatch:[ \t]*$/m);
    expect(workflow).toContain("github.event.pull_request.merged");
    expect(workflow).toContain(
      "startsWith(github.event.pull_request.title, 'chore(release):')",
    );
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
  });

  it("splits version planning from publishing", () => {
    expect(workflow).toMatch(
      /if: \$\{\{ github\.event_name == 'push' && !startsWith\(github\.event\.head_commit\.message, 'chore\(release\):'\) \}\}/,
    );
    expect(workflow).toContain(
      "ref: ${{ needs.version.outputs.sha || github.event.pull_request.merge_commit_sha || github.sha }}",
    );
    expect(workflow).toContain("name: Plan next version");
    expect(workflow).toContain("name: Build and publish release");
  });

  it("skips publishing when the tag already exists", () => {
    expect(workflow).toContain(
      "name: Skip if this release is already published",
    );
    expect(workflow).toContain(
      'git ls-remote --exit-code --tags origin "refs/tags/${TAG}"',
    );
    expect(workflow).toContain("steps.publish_skip.outputs.skip != 'true'");
  });

  it("merges the version commit through an auto-merge PR", () => {
    expect(workflow).toContain("gh pr merge --auto --squash");
    expect(workflow).not.toContain("--json number --jq .number");
    expect(workflow).not.toContain("git push origin HEAD:master");
    expect(workflow).toContain("group: release-master");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("waits for the version PR to merge and hands its commit to publishing", () => {
    expect(workflow).toContain("sha: ${{ steps.merge_wait.outputs.sha }}");
    expect(workflow).toContain('gh api "repos/$GITHUB_REPOSITORY/pulls/$PR"');
    expect(workflow).toContain("jq -r .merged");
    expect(workflow).toContain(
      'if [[ "$state" == "closed" && "$merged" == "true" ]]; then',
    );
    expect(workflow).toContain("sleep 20");
    expect(workflow).toContain("needs: version");
    expect(workflow).toContain("always() &&");
    expect(workflow).toContain(
      "needs.version.outputs.sha || github.event.pull_request.merge_commit_sha || github.sha",
    );
  });

  it("does not run Husky hooks for the automated version commit", () => {
    expect(workflow).toMatch(/HUSKY:\s*"0"/);
  });

  it("computes the next patch version through the unified script", () => {
    expect(workflow).toContain("scripts/champ version next");
    expect(script).toContain("cmd_version()");
    expect(script).toContain("_next_version()");
  });

  it("bumps package.json on a release branch, not on master directly", () => {
    expect(workflow).toMatch(/pnpm version "\$NEXT" --no-git-tag-version/);
    expect(workflow).toContain("git add package.json");
    expect(workflow).toContain('git commit -m "chore(release): ${NEXT}"');
    expect(workflow).toContain(
      'git push --force origin "HEAD:refs/heads/release/${TAG}"',
    );
  });

  it("builds CLI and extension from the same master version commit", () => {
    expect(workflow).toContain("pnpm run compile");
    expect(workflow).toContain("pnpm exec vsce package --no-dependencies");
    expect(workflow).toContain(
      "npm pack --ignore-scripts --pack-destination .",
    );
    expect(workflow).toContain(
      'mv "champ-${NEXT}.tgz" "champ-cli-${NEXT}.tgz"',
    );
    expect(workflow).toContain("node dist/cli.js --version");
    expect(workflow).toContain("p.version !== process.env.NEXT");
  });

  it("publishes both artifacts from the master commit", () => {
    expect(workflow).toContain('git tag "$TAG" "$SHA"');
    expect(workflow).toContain('git push origin "$TAG"');
    expect(workflow).toContain('gh release create "${TAG}" "$VSIX" "$TGZ"');
    expect(workflow).toContain("--generate-notes");
  });

  it("does not create a second release from the local script", () => {
    expect(script).not.toContain("gh release create");
    expect(script).toContain("Release workflow will publish");
  });

  it("documents the single version source and both release assets", () => {
    expect(docs).toContain("package.json` has the only release version");
    expect(docs).toContain("scripts/champ release");
    expect(docs).toContain("champ-cli-");
    expect(docs).toContain("workflow_dispatch");
    expect(docs).toContain("pull_request");
    expect(docs).toContain("waits for the PR to merge");
  });
});
