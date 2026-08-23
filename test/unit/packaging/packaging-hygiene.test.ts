import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Regression guard for issue #102.
 *
 * Contract:
 * 1. graphify-out/, .champ/team-runs/ and .superpowers/ are never git-tracked,
 *    so they can never be pushed to GitHub.
 * 2. .gitignore lists all four runtime/internal directories.
 * 3. .vscodeignore keeps internal docs, code-graph artifacts, runtime data and
 *    lockfiles out of the published VSIX, while README.md / LICENSE stay in
 *    (vsce requires both).
 */

const ROOT = path.resolve(__dirname, "../../..");

const readLines = (rel: string): string[] =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .split("\n")
    .map((l) => l.trim());

describe("packaging + repo hygiene (#102)", () => {
  it("never tracks graphify-out, .champ/team-runs or .superpowers in git", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: ROOT,
      encoding: "utf8",
    }).split("\n");
    const leaked = tracked.filter(
      (f) =>
        f.startsWith("graphify-out/") ||
        f.startsWith(".champ/team-runs/") ||
        f.startsWith(".superpowers/"),
    );
    expect(leaked).toEqual([]);
  });

  it(".gitignore lists all runtime/internal directories", () => {
    const lines = readLines(".gitignore");
    for (const entry of [
      "graphify-out/",
      ".champ/team-runs/",
      ".superpowers/",
      ".worktrees/",
    ]) {
      expect(lines).toContain(entry);
    }
  });

  it(".vscodeignore excludes internals and user data from the VSIX", () => {
    const patterns = readLines(".vscodeignore");
    for (const pat of [
      "graphify-out/**",
      ".champ/**",
      ".superpowers/**",
      ".worktrees/**",
      "docs/**",
      "test-reports/**",
      "examples/**",
      "marketplace/**",
      "pnpm-lock.yaml",
      "package-lock.json",
      "pending-items.md",
      "OPTIMIZATIONS.md",
      "CHANGELOG.md",
    ]) {
      expect(patterns).toContain(pat);
    }
  });

  it("keeps vsce-required files packaged", () => {
    const excluded = new Set(readLines(".vscodeignore"));
    // README.md and LICENSE must NOT appear as exclusion patterns
    expect(excluded.has("README.md")).toBe(false);
    expect(excluded.has("LICENSE")).toBe(false);
  });
});
