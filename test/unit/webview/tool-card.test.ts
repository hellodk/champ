import { describe, it, expect, beforeEach } from "vitest";

// Extracted helper under test — mirrors the logic we will write in main.js.
function buildSummaryLine(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return toolName;
  // Show at most 2 key=value pairs, truncate values to 40 chars.
  const parts = keys.slice(0, 2).map((k) => {
    const v = String(args[k] ?? "");
    return `${k}=${v.length > 40 ? v.slice(0, 37) + "…" : v}`;
  });
  const more = keys.length > 2 ? ` +${keys.length - 2}` : "";
  return `${toolName}(${parts.join(", ")}${more})`;
}

describe("buildSummaryLine", () => {
  it("returns just toolName when args is empty", () => {
    expect(buildSummaryLine("read_file", {})).toBe("read_file");
  });

  it("formats a single arg", () => {
    expect(buildSummaryLine("read_file", { path: "src/index.ts" })).toBe(
      "read_file(path=src/index.ts)",
    );
  });

  it("truncates long values with ellipsis", () => {
    const longVal = "a".repeat(50);
    const result = buildSummaryLine("write_file", { path: longVal });
    expect(result).toContain("…");
    expect(result.length).toBeLessThan(80);
  });

  it("shows at most 2 args with a +N suffix for the rest", () => {
    const result = buildSummaryLine("tool", { a: "1", b: "2", c: "3", d: "4" });
    expect(result).toContain("a=1");
    expect(result).toContain("b=2");
    expect(result).toContain("+2");
    expect(result).not.toContain("c=");
  });
});

describe("tool card DOM toggle", () => {
  it("collapses body element by toggling data-collapsed attribute", () => {
    const card = document.createElement("div");
    card.className = "tool-card";
    const header = document.createElement("div");
    header.className = "tool-card-header";
    const body = document.createElement("div");
    body.className = "tool-card-body";
    card.append(header, body);

    // Initially collapsed
    card.dataset.collapsed = "true";
    expect(card.dataset.collapsed).toBe("true");

    // Simulate toggle
    function toggle() {
      const isCollapsed = card.dataset.collapsed === "true";
      card.dataset.collapsed = isCollapsed ? "false" : "true";
    }

    toggle();
    expect(card.dataset.collapsed).toBe("false");

    toggle();
    expect(card.dataset.collapsed).toBe("true");
  });
});
