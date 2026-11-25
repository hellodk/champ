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

    // Build to a private path: the other CLI integration workers spawn the
    // shared dist/cli.js, and a production build writing that path in place
    // can hand them a half-written file.
    const outfile = path.join(ROOT, "dist", `.cli.packaging.${process.pid}.js`);
    try {
      execFileSync("node", ["esbuild.mjs", "--production", "--cli-only"], {
        cwd: ROOT,
        env: { ...process.env, CHAMP_CLI_OUTFILE: outfile },
        stdio: "pipe",
      });
      const cli = fs.readFileSync(outfile, "utf8");
      expect(
        cli.includes('import("playwright")') ||
          cli.includes('require("playwright")'),
      ).toBe(true);
      expect(cli).not.toContain("@playwright/test");
    } finally {
      fs.rmSync(outfile, { force: true });
    }
  }, 60_000);
});
