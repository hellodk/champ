import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TestDrivenFixLoop,
  TestResult,
} from "../../../src/agent/test-driven-fix-loop";

describe("TestDrivenFixLoop", () => {
  let fixLoop: TestDrivenFixLoop;
  let mockTestRunner: ReturnType<typeof vi.fn>;
  let mockFixGenerator: ReturnType<typeof vi.fn>;
  let mockFixApplier: ReturnType<typeof vi.fn>;
  let mockLogger: { log: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockTestRunner = vi.fn();
    mockFixGenerator = vi.fn();
    mockFixApplier = vi.fn();
    mockLogger = { log: vi.fn() };

    fixLoop = new TestDrivenFixLoop({
      testRunner: mockTestRunner,
      fixGenerator: mockFixGenerator,
      fixApplier: mockFixApplier,
      logger: mockLogger,
      maxIterations: 5,
    });
  });

  describe("runLoop", () => {
    it("should run tests initially", async () => {
      const testResult: TestResult = {
        passed: true,
        failures: [],
        output: "",
      };
      mockTestRunner.mockResolvedValue(testResult);

      await fixLoop.runLoop();

      expect(mockTestRunner).toHaveBeenCalledOnce();
    });

    it("should halt when all tests pass initially", async () => {
      const testResult: TestResult = {
        passed: true,
        failures: [],
        output: "All tests passed",
      };
      mockTestRunner.mockResolvedValue(testResult);

      const result = await fixLoop.runLoop();

      expect(result.success).toBe(true);
      expect(result.iterations).toHaveLength(1);
      expect(mockFixGenerator).not.toHaveBeenCalled();
    });

    it("should successfully fix a seeded bug", async () => {
      // First run: test fails
      const failedTestResult: TestResult = {
        passed: false,
        failures: [
          {
            testName: "should add two numbers correctly",
            message: "Expected 3 but got 5",
            file: "test/sum.test.ts",
            line: 15,
          },
        ],
        output: "FAIL: should add two numbers correctly",
      };

      // Second run: test passes after fix
      const passedTestResult: TestResult = {
        passed: true,
        failures: [],
        output: "All tests passed",
      };

      mockTestRunner
        .mockResolvedValueOnce(failedTestResult)
        .mockResolvedValueOnce(passedTestResult);

      mockFixGenerator.mockResolvedValue({
        description: "Fixed addition operation",
        changes: [
          {
            file: "src/sum.ts",
            oldCode: "return a + b + 2;",
            newCode: "return a + b;",
          },
        ],
      });

      mockFixApplier.mockResolvedValue(true);

      const result = await fixLoop.runLoop();

      expect(result.success).toBe(true);
      expect(result.iterations).toHaveLength(2);
      expect(mockFixGenerator).toHaveBeenCalledOnce();
      expect(mockFixApplier).toHaveBeenCalledOnce();
    });

    it("should handle type errors correctly", async () => {
      const failedTestResult: TestResult = {
        passed: false,
        failures: [
          {
            testName: "type checking",
            message:
              "Argument of type 'string' is not assignable to parameter of type 'number'",
            file: "test/type-check.test.ts",
            line: 8,
          },
        ],
        output: "TS2345: Type error",
      };

      const passedTestResult: TestResult = {
        passed: true,
        failures: [],
        output: "All tests passed",
      };

      mockTestRunner
        .mockResolvedValueOnce(failedTestResult)
        .mockResolvedValueOnce(passedTestResult);

      mockFixGenerator.mockResolvedValue({
        description: "Fixed type error by casting",
        changes: [
          {
            file: "src/handler.ts",
            oldCode: "processNumber(value)",
            newCode: "processNumber(Number(value))",
          },
        ],
      });

      mockFixApplier.mockResolvedValue(true);

      const result = await fixLoop.runLoop();

      expect(result.success).toBe(true);
      expect(mockFixGenerator).toHaveBeenCalled();
    });

    it("should handle logic errors correctly", async () => {
      const failedTestResult: TestResult = {
        passed: false,
        failures: [
          {
            testName: "should return true for even numbers",
            message: "Expected true but got false",
            file: "test/even.test.ts",
            line: 12,
          },
        ],
        output: "FAIL: should return true for even numbers",
      };

      const passedTestResult: TestResult = {
        passed: true,
        failures: [],
        output: "All tests passed",
      };

      mockTestRunner
        .mockResolvedValueOnce(failedTestResult)
        .mockResolvedValueOnce(passedTestResult);

      mockFixGenerator.mockResolvedValue({
        description: "Fixed even number check logic",
        changes: [
          {
            file: "src/math.ts",
            oldCode: "return n % 2 === 1;",
            newCode: "return n % 2 === 0;",
          },
        ],
      });

      mockFixApplier.mockResolvedValue(true);

      const result = await fixLoop.runLoop();

      expect(result.success).toBe(true);
    });

    it("should respect iteration limits and halt", async () => {
      const failedTestResult: TestResult = {
        passed: false,
        failures: [
          {
            testName: "persistent failure",
            message: "This test will always fail",
            file: "test/fail.test.ts",
            line: 1,
          },
        ],
        output: "FAIL",
      };

      mockTestRunner.mockResolvedValue(failedTestResult);
      mockFixGenerator.mockResolvedValue({
        description: "Attempted fix",
        changes: [{ file: "src/fail.ts", oldCode: "x", newCode: "y" }],
      });
      mockFixApplier.mockResolvedValue(true);

      const result = await fixLoop.runLoop();

      expect(result.success).toBe(false);
      expect(result.iterations.length).toBeLessThanOrEqual(5);
      expect(result.reason).toBe("max_iterations_reached");
    });

    it("should halt gracefully when no tests exist", async () => {
      const testResult: TestResult = {
        passed: false,
        failures: [],
        output: "No tests found",
      };
      mockTestRunner.mockResolvedValue(testResult);

      const result = await fixLoop.runLoop();

      expect(result.success).toBe(false);
      expect(result.reason).toBe("no_tests_found");
    });

    it("should halt gracefully when all tests pass initially", async () => {
      const testResult: TestResult = {
        passed: true,
        failures: [],
        output: "10 tests passed",
      };
      mockTestRunner.mockResolvedValue(testResult);

      const result = await fixLoop.runLoop();

      expect(result.success).toBe(true);
      expect(result.iterations).toHaveLength(1);
      expect(result.reason).toBeUndefined();
    });
  });

  describe("iteration output", () => {
    it("should provide clear output of each iteration", async () => {
      const failedTestResult: TestResult = {
        passed: false,
        failures: [
          {
            testName: "test1",
            message: "Error message",
            file: "test/test1.test.ts",
            line: 10,
          },
        ],
        output: "FAIL",
      };

      const passedTestResult: TestResult = {
        passed: true,
        failures: [],
        output: "All tests passed",
      };

      mockTestRunner
        .mockResolvedValueOnce(failedTestResult)
        .mockResolvedValueOnce(passedTestResult);

      mockFixGenerator.mockResolvedValue({
        description: "Fix description",
        changes: [{ file: "src/file.ts", oldCode: "old", newCode: "new" }],
      });

      mockFixApplier.mockResolvedValue(true);

      const result = await fixLoop.runLoop();

      expect(result.iterations).toHaveLength(2);
      expect(result.iterations[0]).toHaveProperty("testResult");
      expect(result.iterations[0]?.testResult?.passed).toBe(false);
      expect(result.iterations[1]).toHaveProperty("testResult");
      expect(result.iterations[1]?.testResult?.passed).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should handle test runner errors gracefully", async () => {
      mockTestRunner.mockRejectedValue(new Error("Test runner crashed"));

      await expect(fixLoop.runLoop()).rejects.toThrow("Test runner crashed");
    });

    it("should handle fix generator errors gracefully", async () => {
      mockTestRunner.mockResolvedValue({
        passed: false,
        failures: [
          { testName: "test", message: "error", file: "test.ts", line: 1 },
        ],
        output: "FAIL",
      });

      mockFixGenerator.mockRejectedValue(new Error("Fix generation failed"));

      await expect(fixLoop.runLoop()).rejects.toThrow("Fix generation failed");
    });

    it("should handle fix applier errors gracefully", async () => {
      mockTestRunner.mockResolvedValue({
        passed: false,
        failures: [
          { testName: "test", message: "error", file: "test.ts", line: 1 },
        ],
        output: "FAIL",
      });

      mockFixGenerator.mockResolvedValue({
        description: "Fix",
        changes: [{ file: "src/file.ts", oldCode: "old", newCode: "new" }],
      });

      mockFixApplier.mockRejectedValue(new Error("Failed to apply fix"));

      await expect(fixLoop.runLoop()).rejects.toThrow("Failed to apply fix");
    });
  });
});
