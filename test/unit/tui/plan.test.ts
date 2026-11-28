import { describe, expect, it } from "vitest";
import { advancePlan, planProgress, setPlan, updatePlanStep } from "@/tui/plan";

describe("execution plan", () => {
  it("normalises incoming steps with one active entry", () => {
    const steps = setPlan([
      { id: "1", text: "Read files", status: "done" },
      { id: "2", text: "Edit file", status: "pending" },
      { id: "3", text: "Run tests", status: "pending" },
    ]);
    expect(steps[1].status).toBe("active");
    expect(planProgress(steps)).toEqual({ done: 1, total: 3, percent: 33 });
  });

  it("advances the active step and finishes at the end", () => {
    const steps = setPlan([
      { id: "1", text: "A", status: "pending" },
      { id: "2", text: "B", status: "pending" },
    ]);
    const second = advancePlan(steps);
    expect(second.map((step) => step.status)).toEqual(["done", "active"]);
    expect(advancePlan(second).map((step) => step.status)).toEqual([
      "done",
      "done",
    ]);
  });

  it("blocks a step explicitly", () => {
    const steps = setPlan([{ id: "1", text: "A", status: "pending" }]);
    expect(updatePlanStep(steps, "1", "blocked")[0].status).toBe("blocked");
  });
});
