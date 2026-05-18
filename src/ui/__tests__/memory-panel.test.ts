// src/ui/__tests__/memory-panel.test.ts
import { describe, it, expect } from "vitest";
// MemoryPanel is a singleton — test the createOrShow static method contract
import { MemoryPanel } from "../memory-panel";

describe("MemoryPanel", () => {
  it("exports createOrShow static method", () => {
    expect(typeof MemoryPanel.createOrShow).toBe("function");
  });
});
