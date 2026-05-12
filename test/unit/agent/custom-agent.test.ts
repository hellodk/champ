import { describe, it, expect, vi } from "vitest";
import { CustomAgent } from "@/agent/agents/custom-agent";
import { SharedMemory } from "@/agent/shared-memory";
import type { LLMProvider } from "@/providers/types";

function makeProvider(response: string): LLMProvider {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: "text" as const, text: response };
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }),
    modelInfo: () => ({
      id: "test",
      name: "test",
      contextWindow: 4096,
      supportsImages: false,
    }),
    countTokens: (s: string) => s.length,
    supportsToolUse: () => false,
  } as unknown as LLMProvider;
}

describe("CustomAgent", () => {
  it("executes and returns success with LLM text", async () => {
    const agent = new CustomAgent(
      { name: "my-agent", role: "does stuff", systemPrompt: "Analyze." },
      makeProvider("Analysis complete."),
    );
    const memory = new SharedMemory();
    const result = await agent.execute(
      { userRequest: "analyze this", context: [] },
      memory,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("Analysis complete");
  });

  it("stores output in memory under outputKey when specified", async () => {
    const agent = new CustomAgent(
      {
        name: "checker",
        role: "checks",
        systemPrompt: "Check.",
        outputKey: "check_result",
      },
      makeProvider("Done"),
    );
    const memory = new SharedMemory();
    await agent.execute({ userRequest: "check this", context: [] }, memory);
    expect(memory.getOutput("check_result")).toBeDefined();
  });

  it("stores output under name when outputKey is not specified", async () => {
    const agent = new CustomAgent(
      { name: "my-checker", role: "checks", systemPrompt: "Check." },
      makeProvider("Done"),
    );
    const memory = new SharedMemory();
    await agent.execute({ userRequest: "check", context: [] }, memory);
    expect(memory.getOutput("my-checker")).toBeDefined();
  });

  it("sets success: false when LLM returns error delta", async () => {
    const provider = {
      chat: vi.fn().mockImplementation(async function* () {
        yield { type: "error" as const, error: "LLM failed" };
        yield {
          type: "done" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }),
      modelInfo: () => ({
        id: "t",
        name: "t",
        contextWindow: 4096,
        supportsImages: false,
      }),
      countTokens: (s: string) => s.length,
      supportsToolUse: () => false,
    } as unknown as LLMProvider;

    const agent = new CustomAgent(
      { name: "fail-agent", role: "fails", systemPrompt: "Fail." },
      provider,
    );
    const memory = new SharedMemory();
    const result = await agent.execute(
      { userRequest: "test", context: [] },
      memory,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("LLM failed");
  });
});
