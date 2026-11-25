/**
 * TDD: the vendor-neutral browser architecture must be documented for
 * operators, not only encoded in source.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";

describe("browser architecture documentation", () => {
  it("documents WebDriver as the default with optional adapters", () => {
    const docs = fs.readFileSync("docs/TOOLS_REFERENCE.md", "utf8");
    expect(docs).toContain("W3C WebDriver");
    expect(docs).toContain("CHAMP_BROWSER_PROTOCOL");
    expect(docs).toContain("playwright");
    expect(docs).toContain("cdp");
    expect(docs).toContain("remote");
    expect(docs).toContain("does not bundle");
  });

  it("documents the adapter architecture in the architecture guide", () => {
    const docs = fs.readFileSync("docs/ARCHITECTURE.md", "utf8");
    expect(docs).toContain("Browser adapters");
    expect(docs).toContain("WebDriver");
  });
});
