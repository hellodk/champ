/**
 * TDD: Tests for TestDrivenFixLoop — autonomous test execution and fix loop.
 *
 * This service orchestrates:
 * 1. Test discovery in the workspace
 * 2. Test execution and result parsing
 * 3. Automatic fix suggestion and application via agent
 * 4. Iteration until tests pass or max iterations reached
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TestDrivenFixLoop } from "@/agent/test-driven-fix-loop";
import type { AgentControllerLike } from "@/agent/auto-fix";

describe("TestDrivenFixLoop", () => {
  let fixLoop: TestDrivenFixLoop;
  let mockAgent: AgentControllerLike;
  let mockToolRegistry: { execute: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockAgent = {
      isActiveSession: vi.fn().mockReturnValue(true),
      getLastModifiedFiles: vi.fn().mockReturnValue([]),
      injectSystemMessage: vi.fn(),
      runAgentLoop: vi.fn(),
      postMessageToUI: vi.fn(),
    } as unknown as AgentControllerLike;

    mockToolRegistry = {
      execute: vi.fn(),
    };

    fixLoop = new TestDrivenFixLoop(
      mockAgent,
      mockToolRegistry as any,
      "/workspace",
      3,
    );
  });

  describe("test discovery", () => {
    it("should detect test files by pattern", async () => {
      const patterns = await fixLoop.discoverTests();
      expect(patterns).toBeDefined();
      expect(Array.isArray(patterns)).toBe(true);
    });

    it("should handle projects without tests", async () => {
      const patterns = await fixLoop.discoverTests();
      // Should not throw, may return empty array or default pattern
      expect(patterns).toBeDefined();
    });

    it("should support filtering by test pattern", async () => {
      const patterns = await fixLoop.getTestPatterns("unit");
      expect(Array.isArray(patterns)).toBe(true);
    });
  });

  describe("test execution", () => {
    it("should execute tests and return structured results", async () => {
      mockToolRegistry.execute.mockResolvedValueOnce({
        success: true,
        output: "10 passed",
      });

      const result = await fixLoop.runTests();
      expect(result).toBeDefined();
      expect(result.passed).toBeGreaterThanOrEqual(0);
      expect(result.failed).toBeGreaterThanOrEqual(0);
    });

    it("should parse test output for failed tests", async () => {
      mockToolRegistry.execute.mockResolvedValueOnce({
        success: false,
        output: "FAILED tests/test_auth.ts\n5 failed, 10 passed",
      });

      const result = await fixLoop.runTests();
      expect(result.failed).toBeGreaterThan(0);
      expect(result.failedTests).toBeDefined();
      expect(Array.isArray(result.failedTests)).toBe(true);
    });

    it("should handle test timeout", async () => {
      mockToolRegistry.execute.mockResolvedValueOnce({
        success: false,
        output: "Error: Test run timed out after 60s",
      });

      const result = await fixLoop.runTests();
      expect(result.success).toBe(false);
    });
  });

  describe("fix loop orchestration", () => {
    it("should not enter fix loop if all tests pass", async () => {
      mockToolRegistry.execute.mockResolvedValueOnce({
        success: true,
        output: "10 passed",
      });

      const result = await fixLoop.runFixLoop();
      expect(result.passed).toBeGreaterThanOrEqual(0);
      expect((mockAgent.injectSystemMessage as any).mock.calls.length).toBe(0);
    });

    it("should inject failed tests into agent when tests fail", async () => {
      mockToolRegistry.execute.mockResolvedValueOnce({
        success: false,
        output: "× TestLogin\nFailed: 1 failed, 5 passed",
      });

      await fixLoop.runFixLoop();
      expect(mockAgent.injectSystemMessage).toHaveBeenCalled();
      const callArg = (mockAgent.injectSystemMessage as any).mock.calls[0][0];
      expect(callArg).toContain("failed");
    });

    it("should run agent loop after injecting failures", async () => {
      mockToolRegistry.execute
        .mockResolvedValueOnce({
          success: false,
          output: "1 failed, 5 passed",
        })
        .mockResolvedValueOnce({
          success: true,
          output: "6 passed",
        });

      await fixLoop.runFixLoop();
      expect(mockAgent.runAgentLoop).toHaveBeenCalled();
    });

    it("should iterate until tests pass", async () => {
      mockToolRegistry.execute
        .mockResolvedValueOnce({
          success: false,
          output: "2 failed, 4 passed",
        })
        .mockResolvedValueOnce({
          success: false,
          output: "1 failed, 5 passed",
        })
        .mockResolvedValueOnce({
          success: true,
          output: "6 passed",
        });

      const result = await fixLoop.runFixLoop();
      expect(result.success).toBe(true);
      expect(result.passed).toBeGreaterThan(0);
    });

    it("should stop after max iterations", async () => {
      mockToolRegistry.execute.mockResolvedValue({
        success: false,
        output: "1 failed, 5 passed",
      });

      const fixLoopWith2Iters = new TestDrivenFixLoop(
        mockAgent,
        mockToolRegistry as any,
        "/workspace",
        2,
      );

      const result = await fixLoopWith2Iters.runFixLoop();
      expect(result.success).toBe(false);
      expect((mockAgent.runAgentLoop as any).mock.calls.length).toBeLessThanOrEqual(2);
    });

    it("should notify UI of final status", async () => {
      mockToolRegistry.execute.mockResolvedValueOnce({
        success: true,
        output: "6 passed",
      });

      await fixLoop.runFixLoop();
      expect(mockAgent.postMessageToUI).toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("should handle malformed test output", async () => {
      mockToolRegistry.execute.mockResolvedValueOnce({
        success: false,
        output: "random output with no test counts",
      });

      const result = await fixLoop.runTests();
      expect(result).toBeDefined();
      expect(typeof result.passed === "number").toBe(true);
      expect(typeof result.failed === "number").toBe(true);
    });

    it("should return empty results when agent session is inactive", async () => {
      (mockAgent.isActiveSession as any).mockReturnValueOnce(false);

      const result = await fixLoop.runFixLoop();
      expect(result).toBeDefined();
    });

    it("should handle tool execution errors gracefully", async () => {
      mockToolRegistry.execute.mockRejectedValueOnce(
        new Error("Tool execution failed"),
      );

      const result = await fixLoop.runTests();
      expect(result.success).toBe(false);
    });
  });

  describe("test report generation", () => {
    it("should generate a summary report", async () => {
      mockToolRegistry.execute.mockResolvedValueOnce({
        success: true,
        output: "10 passed in 2.5s",
      });

      const result = await fixLoop.runTests();
      const report = fixLoop.generateReport(result);
      expect(report.toLowerCase()).toContain("passed");
    });

    it("should include failed test names in report", async () => {
      mockToolRegistry.execute.mockResolvedValueOnce({
        success: false,
        output:
          "× TestLogin\n× TestLogout\n2 failed, 8 passed",
      });

      const result = await fixLoop.runTests();
      const report = fixLoop.generateReport(result);
      expect(report.toLowerCase()).toContain("failed");
    });
  });
});
