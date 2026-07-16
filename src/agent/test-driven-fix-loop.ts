/**
 * TestDrivenFixLoop: Autonomous test-driven fix orchestration.
 *
 * This service orchestrates an autonomous loop that:
 * 1. Runs the test suite
 * 2. Analyzes test failures
 * 3. Automatically generates and applies code fixes
 * 4. Re-runs tests to verify fixes work
 * 5. Iterates until all tests pass or max iterations reached
 *
 * The loop provides clear output of each iteration's results and
 * halts gracefully when tests pass or when iteration limit is reached.
 */

export interface TestFailure {
  testName: string;
  message: string;
  file: string;
  line: number;
}

export interface TestResult {
  passed: boolean;
  failures: TestFailure[];
  output: string;
}

export interface CodeChange {
  file: string;
  oldCode: string;
  newCode: string;
}

export interface FixProposal {
  description: string;
  changes: CodeChange[];
}

export interface FixIteration {
  number: number;
  testResult: TestResult;
  fix?: FixProposal;
  applied: boolean;
  timestamp: Date;
}

export interface FixLoopResult {
  success: boolean;
  iterations: FixIteration[];
  reason?: "max_iterations_reached" | "no_tests_found";
}

export interface TestDrivenFixLoopConfig {
  testRunner: () => Promise<TestResult>;
  fixGenerator: (failures: TestFailure[]) => Promise<FixProposal>;
  fixApplier: (proposal: FixProposal) => Promise<boolean>;
  logger?: { log: (message: string) => void };
  maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 5;

export class TestDrivenFixLoop {
  private readonly testRunner: () => Promise<TestResult>;
  private readonly fixGenerator: (
    failures: TestFailure[],
  ) => Promise<FixProposal>;
  private readonly fixApplier: (proposal: FixProposal) => Promise<boolean>;
  private readonly logger?: { log: (message: string) => void };
  private readonly maxIterations: number;

  constructor(config: TestDrivenFixLoopConfig) {
    this.testRunner = config.testRunner;
    this.fixGenerator = config.fixGenerator;
    this.fixApplier = config.fixApplier;
    this.logger = config.logger;
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  /**
   * Run the autonomous test-driven fix loop.
   * Returns success when all tests pass, failure when max iterations reached,
   * and handles edge cases gracefully (no tests, all tests pass initially).
   */
  async runLoop(): Promise<FixLoopResult> {
    const iterations: FixIteration[] = [];

    // Initial test run
    const initialResult = await this.testRunner();
    const iteration0: FixIteration = {
      number: 1,
      testResult: initialResult,
      applied: false,
      timestamp: new Date(),
    };
    iterations.push(iteration0);

    // Check if all tests pass initially
    if (initialResult.passed) {
      this.log(`✓ All tests passed on initial run`);
      return {
        success: true,
        iterations,
      };
    }

    // Check if there are no tests
    if (initialResult.failures.length === 0) {
      this.log(`✗ No tests found or test runner failed`);
      return {
        success: false,
        iterations,
        reason: "no_tests_found",
      };
    }

    // Run the fix loop
    for (let i = 1; i < this.maxIterations; i++) {
      const failures =
        iterations[iterations.length - 1]?.testResult.failures || [];

      if (failures.length === 0) {
        // Tests are now passing
        this.log(`✓ All tests passed after ${i} iterations`);
        return {
          success: true,
          iterations,
        };
      }

      this.log(
        `\n[Iteration ${i + 1}/${this.maxIterations}] Analyzing ${failures.length} failures...`,
      );

      // Generate fix
      const fix = await this.fixGenerator(failures);
      this.log(`  Generated fix: ${fix.description}`);

      // Apply fix
      const applied = await this.fixApplier(fix);
      if (!applied) {
        this.log(`  ✗ Failed to apply fix`);
        continue;
      }
      this.log(`  ✓ Applied fix to ${fix.changes.length} file(s)`);

      // Re-run tests
      const testResult = await this.testRunner();
      const iteration: FixIteration = {
        number: i + 1,
        testResult,
        fix,
        applied,
        timestamp: new Date(),
      };
      iterations.push(iteration);

      if (testResult.passed) {
        this.log(`✓ All tests passed!`);
        return {
          success: true,
          iterations,
        };
      }

      this.log(`  Still ${testResult.failures.length} failing test(s)`);
    }

    // Max iterations reached
    this.log(
      `\n✗ Max iterations (${this.maxIterations}) reached. Some tests still failing.`,
    );
    return {
      success: false,
      iterations,
      reason: "max_iterations_reached",
    };
  }

  private log(message: string): void {
    if (this.logger) {
      this.logger.log(message);
    }
  }
}
