import { describe, it, expect } from "vitest";
import { TemplateInterpolator } from "@/agent/template-interpolator";

describe("TemplateInterpolator", () => {
  const mem: Record<string, unknown> = {
    plan: { assignments: { infra: "deploy k8s", cicd: null } },
    infra_result: "terraform apply done",
    count: 42,
    zero: 0,
  };

  it("replaces a simple key", () => {
    const interp = new TemplateInterpolator();
    expect(interp.interpolate("Result: {{infra_result}}", mem)).toBe(
      "Result: terraform apply done",
    );
  });

  it("replaces nested dot-path", () => {
    const interp = new TemplateInterpolator();
    expect(interp.interpolate("Task: {{plan.assignments.infra}}", mem)).toBe(
      "Task: deploy k8s",
    );
  });

  it("replaces null value with (not available) and records warning", () => {
    const interp = new TemplateInterpolator();
    const result = interp.interpolate("Task: {{plan.assignments.cicd}}", mem);
    expect(result).toBe("Task: (not available)");
    expect(interp.warnings).toHaveLength(1);
    expect(interp.warnings[0]).toContain("plan.assignments.cicd");
  });

  it("replaces numeric value correctly", () => {
    const interp = new TemplateInterpolator();
    expect(interp.interpolate("Count: {{count}}", mem)).toBe("Count: 42");
  });

  it("handles zero value without discarding", () => {
    const interp = new TemplateInterpolator();
    expect(interp.interpolate("Val: {{zero}}", mem)).toBe("Val: 0");
    expect(interp.warnings).toHaveLength(0);
  });

  it("leaves non-template text unchanged", () => {
    const interp = new TemplateInterpolator();
    expect(interp.interpolate("plain text", mem)).toBe("plain text");
  });

  it("replaces multiple occurrences of same key", () => {
    const interp = new TemplateInterpolator();
    expect(
      interp.interpolate("{{infra_result}} and again {{infra_result}}", mem),
    ).toBe("terraform apply done and again terraform apply done");
  });

  it("handles undefined path as (not available)", () => {
    const interp = new TemplateInterpolator();
    const result = interp.interpolate("X: {{missing.path}}", mem);
    expect(result).toBe("X: (not available)");
    expect(interp.warnings).toHaveLength(1);
  });

  it("serializes object values as JSON", () => {
    const interp = new TemplateInterpolator();
    const result = interp.interpolate("Plan: {{plan}}", mem);
    expect(result).toContain('"infra"');
  });
});
