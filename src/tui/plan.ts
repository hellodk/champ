/** Live execution plan: one active step, explicit completion and blocking. */
export type PlanStepStatus = "pending" | "active" | "done" | "blocked";

export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus;
}

export interface PlanStepInput {
  id: string;
  text: string;
  status?: PlanStepStatus;
}

export function setPlan(input: readonly PlanStepInput[]): PlanStep[] {
  const steps = input.map((step, index) => ({
    id: step.id || `step-${index + 1}`,
    text: step.text,
    status: step.status ?? "pending",
  }));
  const active = steps.findIndex((step) => step.status === "active");
  if (active === -1) {
    const pending = steps.findIndex((step) => step.status === "pending");
    if (pending !== -1)
      steps[pending] = { ...steps[pending], status: "active" };
    return steps;
  }
  return steps.map((step, index) =>
    step.status === "active" && index !== active
      ? { ...step, status: "pending" }
      : step,
  );
}

export function updatePlanStep(
  steps: readonly PlanStep[],
  id: string,
  status: PlanStepStatus,
): PlanStep[] {
  return steps.map((step) => (step.id === id ? { ...step, status } : step));
}

export function advancePlan(steps: readonly PlanStep[]): PlanStep[] {
  const active = steps.findIndex((step) => step.status === "active");
  if (active === -1) return setPlan(steps);
  const completed = updatePlanStep(steps, steps[active].id, "done");
  const next = completed.findIndex((step) => step.status === "pending");
  return next === -1
    ? completed
    : updatePlanStep(completed, completed[next].id, "active");
}

export function planProgress(steps: readonly PlanStep[]): {
  done: number;
  total: number;
  percent: number;
} {
  const done = steps.filter((step) => step.status === "done").length;
  const total = steps.length;
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}
