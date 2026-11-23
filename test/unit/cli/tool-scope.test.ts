/**
 * Unit tests for CLI per-turn tool scoping (Increment C).
 */
import { describe, it, expect } from "vitest";
import { applyAllowedTools } from "@/cli/tool-scope";
import { createHeadlessToolRegistry } from "@/tools/headless";

describe("applyAllowedTools", () => {
  it("unregisters tools not in the allow list", () => {
    const registry = createHeadlessToolRegistry();
    const scope = applyAllowedTools(registry, [
      "read_file",
      "grep_search",
      "file_search",
    ]);
    expect(scope.missing).toEqual([]);
    expect(
      registry
        .getAll()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["file_search", "grep_search", "read_file"]);
    expect(registry.get("edit_file")).toBeUndefined();
  });

  it("restore() puts every original tool back", () => {
    const registry = createHeadlessToolRegistry();
    const originalNames = registry
      .getAll()
      .map((t) => t.name)
      .sort();
    const scope = applyAllowedTools(registry, ["read_file"]);
    expect(registry.getAll()).toHaveLength(1);

    scope.restore();
    expect(
      registry
        .getAll()
        .map((t) => t.name)
        .sort(),
    ).toEqual(originalNames);
  });

  it("restore() is idempotent", () => {
    const registry = createHeadlessToolRegistry();
    const originalNames = registry
      .getAll()
      .map((t) => t.name)
      .sort();
    const scope = applyAllowedTools(registry, ["read_file"]);

    scope.restore();
    scope.restore();
    expect(
      registry
        .getAll()
        .map((t) => t.name)
        .sort(),
    ).toEqual(originalNames);
  });

  it("reports declared-but-absent tools in missing", () => {
    const registry = createHeadlessToolRegistry();
    const scope = applyAllowedTools(registry, [
      "read_file",
      "grep_search",
      "edit_file",
      "remote_run_terminal",
    ]);
    expect(scope.missing).toEqual(["remote_run_terminal"]);
    expect(
      registry
        .getAll()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["edit_file", "grep_search", "read_file"]);
  });

  it("filters to zero when nothing declared is available", () => {
    const registry = createHeadlessToolRegistry();
    const scope = applyAllowedTools(registry, ["remote_run_terminal"]);
    expect(scope.missing).toEqual(["remote_run_terminal"]);
    expect(registry.getAll()).toEqual([]);

    scope.restore();
    expect(registry.getAll().length).toBeGreaterThan(0);
  });

  it("is a no-op when allowedTools is undefined or empty", () => {
    const registry = createHeadlessToolRegistry();
    const count = registry.getAll().length;

    const s1 = applyAllowedTools(registry, undefined);
    expect(s1.missing).toEqual([]);
    expect(registry.getAll()).toHaveLength(count);
    s1.restore();
    expect(registry.getAll()).toHaveLength(count);

    const s2 = applyAllowedTools(registry, []);
    expect(s2.missing).toEqual([]);
    expect(registry.getAll()).toHaveLength(count);
    s2.restore();
    expect(registry.getAll()).toHaveLength(count);
  });
});
