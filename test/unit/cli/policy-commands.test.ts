/**
 * TDD: enterprise policy diagnostics via `champ policy show|validate`.
 */
import { describe, it, expect, vi } from "vitest";
import { PolicyEngine } from "@/policy/engine";
import { runPolicyCommand } from "@/cli/policy-commands";

describe("policy commands", () => {
  const engine = () =>
    new PolicyEngine({
      managed: [
        {
          scope: "managed",
          kind: "tool",
          target: "run_terminal_cmd",
          decision: "DENY",
          reason: "admin lock",
        },
      ],
      user: [
        {
          scope: "user",
          kind: "shell",
          target: "git *",
          decision: "ALLOW",
        },
      ],
    });

  it("shows effective rules grouped by scope", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const code = await runPolicyCommand(
      { name: "policy-show" },
      { engine: engine(), stdout, stderr },
    );
    expect(code).toBe(0);
    const text = stdout.mock.calls.map(([line]) => line).join("");
    expect(text).toContain("managed");
    expect(text).toContain("DENY tool run_terminal_cmd (admin lock)");
    expect(text).toContain("user");
    expect(text).toContain("ALLOW shell git *");
    expect(text).toContain("invalid rules: 0");
  });

  it("validate succeeds when no rules were rejected", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const code = await runPolicyCommand(
      { name: "policy-validate" },
      { engine: engine(), stdout, stderr },
    );
    expect(code).toBe(0);
    expect(stdout.mock.calls.map(([line]) => line).join("")).toMatch(
      /valid.*2 rules/i,
    );
  });

  it("validate fails closed when rules were rejected", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const withInvalid = new PolicyEngine({
      project: [
        {
          scope: "project",
          kind: "bogus",
          target: "*",
          decision: "ALLOW",
        } as never,
      ],
    });
    const code = await runPolicyCommand(
      { name: "policy-validate" },
      { engine: withInvalid, stdout, stderr },
    );
    expect(code).toBe(1);
    expect(stderr.mock.calls.map(([line]) => line).join("")).toMatch(
      /invalid rules: 1/i,
    );
  });
});
