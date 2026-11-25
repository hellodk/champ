/**
 * Packaging regression test: the headless CLI must not depend on dev-only
 * packages at runtime. This inspects the actual npm payload and the bundled
 * `bin` artifact without installing dev dependencies.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
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

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "champ-pack-"));
    try {
      execFileSync("corepack", ["pnpm", "pack", "--pack-destination", tmp], {
        cwd: ROOT,
        stdio: "pipe",
      });
      const tarball = fs
        .readdirSync(tmp)
        .find((name) => name.endsWith(".tgz"));
      expect(tarball).toBeDefined();

      execFileSync("tar", ["-xzf", path.join(tmp, tarball!), "-C", tmp]);
      const publishedPkg = JSON.parse(
        fs.readFileSync(path.join(tmp, "package", "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      expect(publishedPkg.dependencies?.playwright).toBeDefined();

      const cli = fs.readFileSync(
        path.join(tmp, "package", "dist", "cli.js"),
        "utf8",
      );
      expect(
        cli.includes('import("playwright")') ||
          cli.includes('require("playwright")'),
      ).toBe(true);
      expect(cli).not.toContain("@playwright/test");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
