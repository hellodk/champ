/**
 * TDD: Tests for CodeAgent.
 * Generates code changes as diffs based on a plan and context.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CodeAgent } from "@/agent/agents/code-agent";
import { SharedMemory } from "@/agent/shared-memory";
import type { LLMProvider } from "@/providers/types";

describe("CodeAgent", () => {
  let agent: CodeAgent;
  let mockProvider: LLMProvider;
  let memory: SharedMemory;

  beforeEach(() => {
    mockProvider = {
      name: "mock",
      config: {
        provider: "mock",
        model: "test",
        maxTokens: 4096,
        temperature: 0.3,
      },
      chat: vi.fn().mockImplementation(async function* () {
        yield {
          type: "text",
          text: JSON.stringify({
            diffs: [
              {
                filePath: "src/main.ts",
                oldContent: "const x = null;",
                newContent: "const x = getDefault();",
              },
            ],
          }),
        };
        yield { type: "done", usage: { inputTokens: 100, outputTokens: 50 } };
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
    memory.setOutput("planner", {
      success: true,
      output: "plan",
      plan: {
        steps: [
          {
            step: 1,
            description: "Fix null",
            targetFiles: ["src/main.ts"],
            actionType: "write",
          },
        ],
      },
    });
    memory.setOutput("context", {
      success: true,
      output: "context",
      chunks: [
        {
          filePath: "src/main.ts",
          text: "const x = null;\nfunction main() {}",
          startLine: 1,
          endLine: 2,
        },
      ],
    });

    agent = new CodeAgent(mockProvider);
  });

  it("should have correct name and role", () => {
    expect(agent.name).toBe("code");
  });

  it("should generate diffs based on plan and context", async () => {
    const result = await agent.execute(
      { userRequest: "Fix null pointer", context: [] },
      memory,
    );

    expect(result.success).toBe(true);
    expect(result.diffs).toBeDefined();
    expect(result.diffs!.length).toBeGreaterThan(0);
    expect(result.diffs![0].filePath).toBe("src/main.ts");
  });

  it("should read plan from shared memory", async () => {
    await agent.execute({ userRequest: "Fix bug", context: [] }, memory);
    expect(mockProvider.chat).toHaveBeenCalled();
  });

  it("should handle LLM failure", async () => {
    (mockProvider.chat as ReturnType<typeof vi.fn>).mockImplementation(
      async function* () {
        yield { type: "error", error: "Out of tokens" };
      },
    );

    const result = await agent.execute(
      { userRequest: "Fix", context: [] },
      memory,
    );
    expect(result.success).toBe(false);
  });
});
