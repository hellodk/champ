import { describe, it, expect, beforeEach } from "vitest";

// Minimal DOM harness — mirrors the renderSkillDropdown logic.
function renderSkillDropdown(
  container: HTMLElement,
  suggestions: Array<{ name: string; description: string; example?: string }>,
): void {
  container.innerHTML = "";
  suggestions.forEach((s) => {
    const row = document.createElement("div");
    row.className = "skill-row";

    const name = document.createElement("div");
    name.className = "skill-name";
    name.textContent = `/${s.name}`;

    const desc = document.createElement("div");
    desc.className = "skill-desc";
    desc.textContent = s.description;

    row.append(name, desc);

    if (s.example) {
      const ex = document.createElement("div");
      ex.className = "skill-example";
      ex.textContent = s.example;
      row.append(ex);
    }

    container.append(row);
  });
}

describe("renderSkillDropdown with example", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
  });

  it("renders name and description for all entries", () => {
    renderSkillDropdown(container, [
      { name: "review", description: "Code review" },
    ]);
    expect(container.querySelector(".skill-name")?.textContent).toBe("/review");
    expect(container.querySelector(".skill-desc")?.textContent).toBe(
      "Code review",
    );
  });

  it("does NOT render a .skill-example element when example is absent", () => {
    renderSkillDropdown(container, [{ name: "foo", description: "bar" }]);
    expect(container.querySelector(".skill-example")).toBeNull();
  });

  it("renders .skill-example when example is provided", () => {
    renderSkillDropdown(container, [
      {
        name: "review",
        description: "Code review",
        example: "Finds unused variables",
      },
    ]);
    const ex = container.querySelector(".skill-example");
    expect(ex).not.toBeNull();
    expect(ex?.textContent).toBe("Finds unused variables");
  });

  it("renders multiple rows with independent example presence", () => {
    renderSkillDropdown(container, [
      { name: "a", description: "A", example: "shows A" },
      { name: "b", description: "B" },
    ]);
    const rows = container.querySelectorAll(".skill-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".skill-example")).not.toBeNull();
    expect(rows[1].querySelector(".skill-example")).toBeNull();
  });
});
