/**
 * TDD: Champ ships a protocol-neutral browser tool. Browser runtimes and
 * optional adapters stay outside the published artifacts.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";

describe("vendor-neutral browser packaging", () => {
  it("does not declare Playwright as a mandatory runtime dependency", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    expect(pkg.dependencies?.playwright).toBeUndefined();
    expect(pkg.peerDependencies?.playwright).toBeDefined();
    expect(pkg.peerDependenciesMeta?.playwright?.optional).toBe(true);
  });

  it("externalises optional browser adapters in the extension bundle", () => {
    const build = fs.readFileSync("esbuild.mjs", "utf8");
    const extensionOptions = build.slice(
      build.indexOf("const extensionOptions"),
      build.indexOf("// Headless entry"),
    );

    expect(extensionOptions).toContain("playwright");
    expect(extensionOptions).toContain("playwright-core");
    expect(extensionOptions).toContain("chromium-bidi");
  });

  it("documents that the VSIX carries no browser runtime", () => {
    const ignore = fs.readFileSync(".vscodeignore", "utf8");
    expect(ignore).toContain("no browser runtime");
  });

  it("provisions Chromium only for the E2E tests on both CI platforms", () => {
    const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    const e2e = ci.slice(ci.indexOf("e2e-tests:"));
    expect(e2e).toContain("macos-latest");
    expect(e2e).toContain("playwright install --with-deps chromium");
  });

  it("keeps the required E2E check name while adding macOS coverage", () => {
    const ci = fs
      .readFileSync(".github/workflows/ci.yml", "utf8")
      .replace(/\r\n/g, "\n");
    expect(ci).toContain("name: E2E Tests\n");
    expect(ci).toMatch(
      /e2e-status:\s*\n\s*name: E2E Tests\s*\n\s*needs: e2e-tests/,
    );
  });
});
