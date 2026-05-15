import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const manifest = JSON.parse(
  readFileSync(join(__dirname, "../../../marketplace/manifest.json"), "utf8"),
) as Array<{
  name: string;
  description: string;
  author: string;
  url: string;
  tags: string[];
}>;

describe("marketplace/manifest.json", () => {
  it("is non-empty", () => {
    expect(manifest.length).toBeGreaterThan(0);
  });
  it("all entries have required fields", () => {
    for (const e of manifest) {
      expect(e.name).toBeTruthy();
      expect(e.url).toMatch(/^https?:\/\//);
      expect(Array.isArray(e.tags)).toBe(true);
    }
  });
  it("contains devops and fullstack", () => {
    const names = manifest.map((e) => e.name);
    expect(names).toContain("devops");
    expect(names).toContain("fullstack");
  });
});
