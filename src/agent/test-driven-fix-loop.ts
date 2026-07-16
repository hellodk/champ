/**
 * TestDrivenFixLoop: Autonomous test execution and fixing workflow.
 *
 * Orchestrates:
 * 1. Test discovery in the workspace
 * 2. Automated test execution and result parsing
 * 3. Intelligent fix suggestion via agent when tests fail
 * 4. Iteration until all tests pass or max iterations reached
 *
 * This integrates the existing `run_tests` tool with the agent loop to
 * create a closed-loop development workflow: run tests → detect failures →
 * inject into agent → agent fixes → re-run tests → repeat.
 */
import * as fs from "fs";
import * as path from "path";
import type { AgentControllerLike } from "./auto-fix";

export interface TestResult {
  success: boolean;
  passed: number;
  failed: number;
  skipped: number;
  failedTests: string[];
  duration?: string;
  rawOutput?: string;
}

export interface TestDiscovery {
  testPatterns: string[];
  testFramework: string;
  totalTests?: number;
}

const DEFAULT_MAX_ITERATIONS = 3;
const LSP_SETTLE_DELAY_MS = 500;

export class TestDrivenFixLoop {
  private detectedFramework: string | null = null;

  constructor(
    private readonly agent: AgentControllerLike,
    private readonly toolRegistry: any,
    private readonly workspaceRoot: string,
    private readonly maxIterations: number = DEFAULT_MAX_ITERATIONS,
  ) {}

  /**
   * Discover test files and patterns in the workspace.
   * Returns the test patterns that can be used with run_tests tool.
   */
  async discoverTests(): Promise<string[]> {
    const framework = this.detectTestFramework();
    this.detectedFramework = framework;

    // Return common patterns for the detected framework
    const patterns: Record<string, string[]> = {
      vitest: ["test/unit", "test/integration", "src/**/__tests__"],
      jest: ["__tests__", "test"],
      pytest: ["tests/", "test_"],
      "go-test": ["./..."],
      "cargo-test": ["tests/"],
    };

    return patterns[framework] || [];
  }

  /**
   * Get test patterns filtered by a specific category (e.g., "unit", "integration").
   */
  async getTestPatterns(category: string): Promise<string[]> {
    const allPatterns = await this.discoverTests();
    return allPatterns.filter((p) => p.includes(category));
  }

  /**
   * Detect the test framework used in the workspace.
   */
  private detectTestFramework(): string {
    const pkgPath = path.join(this.workspaceRoot, "package.json");

    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          devDependencies?: Record<string, string>;
          dependencies?: Record<string, string>;
        };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (deps?.vitest) return "vitest";
        if (deps?.jest) return "jest";
      } catch {
        // ignore parse errors
      }
    }

    if (fs.existsSync(path.join(this.workspaceRoot, "pytest.ini"))) {
      return "pytest";
    }
    if (fs.existsSync(path.join(this.workspaceRoot, "go.mod"))) {
      return "go-test";
    }
    if (fs.existsSync(path.join(this.workspaceRoot, "Cargo.toml"))) {
      return "cargo-test";
    }

    // Default to vitest for Node.js projects
    return "vitest";
  }

  /**
   * Execute the test suite and return structured results.
   */
  async runTests(pattern?: string): Promise<TestResult> {
    if (!this.agent.isActiveSession()) {
      return this.emptyTestResult();
    }

    try {
      const toolResult = await this.toolRegistry.execute("run_tests", {
        pattern: pattern,
        timeout_seconds: 120,
      });

      return this.parseTestResult(toolResult);
    } catch (err) {
      return {
        success: false,
        passed: 0,
        failed: 0,
        skipped: 0,
        failedTests: [],
        rawOutput: `Error executing tests: ${String(err)}`,
      };
    }
  }

  /**
   * Parse the test tool's result into a structured TestResult.
   */
  private parseTestResult(toolResult: any): TestResult {
    const output = toolResult?.output ?? "";
    const success = toolResult?.success ?? false;

    // Extract test counts from output using common patterns
    const passMatch = output.match(/(\d+)\s+passed/i);
    const failMatch = output.match(/(\d+)\s+failed/i);
    const skipMatch = output.match(/(\d+)\s+skipped/i);

    const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
    const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
    const skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;

    // Extract failed test names
    const failedTests = this.extractFailedTests(output);

    // Extract duration
    const durationMatch = output.match(/(\d+\.?\d*)\s*s(?:\s|$)/);
    const duration = durationMatch ? `${durationMatch[1]}s` : undefined;

    return {
      success,
      passed,
      failed,
      skipped,
      failedTests,
      duration,
      rawOutput: output,
    };
  }

  /**
   * Extract failed test names from test output.
   */
  private extractFailedTests(output: string): string[] {
    const patterns = [
      /FAILED\s+(.+?)(?:\s+-|$)/gm, // pytest format
      /×\s+(.+?)(?:\n|$)/gm, // vitest format
      /✕\s+(.+?)(?:\n|$)/gm, // jest format
      /^---\s+FAIL:\s+(\S+)/gm, // go test format
    ];

    const tests = new Set<string>();
    for (const pattern of patterns) {
      const matches = output.matchAll(pattern);
      for (const match of matches) {
        const testName = match[1]?.trim();
        if (testName) tests.add(testName);
      }
    }

    return Array.from(tests);
  }

  /**
   * Run the autonomous fix loop: execute tests, inject failures into agent,
   * run agent, repeat until tests pass or max iterations reached.
   */
  async runFixLoop(): Promise<TestResult> {
    if (!this.agent.isActiveSession()) {
      return this.emptyTestResult();
    }

    let result = await this.runTests();

    for (let attempt = 1; attempt <= this.maxIterations; attempt++) {
      if (result.success) {
        // All tests passed
        this.agent.postMessageToUI({
          type: "success",
          message: `✅ All tests passed! (${result.passed} passed in ${result.duration || "unknown"})`,
        });
        return result;
      }

      if (result.failed === 0 && result.passed === 0) {
        // No test results found
        this.agent.postMessageToUI({
          type: "warning",
          message:
            "⚠️ No test results found. Check your test configuration.",
        });
        return result;
      }

      // Inject failures into agent
      const failureContext = this.formatTestFailures(result, attempt);
      await this.agent.injectSystemMessage(
        `Test failures detected (attempt ${attempt}/${this.maxIterations}):\n\n${failureContext}\n\nPlease fix the failing tests.`,
      );

      // Run agent loop to attempt fixes
      await this.agent.runAgentLoop();

      // Give tools/LSP a moment to settle before re-running tests
      await new Promise((resolve) => setTimeout(resolve, LSP_SETTLE_DELAY_MS));

      // Re-run tests
      result = await this.runTests();
    }

    // All iterations exhausted
    this.agent.postMessageToUI({
      type: "warning",
      message: `⚠️ Fix loop reached max iterations (${this.maxIterations}). ${result.failed} test(s) still failing.`,
    });

    return result;
  }

  /**
   * Format test failures into a concise context string for the agent.
   */
  private formatTestFailures(result: TestResult, attempt: number): string {
    const lines: string[] = [];

    lines.push(`Failed Tests: ${result.failed} / ${result.passed + result.failed}`);
    lines.push(`Skipped: ${result.skipped}`);

    if (result.failedTests.length > 0) {
      lines.push("", "Tests that need fixing:");
      result.failedTests.slice(0, 10).forEach((t) => lines.push(`  • ${t}`));
      if (result.failedTests.length > 10) {
        lines.push(`  … and ${result.failedTests.length - 10} more`);
      }
    }

    if (result.rawOutput) {
      // Include the last few lines of output for debugging
      const outputLines = result.rawOutput.split("\n");
      const tail = outputLines.slice(-5).filter((l) => l.trim());
      if (tail.length > 0) {
        lines.push("", "Output tail:", ...tail);
      }
    }

    return lines.join("\n");
  }

  /**
   * Generate a human-readable report of test results.
   */
  generateReport(result: TestResult): string {
    const lines: string[] = [];

    const status = result.success ? "✅ PASSED" : "❌ FAILED";
    lines.push(`${status} — Test Results`);
    lines.push("─".repeat(40));

    lines.push(
      `Passed:  ${result.passed}`,
      `Failed:  ${result.failed}`,
      `Skipped: ${result.skipped}`,
    );

    if (result.duration) {
      lines.push(`Duration: ${result.duration}`);
    }

    if (result.failedTests.length > 0) {
      lines.push("", "Failed Tests:");
      result.failedTests.forEach((t) => lines.push(`  • ${t}`));
    }

    return lines.join("\n");
  }

  /**
   * Return an empty/neutral test result.
   */
  private emptyTestResult(): TestResult {
    return {
      success: false,
      passed: 0,
      failed: 0,
      skipped: 0,
      failedTests: [],
    };
  }
}
