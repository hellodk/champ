/**
 * Policy engine regression tests.
 *
 * Contracts:
 * - managed > user > project > session precedence (first matching layer wins)
 * - ALLOW / ASK / DENY apply to tools, shell commands, paths, MCP and subagents
 * - ASK becomes DENY in headless mode
 * - malformed policy files never grant access
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PolicyEngine, loadPolicyFile, type PolicyRule } from "@/policy/engine";

describe("PolicyEngine", () => {
  const rule = (
    scope: PolicyRule["scope"],
    kind: PolicyRule["kind"],
    target: string,
    decision: PolicyRule["decision"],
  ): PolicyRule => ({ scope, kind, target, decision });

  it("honours managed > user > project > session precedence", () => {
    const engine = new PolicyEngine({
      managed: [rule("managed", "tool", "run_terminal_cmd", "DENY")],
      user: [rule("user", "tool", "run_terminal_cmd", "ALLOW")],
      project: [rule("project", "tool", "run_terminal_cmd", "ALLOW")],
      session: [rule("session", "tool", "run_terminal_cmd", "ALLOW")],
    });
    const result = engine.evaluate({ kind: "tool", id: "run_terminal_cmd" });
    expect(result.decision).toBe("DENY");
    expect(result.source).toBe("managed");
  });

  it("uses the highest-precedence matching layer even when lower layers deny", () => {
    const engine = new PolicyEngine({
      user: [rule("user", "shell", "git *", "ALLOW")],
      project: [
        rule("project", "shell", "git push*", "DENY"),
        rule("project", "shell", "npm publish*", "DENY"),
      ],
    });
    expect(engine.evaluate({ kind: "shell", id: "git status" }).decision).toBe(
      "ALLOW",
    );
    expect(
      engine.evaluate({ kind: "shell", id: "git push --force" }).decision,
    ).toBe("ALLOW");
    expect(engine.evaluate({ kind: "shell", id: "npm publish" }).decision).toBe(
      "DENY",
    );
  });

  it("evaluates path, MCP and subagent subjects before execution", () => {
    const engine = new PolicyEngine({
      project: [
        rule("project", "path", "/etc/*", "DENY"),
        rule("project", "mcp", "untrusted-server", "DENY"),
        rule("project", "subagent", "rogue", "DENY"),
      ],
    });
    expect(engine.evaluate({ kind: "path", id: "/etc/shadow" }).decision).toBe(
      "DENY",
    );
    expect(
      engine.evaluate({ kind: "mcp", id: "untrusted-server" }).decision,
    ).toBe("DENY");
    expect(engine.evaluate({ kind: "subagent", id: "rogue" }).decision).toBe(
      "DENY",
    );
  });

  it("falls back to approval for approval-required tools", () => {
    const engine = new PolicyEngine();
    expect(
      engine.evaluate({ kind: "tool", id: "edit_file", requiresApproval: true })
        .decision,
    ).toBe("ASK");
    expect(engine.evaluate({ kind: "tool", id: "read_file" }).decision).toBe(
      "ALLOW",
    );
  });

  it("denies ASK decisions in headless mode", () => {
    const engine = new PolicyEngine();
    const result = engine.evaluate(
      { kind: "tool", id: "edit_file", requiresApproval: true },
      { headless: true },
    );
    expect(result.decision).toBe("DENY");
    expect(result.reason).toMatch(/headless/i);
  });

  it("rejects invalid rules instead of treating them as allow rules", () => {
    const engine = new PolicyEngine({
      project: [
        { scope: "project", kind: "tool", target: "*", decision: "ALLOW" },
        {
          scope: "project",
          kind: "tool",
          target: "",
          decision: "DENY",
        } as never,
      ],
    });
    expect(engine.evaluate({ kind: "tool", id: "anything" }).decision).toBe(
      "ALLOW",
    );
    expect(engine.invalidRules).toBe(1);
  });
});

describe("loadPolicyFile", () => {
  it("returns no rules for a missing or malformed policy file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "champ-policy-"));
    expect(loadPolicyFile(path.join(dir, "missing.json"), "project")).toEqual(
      [],
    );
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not-json");
    expect(loadPolicyFile(bad, "project")).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads and validates a policy file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "champ-policy-"));
    const file = path.join(dir, "policy.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        rules: [
          { kind: "shell", target: "rm -rf *", decision: "DENY" },
          { kind: "bogus", target: "*", decision: "DENY" },
        ],
      }),
    );
    const rules = loadPolicyFile(file, "project");
    expect(rules).toHaveLength(1);
    expect(rules[0].scope).toBe("project");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
