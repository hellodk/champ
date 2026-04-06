/**
 * TDD: Tests for PlannerAgent.
 * Breaks user requests into structured execution plans.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PlannerAgent } from "@/agent/agents/planner-agent";
import { SharedMemory } from "@/agent/shared-memory";
import type { LLMProvider } from "@/providers/types";

describe("PlannerAgent", () => {
  let agent: PlannerAgent;
  let mockProvider: LLMProvider;
  let memory: SharedMemory;

  beforeEach(() => {
    mockProvider = {
      name: "mock",
      config: {
        provider: "mock",
        model: "test",
        maxTokens: 1024,
        temperature: 0.7,
      },
      chat: vi.fn().mockImplementation(async function* () {
        yield {
          type: "text",
          text: JSON.stringify({
            steps: [
              {
                step: 1,
                description: "Read main.ts",
                targetFiles: ["main.ts"],
                actionType: "read",
              },
              {
                step: 2,
                description: "Fix the bug",
                targetFiles: ["main.ts"],
                actionType: "write",
              },
              {
                step: 3,
                description: "Run tests",
                targetFiles: [],
                actionType: "run",
              },
            ],
          }),
        };
        yield { type: "done", usage: { inputTokens: 50, outputTokens: 30 } };
      }),
      complete: vi.fn(),
      supportsToolUse: () => true,
      supportsStreaming: () => true,
      countTokens: () => 10,
      modelInfo: () => ({
        id: "test",
        name: "Test",
        provider: "mock",
        contextWindow: 4096,
        maxOutputTokens: 1024,
        supportsToolUse: true,
        supportsImages: false,
        supportsStreaming: true,
      }),
      dispose: vi.fn(),
    } as unknown as LLMProvider;

    memory = new SharedMemory();
    agent = new PlannerAgent(mockProvider);
  });

  it("should have correct name and role", () => {
    expect(agent.name).toBe("planner");
    expect(agent.role).toContain("plan");
  });

  it("should produce a structured plan from user request", async () => {
    const result = await agent.execute(
      { userRequest: "Fix the null pointer bug in main.ts", context: [] },
      memory,
    );

    expect(result.success).toBe(true);
    expect(result.plan).toBeDefined();
    expect(result.plan!.steps).toHaveLength(3);
    expect(result.plan!.steps[0].actionType).toBe("read");
  });

  it("should store plan in shared memory", async () => {
    await agent.execute({ userRequest: "Fix bug", context: [] }, memory);

    expect(memory.getOutput("planner")).toBeDefined();
  });

  it("should handle LLM failure gracefully", async () => {
    (mockProvider.chat as ReturnType<typeof vi.fn>).mockImplementation(
      async function* () {
        yield { type: "error", error: "Rate limited" };
      },
    );

    const result = await agent.execute(
      { userRequest: "Fix bug", context: [] },
      memory,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
