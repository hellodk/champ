/**
 * TDD: the VSIX must carry the browser runtime. A blanket node_modules ignore
 * combined with externalised playwright-core/chromium-bidi leaves extension.js
 * requiring modules that are not in the package.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";

describe("VSIX browser runtime packaging", () => {
  it("does not externalise playwright-core or chromium-bidi in the extension bundle", () => {
    const build = fs.readFileSync("esbuild.mjs", "utf8");
    const extensionOptions = build.slice(
      build.indexOf("const extensionOptions"),
      build.indexOf("// Headless entry"),
    );

    expect(extensionOptions).not.toContain("playwright-core");
    // chromium-bidi is only referenced by Playwright's optional BiDi path and
    // is not resolvable in this dependency tree; leaving it external does not
    // affect Chromium CDP launches.
    expect(extensionOptions).toContain("chromium-bidi");
  });

  it("documents that the VSIX carries the runtime inside the extension bundle", () => {
    const ignore = fs.readFileSync(".vscodeignore", "utf8");
    expect(ignore).toContain(
      "browser runtime is bundled into dist/extension.js",
    );
  });

  it("provisions Chromium on both primary CI platforms before E2E", () => {
    const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    const e2e = ci.slice(ci.indexOf("e2e-tests:"));
    expect(e2e).toContain("macos-latest");
    expect(e2e).toContain("playwright install --with-deps chromium");
  });

  it("keeps the required E2E check name while adding macOS coverage", () => {
    const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("name: E2E Tests\n");
    expect(ci).toMatch(
      /e2e-status:\s*\n\s*name: E2E Tests\s*\n\s*needs: e2e-tests/,
    );
  });
});
