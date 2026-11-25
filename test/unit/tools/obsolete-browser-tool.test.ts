/**
 * Regression guard: the simulated browser implementation must not ship.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("obsolete simulated browser", () => {
  it("is not present in src/", () => {
    expect(
      fs.existsSync(path.join(process.cwd(), "src", "tools", "browser-tool.ts")),
    ).toBe(false);
  });

  it("has no test importing it", () => {
    const testFile = path.join(
      process.cwd(),
      "test",
      "unit",
      "browser-tool.test.ts",
    );
    expect(fs.existsSync(testFile)).toBe(false);
  });
});
