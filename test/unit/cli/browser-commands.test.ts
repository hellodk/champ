/**
 * TDD: `champ browser install` must locate the Playwright CLI through a path
 * the package actually exports. `playwright/cli.js` exists on disk but is not
 * in the package's `exports`, so `require.resolve` on that subpath throws.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import { playwrightCliPath } from "@/cli/browser-commands";

describe("browser install command", () => {
  it("resolves the Playwright CLI from the exported package metadata", () => {
    const cliPath = playwrightCliPath();
    expect(cliPath).toContain("playwright");
    expect(fs.existsSync(cliPath)).toBe(true);
  });
});
