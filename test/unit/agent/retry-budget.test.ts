/**
 * TDD: workflow retry budget (issue #104).
 *
 * Contract: a workflow run has a bounded total number of failed attempts.
 * Mutual `retryFrom` configurations (a retries from b, b retries from a)
 * previously reset each other's per-agent counters forever, burning LLM
 * calls in an infinite loop. The run must now terminate with an explicit
 * budget-exhausted failure.
 */
import { describe, it, expect } from "vitest";
import { MultiAgentRunner } from "@/agent/multi-agent-runner";
import type {
  Agent,
  AgentInput,
  AgentOutput,
  SharedMemory,
} from "@/agent/agents/types";

function makeAgent(
  name: string,
  behaviour: () => AgentOutput,
  runs: string[],
): Agent {
  return {
    name,
    role: "test",
    execute: async (_input: AgentInput, memory: SharedMemory) => {
      runs.push(name);
      const out = behaviour();
      memory.setOutput(name, out);
      return out;
    },
  };
}

const ok = (): AgentOutput => ({ success: true, output: "fine" });
const fail = (): AgentOutput => ({
  success: false,
  output: "boom",
  error: "boom",
});

describe("workflow retry budget (#104)", () => {
  it("terminates mutual retryFrom loops with a budget-exhausted failure", async () => {
    const runner = new MultiAgentRunner();
    const runs: string[] = [];
    // Pipeline order a → b. b fails and branches back to a; a succeeds but
    // b fails again... a's counter keeps resetting via retryFrom[b]="a".
    runner.registerAgent(makeAgent("a", ok, runs));
    runner.registerAgent(makeAgent("b", fail, runs));

    const result = await runner.run("do the thing", {
      maxRetries: 100,
      retryFrom: { b: "a" },
      maxTotalRetries: 5,
      sequence: ["a", "b"],
    });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/retry budget/i);
    // Bounded: no infinite loop — total executions stay small.
    expect(runs.length).toBeLessThanOrEqual(14);
  });

  it("still allows normal sequential pipelines to succeed", async () => {
    const runner = new MultiAgentRunner();
    const runs: string[] = [];
    runner.registerAgent(makeAgent("planner", ok, runs));
    runner.registerAgent(makeAgent("code", ok, runs));

    const result = await runner.run("build", {
      maxRetries: 3,
      sequence: ["planner", "code"],
    });
    expect(result.success).toBe(true);
    expect(runs).toEqual(["planner", "code"]);
  });
});
