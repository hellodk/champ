/**
 * Budget enforcement is wired into the agent loop using actual provider usage.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentController } from "@/agent/agent-controller";
import { ToolRegistry } from "@/tools/registry";
import { BudgetEnforcer } from "@/config/budget";
import type { LLMProvider, StreamDelta } from "@/providers/types";

function provider(usage: {
  inputTokens: number;
  outputTokens: number;
}): LLMProvider {
  let calls = 0;
  return {
    name: "openai",
    config: {
      provider: "openai",
      model: "gpt-4o",
      maxTokens: 10,
      temperature: 0,
    },
    chat: vi.fn().mockImplementation(async function* () {
      calls++;
      yield { type: "done", usage } as StreamDelta;
    }),
    complete: vi.fn(),
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: () => 0,
    modelInfo: () => ({
      id: "gpt-4o",
      name: "gpt-4o",
      provider: "openai",
      contextWindow: 8192,
      maxOutputTokens: 10,
      supportsToolUse: false,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: vi.fn(),
    get calls() {
      return calls;
    },
  } as unknown as LLMProvider;
}

describe("agent budget integration", () => {
  it("blocks the next call once actual usage has exhausted the per-run budget", async () => {
    const llm = provider({ inputTokens: 5, outputTokens: 5 });
    const controller = new AgentController(llm, new ToolRegistry());
    const errors: string[] = [];
    controller.onStreamDelta((d) => {
      if (d.type === "error") errors.push(d.error);
    });
    const budget = new BudgetEnforcer({ maxTokensPerRun: 5 });
    await controller.processMessage("first", { budget });
    // 10 actual tokens recorded; the budget is 5. The next turn must not
    // reach the provider again.
    await controller.processMessage("second", { budget });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(errors.join(" ")).toMatch(/budget/i);
  });

  it("uses a controller-level budget when no per-call budget is supplied", async () => {
    const llm = provider({ inputTokens: 5, outputTokens: 5 });
    const controller = new AgentController(llm, new ToolRegistry());
    const errors: string[] = [];
    controller.onStreamDelta((d) => {
      if (d.type === "error") errors.push(d.error);
    });
    controller.setBudget(new BudgetEnforcer({ maxTokensPerRun: 5 }));
    await controller.processMessage("first");
    await controller.processMessage("second");
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(errors.join(" ")).toMatch(/budget/i);
  });

  it("records actual usage after a successful call", async () => {
    const llm = provider({ inputTokens: 5, outputTokens: 5 });
    const controller = new AgentController(llm, new ToolRegistry());
    const budget = new BudgetEnforcer({ maxTokensPerRun: 100 });
    await controller.processMessage("hello", { budget });
    const snapshot = budget.snapshot();
    expect(snapshot.run.inputTokens).toBe(5);
    expect(snapshot.run.outputTokens).toBe(5);
  });
});
