/**
 * run_tests tool: runs the project's test suite and returns structured results.
 *
 * Auto-detects the test runner (vitest, jest, pytest, go test, cargo test)
 * from workspace files. Returns pass/fail counts, failed test names, and a
 * summary with the last 50 lines of raw output for debugging.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";

const execFileAsync = promisify(execFile);

function detectRunner(workspaceRoot: string): { cmd: string; args: string[] } {
  const pkgPath = path.join(workspaceRoot, "package.json");

  if (fs.existsSync(pkgPath)) {
    let pkg: {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    } = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as typeof pkg;
    } catch {
      // ignore parse errors
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps?.vitest) {
      return { cmd: "npx", args: ["vitest", "run", "--reporter=verbose"] };
    }
    if (deps?.jest) {
      return { cmd: "npx", args: ["jest", "--ci", "--verbose"] };
    }
    if (pkg.scripts?.test) {
      return { cmd: "npm", args: ["test", "--", "--ci"] };
    }
  }

  if (
    fs.existsSync(path.join(workspaceRoot, "pytest.ini")) ||
    fs.existsSync(path.join(workspaceRoot, "pyproject.toml"))
  ) {
    return { cmd: "python", args: ["-m", "pytest", "-v", "--tb=short"] };
  }

  if (fs.existsSync(path.join(workspaceRoot, "go.mod"))) {
    return { cmd: "go", args: ["test", "./..."] };
  }

  if (fs.existsSync(path.join(workspaceRoot, "Cargo.toml"))) {
    return { cmd: "cargo", args: ["test"] };
  }

  return { cmd: "npm", args: ["test"] };
}

interface ParsedCounts {
  passed: number;
  failed: number;
  skipped: number;
  total?: number;
  failedTests: string[];
}

function parseVitestOutput(output: string): ParsedCounts {
  const passMatch = output.match(/(\d+) passed/);
  const failMatch = output.match(/(\d+) failed/);
  const skipMatch = output.match(/(\d+) skipped/);
  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
  const failedTests = [...output.matchAll(/× (.+)/g)].map((m) => m[1].trim());
  return { passed, failed, skipped, failedTests };
}

function parseJestOutput(output: string): ParsedCounts {
  const passMatch = output.match(/(\d+) passed/);
  const failMatch = output.match(/(\d+) failed/);
  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const failedTests = [...output.matchAll(/✕ (.+)/g)].map((m) => m[1].trim());
  return { passed, failed, skipped: 0, failedTests };
}

function parsePytestOutput(output: string): ParsedCounts {
  // Match pytest summary line: "3 failed, 47 passed in 2.31s"
  // or "50 passed in 1.23s" or "3 failed in 0.5s"
  const summaryMatch = output.match(
    /(?:(\d+) failed(?:, )?)?(?:(\d+) passed)?(?:(?:, )?(\d+) skipped)? in [\d.]+s/,
  );
  const failed = summaryMatch?.[1] ? parseInt(summaryMatch[1], 10) : 0;
  const passed = summaryMatch?.[2] ? parseInt(summaryMatch[2], 10) : 0;
  const skipped = summaryMatch?.[3] ? parseInt(summaryMatch[3], 10) : 0;

  // Failed test names from lines like: "FAILED tests/test_auth.py::test_logout - AssertionError"
  const failedTests = [
    ...output.matchAll(/^FAILED (.+?)(?:\s+-\s+.*)?$/gm),
  ].map((m) => m[1].trim());
  return {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    failedTests,
  };
}

function parseGoTestOutput(output: string): ParsedCounts {
  const passed = (output.match(/^--- PASS:/gm) ?? []).length;
  const failed = (output.match(/^--- FAIL:/gm) ?? []).length;
  const failedTests = [...output.matchAll(/^--- FAIL: (\S+)/gm)].map(
    (m) => m[1],
  );
  return { passed, failed, skipped: 0, total: passed + failed, failedTests };
}

function parseCargoTestOutput(output: string): ParsedCounts {
  const summaryMatch = output.match(
    /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/,
  );
  const passed = summaryMatch?.[1] ? parseInt(summaryMatch[1], 10) : 0;
  const failed = summaryMatch?.[2] ? parseInt(summaryMatch[2], 10) : 0;
  const failedTests = [...output.matchAll(/^test (.+) \.\.\. FAILED/gm)].map(
    (m) => m[1],
  );
  return { passed, failed, skipped: 0, total: passed + failed, failedTests };
}

function parseGenericOutput(output: string): ParsedCounts {
  const passed = (output.match(/\bPASS\b|\bok\b/g) ?? []).length;
  const failed = (output.match(/\bFAIL\b|\bFAILED\b/g) ?? []).length;
  return {
    passed,
    failed,
    skipped: 0,
    total: passed + failed,
    failedTests: [],
  };
}

export const runTestsTool: Tool = {
  name: "run_tests",
  description:
    "Run the project's test suite and return structured results. Automatically detects test runner (vitest, jest, pytest, go test, cargo test). Returns pass/fail counts, failed test names, and a summary. Use this after making changes to verify correctness.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Optional: filter tests by pattern/file path (e.g. 'src/auth', 'TestLogin')",
      },
      timeout_seconds: {
        type: "number",
        description: "Timeout in seconds (default: 60)",
      },
    },
    required: [],
  },
  requiresApproval: false,

  getPreview(args: Record<string, unknown>) {
    const pattern = args.pattern as string | undefined;
    const label = pattern
      ? `Run tests matching "${pattern}"`
      : "Run test suite";
    return { type: "command" as const, content: label, label };
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const pattern = args.pattern as string | undefined;
    const timeoutMs =
      ((args.timeout_seconds as number | undefined) ?? 60) * 1000;

    const { cmd, args: cmdArgs } = detectRunner(context.workspaceRoot);
    const fullArgs = pattern ? [...cmdArgs, pattern] : [...cmdArgs];

    const runner = cmd === "npx" ? fullArgs[0] : cmd;

    context.reportProgress(`Running ${runner} tests…\n`);

    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      const result = await execFileAsync(cmd, fullArgs, {
        cwd: context.workspaceRoot,
        timeout: timeoutMs,
        maxBuffer: 512 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        code?: number;
        killed?: boolean;
      };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      exitCode = e.code ?? 1;
      if (e.killed) {
        return {
          success: false,
          output: `Error: Test run timed out after ${timeoutMs / 1000}s`,
        };
      }
    }

    const duration = `${((Date.now() - start) / 1000).toFixed(1)}s`;
    const combined = `${stdout}\n${stderr}`.trim();

    let parsed: ParsedCounts;
    if (runner === "pytest" || runner === "python") {
      parsed = parsePytestOutput(combined);
    } else if (runner === "go") {
      parsed = parseGoTestOutput(combined);
    } else if (runner === "cargo") {
      parsed = parseCargoTestOutput(combined);
    } else if (runner === "vitest") {
      parsed = parseVitestOutput(combined);
    } else if (runner === "jest") {
      parsed = parseJestOutput(combined);
    } else {
      parsed = parseGenericOutput(combined);
    }

    const status = exitCode === 0 ? "PASSED" : "FAILED";
    const lines = [
      `${status} — ${runner} (${duration})`,
      `Tests: ${parsed.passed} passed, ${parsed.failed} failed, ${parsed.skipped} skipped`,
    ];

    if (parsed.failedTests.length > 0) {
      lines.push("", "Failed tests:");
      parsed.failedTests.slice(0, 20).forEach((t) => lines.push(`  x ${t}`));
    }

    // Include last 50 lines of raw output for debugging context
    const rawLines = combined.split("\n");
    const tail = rawLines.slice(-50).join("\n");
    if (tail.trim()) {
      lines.push("", "--- Output (last 50 lines) ---", tail);
    }

    return {
      success: exitCode === 0,
      output: lines.join("\n"),
    };
  },
};
