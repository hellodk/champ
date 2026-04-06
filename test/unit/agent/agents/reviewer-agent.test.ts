/**
 * TDD: Tests for ReviewerAgent.
 * Reviews code changes for correctness, style, and safety.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReviewerAgent } from "@/agent/agents/reviewer-agent";
import { SharedMemory } from "@/agent/shared-memory";
import type { LLMProvider } from "@/providers/types";

describe("ReviewerAgent", () => {
  let agent: ReviewerAgent;
  let memory: SharedMemory;

  function createProvider(approved: boolean, feedback = ""): LLMProvider {
    return {
      name: "mock",
      config: {
        provider: "mock",
        model: "test",
        maxTokens: 1024,
        temperature: 0.3,
      },
      chat: vi.fn().mockImplementation(async function* () {
        yield {
          type: "text",
          text: JSON.stringify({
            approved,
            feedback,
            issues: approved
              ? []
              : [{ severity: "error", description: feedback, file: "main.ts" }],
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
  }

  beforeEach(() => {
    memory = new SharedMemory();
    memory.setOutput("code", {
      success: true,
      output: "diffs",
      diffs: [{ filePath: "main.ts", oldContent: "old", newContent: "new" }],
    });
  });

  it("should approve correct changes", async () => {
    agent = new ReviewerAgent(createProvider(true));
    const result = await agent.execute(
      { userRequest: "Review", context: [] },
      memory,
    );

    expect(result.success).toBe(true);
    expect(result.approved).toBe(true);
  });

  it("should reject problematic changes with feedback", async () => {
    agent = new ReviewerAgent(createProvider(false, "Missing null check"));
    const result = await agent.execute(
      { userRequest: "Review", context: [] },
      memory,
    );

    expect(result.success).toBe(false);
    expect(result.approved).toBe(false);
    expect(result.feedback).toContain("Missing null check");
  });

  it("should list specific issues found", async () => {
    agent = new ReviewerAgent(createProvider(false, "Security issue"));
    const result = await agent.execute(
      { userRequest: "Review", context: [] },
      memory,
    );

    expect(result.issues).toBeDefined();
    expect(result.issues!.length).toBeGreaterThan(0);
  });
});
