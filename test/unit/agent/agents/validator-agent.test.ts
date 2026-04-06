/**
 * TDD: Tests for ValidatorAgent.
 * Runs lint, typecheck, tests to validate changes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ValidatorAgent } from "@/agent/agents/validator-agent";
import { SharedMemory } from "@/agent/shared-memory";
import type { ToolRegistry } from "@/tools/registry";

describe("ValidatorAgent", () => {
  let agent: ValidatorAgent;
  let memory: SharedMemory;
  let mockToolRegistry: ToolRegistry;

  beforeEach(() => {
    memory = new SharedMemory();
    memory.setOutput("code", {
      success: true,
      output: "diffs",
      diffs: [
        { filePath: "src/main.ts", oldContent: "old", newContent: "new" },
      ],
    });

    mockToolRegistry = {
      execute: vi
        .fn()
        .mockResolvedValue({ success: true, output: "All checks passed" }),
      get: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      getDefinitions: vi.fn().mockReturnValue([]),
      register: vi.fn(),
      unregister: vi.fn(),
    } as unknown as ToolRegistry;

    agent = new ValidatorAgent(mockToolRegistry);
  });

  it("should have correct name", () => {
    expect(agent.name).toBe("validator");
  });

  it("should run linter and report pass", async () => {
    const result = await agent.execute(
      { userRequest: "Validate", context: [] },
      memory,
    );
    expect(result.success).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("should report failure when lint fails", async () => {
    (mockToolRegistry.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      output: "ESLint: 3 errors found",
    });

    const result = await agent.execute(
      { userRequest: "Validate", context: [] },
      memory,
    );
    expect(result.success).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("error");
  });

  it("should run typecheck", async () => {
    await agent.execute({ userRequest: "Validate", context: [] }, memory);
    expect(mockToolRegistry.execute).toHaveBeenCalled();
  });

  it("should run tests if available", async () => {
    await agent.execute({ userRequest: "Validate", context: [] }, memory);
    // Should attempt to run test command
    const calls = (mockToolRegistry.execute as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
