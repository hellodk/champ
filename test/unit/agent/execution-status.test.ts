import { describe, expect, it } from "vitest";
import { executionStatus } from "@/agent/execution-status";

describe("execution status", () => {
  it("classifies clean, errored, partial and cancelled outcomes", () => {
    expect(executionStatus({ text: "done" })).toBe("success");
    expect(executionStatus({ error: "boom" })).toBe("failed");
    expect(executionStatus({ text: "partial", error: "boom" })).toBe("partial");
    expect(executionStatus({ aborted: true, error: "boom" })).toBe("cancelled");
  });

  it("treats tool failures as non-success even when the model replies", () => {
    expect(executionStatus({ text: "done", toolFailures: 1 })).toBe("partial");
    expect(executionStatus({ toolFailures: 1 })).toBe("failed");
  });
});
