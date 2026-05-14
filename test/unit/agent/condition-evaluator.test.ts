import { describe, it, expect } from "vitest";
import { ConditionEvaluator } from "@/agent/condition-evaluator";

describe("ConditionEvaluator", () => {
  const mem: Record<string, unknown> = {
    plan: {
      assignments: { infra: "deploy k8s", cicd: null, security: "scan" },
    },
    infra_result: { success: true, output: "done" },
    review: null,
  };

  const evaluate = (expr: string) =>
    new ConditionEvaluator().evaluate(expr, mem);

  it("evaluates dot-path != null as true when value exists", () => {
    expect(evaluate("plan.assignments.infra != null")).toBe(true);
  });

  it("evaluates dot-path != null as false when value is null", () => {
    expect(evaluate("plan.assignments.cicd != null")).toBe(false);
  });

  it("evaluates dot-path == null as true when value is null", () => {
    expect(evaluate("plan.assignments.cicd == null")).toBe(true);
  });

  it("evaluates nested success field == true", () => {
    expect(evaluate("infra_result.success == true")).toBe(true);
  });

  it("evaluates == false correctly", () => {
    expect(evaluate("infra_result.success == false")).toBe(false);
  });

  it("returns true for empty condition string (no condition = always run)", () => {
    expect(evaluate("")).toBe(true);
  });

  it("returns false when path does not exist and condition checks != null", () => {
    expect(evaluate("nonexistent.field != null")).toBe(false);
  });

  it("evaluates top-level null value == null", () => {
    expect(evaluate("review == null")).toBe(true);
  });

  it("returns true for unparseable expression (graceful default)", () => {
    expect(evaluate("this is not valid")).toBe(true);
  });
});
