/**
 * TDD: Tests for AgentOrchestrator.
 * Validates DAG execution, agent coordination, shared memory, retries.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentOrchestrator } from "@/agent/orchestrator";
import type {
  Agent,
  AgentInput,
  AgentOutput,
  SharedMemory,
} from "@/agent/agents/types";

function createMockAgent(
  name: string,
  output: Partial<AgentOutput> = {},
): Agent {
  return {
    name,
    role: `mock-${name}`,
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: `${name} result`,
      ...output,
    }),
  };
}

describe("AgentOrchestrator", () => {
  let orchestrator: AgentOrchestrator;

  beforeEach(() => {
    orchestrator = new AgentOrchestrator();
  });

  it("should execute a linear workflow: planner -> context -> code -> reviewer -> validator", async () => {
    const planner = createMockAgent("planner", {
      plan: [{ step: 1, description: "Edit file", targetFiles: ["main.ts"] }],
    });
    const context = createMockAgent("context", {
      chunks: [
        {
          filePath: "main.ts",
          text: "existing code",
          startLine: 1,
          endLine: 10,
        },
      ],
    });
    const code = createMockAgent("code", {
      diffs: [{ filePath: "main.ts", oldContent: "old", newContent: "new" }],
    });
    const reviewer = createMockAgent("reviewer", { approved: true });
    const validator = createMockAgent("validator", { passed: true });

    orchestrator.registerAgent(planner);
    orchestrator.registerAgent(context);
    orchestrator.registerAgent(code);
    orchestrator.registerAgent(reviewer);
    orchestrator.registerAgent(validator);

    const result = await orchestrator.executeWorkflow(
      "Fix the bug in main.ts",
      ["planner", "context", "code", "reviewer", "validator"],
    );

    expect(result.success).toBe(true);
    expect(planner.execute).toHaveBeenCalled();
    expect(context.execute).toHaveBeenCalled();
    expect(code.execute).toHaveBeenCalled();
    expect(reviewer.execute).toHaveBeenCalled();
    expect(validator.execute).toHaveBeenCalled();
  });

  it("should pass shared memory between agents", async () => {
    const agent1 = createMockAgent("first");
    const agent2: Agent = {
      name: "second",
      role: "mock",
      execute: vi
        .fn()
        .mockImplementation(
          async (_input: AgentInput, memory: SharedMemory) => {
            const firstOutput = memory.getOutput("first");
            return { success: true, output: `Got: ${firstOutput?.output}` };
          },
        ),
    };

    orchestrator.registerAgent(agent1);
    orchestrator.registerAgent(agent2);

    const result = await orchestrator.executeWorkflow("Test", [
      "first",
      "second",
    ]);
    expect(result.success).toBe(true);
    expect(agent2.execute).toHaveBeenCalled();
  });

  it("should retry on agent failure", async () => {
    let attempts = 0;
    const flaky: Agent = {
      name: "flaky",
      role: "mock",
      execute: vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3)
          return { success: false, output: "Failed", error: "Temporary error" };
        return { success: true, output: "Succeeded on attempt 3" };
      }),
    };

    orchestrator.registerAgent(flaky);
    const result = await orchestrator.executeWorkflow("Test", ["flaky"], {
      maxRetries: 3,
    });

    expect(result.success).toBe(true);
    expect(attempts).toBe(3);
  });

  it("should fail after max retries exceeded", async () => {
    const alwaysFails: Agent = {
      name: "broken",
      role: "mock",
      execute: vi
        .fn()
        .mockResolvedValue({ success: false, output: "Always fails" }),
    };

    orchestrator.registerAgent(alwaysFails);
    const result = await orchestrator.executeWorkflow("Test", ["broken"], {
      maxRetries: 2,
    });

    expect(result.success).toBe(false);
    expect(alwaysFails.execute).toHaveBeenCalledTimes(2);
  });

  it("should support conditional branching (reviewer rejects -> retry code)", async () => {
    let codeAttempts = 0;
    const code: Agent = {
      name: "code",
      role: "coder",
      execute: vi.fn().mockImplementation(async () => {
        codeAttempts++;
        return {
          success: true,
          output: `Code v${codeAttempts}`,
          diffs: [
            {
              filePath: "test.ts",
              oldContent: "old",
              newContent: `new_v${codeAttempts}`,
            },
          ],
        };
      }),
    };
    let reviewAttempts = 0;
    const reviewer: Agent = {
      name: "reviewer",
      role: "reviewer",
      execute: vi.fn().mockImplementation(async () => {
        reviewAttempts++;
        if (reviewAttempts < 2)
          return {
            success: false,
            output: "Rejected: missing error handling",
            approved: false,
          };
        return { success: true, output: "Approved", approved: true };
      }),
    };

    orchestrator.registerAgent(code);
    orchestrator.registerAgent(reviewer);

    const result = await orchestrator.executeWorkflow(
      "Fix bug",
      ["code", "reviewer"],
      {
        maxRetries: 3,
        retryFrom: { reviewer: "code" }, // on reviewer failure, retry from code
      },
    );

    expect(result.success).toBe(true);
    expect(codeAttempts).toBe(2);
    expect(reviewAttempts).toBe(2);
  });

  it("should collect execution logs for observability", async () => {
    orchestrator.registerAgent(createMockAgent("planner"));
    orchestrator.registerAgent(createMockAgent("code"));

    const result = await orchestrator.executeWorkflow("Test", [
      "planner",
      "code",
    ]);

    expect(result.executionLog).toBeDefined();
    expect(result.executionLog).toHaveLength(2);
    expect(result.executionLog[0].agentName).toBe("planner");
    expect(result.executionLog[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should throw for unregistered agent names", async () => {
    await expect(
      orchestrator.executeWorkflow("Test", ["nonexistent"]),
    ).rejects.toThrow();
  });
});
