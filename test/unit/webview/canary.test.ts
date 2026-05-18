import { describe, it, expect } from "vitest";

describe("jsdom environment", () => {
  it("window is defined", () => {
    expect(typeof window).toBe("object");
  });
  it("document.createElement works", () => {
    const div = document.createElement("div");
    expect(div.tagName).toBe("DIV");
  });
});
