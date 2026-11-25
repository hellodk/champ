/**
 * Packaging regression test: the production CLI must not require a browser
 * runtime. Playwright and Chromium are optional, operator-supplied adapters.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();

describe("production browser packaging", () => {
  it("ships no Playwright dependency in the production manifest", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    expect(pkg.dependencies?.playwright).toBeUndefined();
    expect(pkg.devDependencies?.["@playwright/test"]).toBeDefined();
    expect(pkg.peerDependenciesMeta?.playwright?.optional).toBe(true);

    const adapters = fs.readFileSync(
      path.join(ROOT, "src", "tools", "browser-adapters.ts"),
      "utf8",
    );
    expect(adapters).toContain('const PLAYWRIGHT_MODULE = "playwright"');
    expect(adapters).not.toContain('import("playwright")');
  });

  it("builds a CLI bundle without browser runtime modules", () => {
    const outfile = path.join(ROOT, "dist", `.cli.packaging.${process.pid}.js`);
    try {
      execFileSync("node", ["esbuild.mjs", "--production", "--cli-only"], {
        cwd: ROOT,
        env: { ...process.env, CHAMP_CLI_OUTFILE: outfile },
        stdio: "pipe",
      });
      const cli = fs.readFileSync(outfile, "utf8");
      expect(cli).not.toContain('require("playwright-core")');
      expect(cli).not.toContain('require("playwright")');
      expect(cli).not.toContain("@playwright/test");
    } finally {
      fs.rmSync(outfile, { force: true });
    }
  }, 60_000);
});
