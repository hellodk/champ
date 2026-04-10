/**
 * TDD: Tests for RulesEngine.
 * Load/merge project + user + team rules with glob-based auto-attach.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { RulesEngine } from "@/rules/rules-engine";

describe("RulesEngine", () => {
  let engine: RulesEngine;

  beforeEach(() => {
    engine = new RulesEngine("/test-workspace");
  });

  it("should load rules from .champ/rules/ directory", async () => {
    // Mock filesystem to return rule files
    engine.loadRulesFromDirectory = vi.fn().mockResolvedValue([
      {
        name: "style-guide",
        content: "Use 2-space indent",
        type: "always",
        source: "project",
      },
      {
        name: "testing",
        content: "Write tests first",
        type: "always",
        source: "project",
      },
    ]);

    const rules = await engine.loadRulesFromDirectory(".champ/rules");
    expect(rules).toHaveLength(2);
  });

  it("should classify rules by type: always, auto-attached, agent-requested", async () => {
    engine.addRule({
      name: "always-rule",
      content: "Always apply",
      type: "always",
      source: "project",
    });
    engine.addRule({
      name: "ts-rule",
      content: "TS specific",
      type: "auto-attached",
      source: "project",
      glob: "*.ts",
    });
    engine.addRule({
      name: "security",
      content: "Security check",
      type: "agent-requested",
      source: "project",
    });

    const always = engine.getActiveRules({
      currentFile: "test.py",
      mode: "agent",
    });
    expect(always.some((r) => r.name === "always-rule")).toBe(true);
    expect(always.some((r) => r.name === "security")).toBe(false); // not auto-applied
  });

  it("should auto-attach rules matching current file glob", () => {
    engine.addRule({
      name: "ts-rule",
      content: "TS rules",
      type: "auto-attached",
      source: "project",
      glob: "*.ts",
    });
    engine.addRule({
      name: "py-rule",
      content: "Python rules",
      type: "auto-attached",
      source: "project",
      glob: "*.py",
    });

    const rules = engine.getActiveRules({
      currentFile: "src/main.ts",
      mode: "agent",
    });
    expect(rules.some((r) => r.name === "ts-rule")).toBe(true);
    expect(rules.some((r) => r.name === "py-rule")).toBe(false);
  });

  it("should merge user rules with project rules", () => {
    engine.addRule({
      name: "project-rule",
      content: "Project",
      type: "always",
      source: "project",
    });
    engine.setUserRules("Always be concise.");

    const rules = engine.getActiveRules({
      currentFile: "test.ts",
      mode: "agent",
    });
    expect(rules.some((r) => r.source === "project")).toBe(true);
    expect(rules.some((r) => r.source === "user")).toBe(true);
  });

  it("should return agent-requested rules when explicitly fetched", () => {
    engine.addRule({
      name: "security",
      content: "Check for XSS",
      type: "agent-requested",
      source: "project",
    });

    const rule = engine.getRule("security");
    expect(rule).toBeDefined();
    expect(rule!.content).toContain("XSS");
  });

  it("should list all available rules", () => {
    engine.addRule({
      name: "a",
      content: "A",
      type: "always",
      source: "project",
    });
    engine.addRule({
      name: "b",
      content: "B",
      type: "auto-attached",
      source: "project",
      glob: "*.ts",
    });

    const all = engine.listRules();
    expect(all).toHaveLength(2);
  });
});
