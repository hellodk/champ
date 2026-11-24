import { describe, expect, it } from "vitest";
import { createHeadlessToolRegistry } from "@/tools/headless";

describe("headless tool registry", () => {
  it("never advertises the simulated browser tool as available", () => {
    const registry = createHeadlessToolRegistry();
    expect(registry.get("browser_tool")).toBeUndefined();
    expect(registry.get("fetch_url")).toBeDefined();
  });
});
