/**
 * Packaging regression test: the headless CLI must not depend on dev-only
 * packages at runtime. This checks the manifest, source, and production bundle
 * directly so it does not depend on a package-manager tarball round trip.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();

describe("production browser runtime packaging", () => {
  it("ships a CLI bundle whose Playwright dependency is declared for production", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.playwright).toBeDefined();
    expect(pkg.devDependencies?.["@playwright/test"]).toBeDefined();

    const browserSource = fs.readFileSync(
      path.join(ROOT, "src", "tools", "browser.ts"),
      "utf8",
    );
    expect(browserSource).not.toContain("@playwright/test");
    expect(browserSource).toContain('import("playwright")');

    execFileSync("node", ["esbuild.mjs", "--production"], {
      cwd: ROOT,
      stdio: "pipe",
    });
    const cli = fs.readFileSync(
      path.join(ROOT, "dist", "cli.js"),
      "utf8",
    );
    expect(
      cli.includes('import("playwright")') ||
        cli.includes('require("playwright")'),
    ).toBe(true);
    expect(cli).not.toContain("@playwright/test");
  }, 60_000);
});
