/**
 * Unit tests for the headless `champ` CLI argument parser — issue #136.
 *
 * Covers mode detection (one-shot vs REPL vs stdin-pipe), flag parsing in
 * both `--flag value` and `--flag=value` form, validation errors, and the
 * guarantee that the CLI path never imports `vscode`.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseCliArgs, USAGE, type CliParseResult } from "@/cli/args";

/** Parse with a TTY stdin and an explicit cwd so tests are deterministic. */
function parse(argv: string[], stdinIsTTY = true): CliParseResult {
  return parseCliArgs(argv, { stdinIsTTY, cwd: "/tmp/ws" });
}

/** Assert parsing succeeded and return the run options. */
function run(result: CliParseResult) {
  if (result.kind !== "run") {
    throw new Error(`expected a run result, got ${JSON.stringify(result)}`);
  }
  return result.options;
}

describe("cli arg parser — informational flags", () => {
  it("returns help for --help and -h", () => {
    expect(parse(["--help"]).kind).toBe("help");
    expect(parse(["-h"]).kind).toBe("help");
  });

  it("returns version for --version and -v", () => {
    expect(parse(["--version"]).kind).toBe("version");
    expect(parse(["-v"]).kind).toBe("version");
  });

  it("prefers help/version over a task", () => {
    expect(parse(["do things", "--help"]).kind).toBe("help");
    expect(parse(["do things", "-v"]).kind).toBe("version");
  });

  it("copies the usage text for error reporting", () => {
    expect(USAGE).toContain('champ "<task>"');
    expect(USAGE).toContain("--max-iter");
    expect(USAGE).toContain("--session <id>");
    expect(USAGE).toContain("--sessions");
    expect(USAGE).toContain("Interactive REPL");
  });
});

describe("cli arg parser — mode detection", () => {
  it("runs a task as one-shot when arguments are present", () => {
    const opts = run(parse(["fix the tests"]));
    expect(opts.mode).toBe("oneshot");
    expect(opts.task).toBe("fix the tests");
  });

  it("joins multiple positional arguments into one task", () => {
    const opts = run(parse(["fix", "the", "tests"]));
    expect(opts.mode).toBe("oneshot");
    expect(opts.task).toBe("fix the tests");
  });

  it("prefers an explicit task over piped stdin", () => {
    const opts = run(parse(["do this"], false));
    expect(opts.mode).toBe("oneshot");
    expect(opts.task).toBe("do this");
  });

  it("selects the REPL when stdin is a terminal and no task is given", () => {
    const opts = run(parse([]));
    expect(opts.mode).toBe("repl");
    expect(opts.task).toBeUndefined();
  });

  it("selects stdin mode when stdin is piped", () => {
    const opts = run(parse([], false));
    expect(opts.mode).toBe("stdin");
  });

  it("selects stdin mode for an explicit `-` even on a terminal", () => {
    const opts = run(parse(["-"]));
    expect(opts.mode).toBe("stdin");
  });

  it("treats a bare `-` as the stdin marker, never as task text", () => {
    const opts = run(parse(["list", "files", "-"]));
    expect(opts.mode).toBe("oneshot");
    expect(opts.task).toBe("list files");
  });

  it("forces the REPL with --repl / -r even when stdin is piped", () => {
    const piped = run(parse(["--repl"], false));
    expect(piped.mode).toBe("repl");
    expect(piped.task).toBeUndefined();
    expect(run(parse(["-r"])).mode).toBe("repl");
    expect(run(parse(["--repl"])).flags.repl).toBe(true);
  });

  it("rejects --repl combined with a task or stdin marker", () => {
    expect(parse(["--repl", "do it"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("cannot combine --repl with a task"),
    });
    expect(parse(["--repl", "-"])).toMatchObject({ kind: "error" });
  });
});

describe("cli arg parser — flags", () => {
  it("parses the boolean --yes / -y flag", () => {
    expect(run(parse(["task", "--yes"])).flags.yes).toBe(true);
    expect(run(parse(["task", "-y"])).flags.yes).toBe(true);
    expect(run(parse(["task"])).flags.yes).toBe(false);
  });

  it("parses --cwd with a separate value", () => {
    expect(run(parse(["--cwd", "/work", "task"])).flags.cwd).toBe("/work");
  });

  it("parses --flag=value form", () => {
    const opts = run(
      parse([
        "--cwd=/other",
        "--model=qwen",
        "--base-url=http://127.0.0.1:8000/v1",
        "--api-key=secret",
        "--provider=openai-compatible",
        "task",
      ]),
    );
    expect(opts.flags.cwd).toBe("/other");
    expect(opts.flags.model).toBe("qwen");
    expect(opts.flags.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(opts.flags.apiKey).toBe("secret");
    expect(opts.flags.provider).toBe("openai-compatible");
    expect(opts.mode).toBe("oneshot");
    expect(opts.task).toBe("task");
  });

  it("defaults cwd to the current directory when unset", () => {
    const result = parseCliArgs([], { stdinIsTTY: true });
    expect(run(result).flags.cwd).toBe(process.cwd());
  });

  it("parses --max-iter as a positive integer", () => {
    expect(run(parse(["--max-iter", "7", "task"])).flags.maxIterations).toBe(7);
  });

  it("rejects a non-numeric or non-positive --max-iter", () => {
    expect(parse(["--max-iter", "abc"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--max-iter must be a positive integer"),
    });
    expect(parse(["--max-iter", "0"])).toMatchObject({ kind: "error" });
    expect(parse(["--max-iter", "-3"])).toMatchObject({ kind: "error" });
  });

  it("still parses flags that follow the task", () => {
    const opts = run(parse(["the task", "--yes"]));
    expect(opts.task).toBe("the task");
    expect(opts.flags.yes).toBe(true);
  });
});

describe("cli arg parser — errors", () => {
  it("reports a missing flag value with the usage text", () => {
    expect(parse(["--model"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Missing value for --model"),
    });
    expect(parse(["--model"])).toMatchObject({
      message: expect.stringContaining("champ — headless Champ agent CLI"),
    });
  });

  it("reports an unknown option with the usage text", () => {
    expect(parse(["--nope", "task"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Unknown option: --nope"),
    });
    expect(parse(["-z"])).toMatchObject({
      message: expect.stringContaining("Unknown option: -z"),
    });
  });

  it("stops flag parsing at `--`", () => {
    const opts = run(parse(["--", "--not-a-flag", "also not one"]));
    expect(opts.task).toBe("--not-a-flag also not one");
    expect(opts.flags.cwd).toBe("/tmp/ws");
  });
});

describe("cli arg parser — sessions (issue #72)", () => {
  it("parses --session with a separate value", () => {
    const opts = run(parse(["--session", "sess-abc", "task"]));
    expect(opts.flags.session).toBe("sess-abc");
    expect(opts.mode).toBe("oneshot");
    expect(opts.task).toBe("task");
  });

  it("parses --session=value form", () => {
    expect(run(parse(["--session=sess-1.2_x", "--repl"])).flags.session).toBe(
      "sess-1.2_x",
    );
  });

  it("rejects ids that could escape the sessions directory", () => {
    for (const bad of ["../etc/passwd", "a/b", "..", ".", ""]) {
      expect(
        parse(["--session", bad, "task"]),
        `id ${JSON.stringify(bad)}`,
      ).toMatchObject({
        kind: "error",
        message: expect.stringContaining("invalid session id"),
      });
    }
  });

  it("returns a sessions result for --sessions", () => {
    expect(parse(["--sessions"])).toMatchObject({ kind: "sessions" });
    expect(parse(["--sessions", "--cwd", "/elsewhere"])).toMatchObject({
      kind: "sessions",
      cwd: "/elsewhere",
    });
  });

  it("rejects --sessions combined with work or --repl", () => {
    expect(parse(["--sessions", "task"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("cannot combine --sessions with a task"),
    });
    expect(parse(["--sessions", "-"])).toMatchObject({ kind: "error" });
    expect(parse(["--sessions", "--repl"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("cannot combine --sessions with --repl"),
    });
  });

  it("leaves sessions off for ordinary runs", () => {
    const opts = run(parse(["task"]));
    expect(opts.flags.session).toBeUndefined();
    expect(opts.flags.listSessions).toBe(false);
  });
});

describe("cli entry — no vscode on the CLI path (issue #136)", () => {
  it("never imports the vscode API", () => {
    const sources = [
      "src/cli.ts",
      "src/cli/args.ts",
      "src/tools/headless/index.ts",
      "src/tools/headless/fs-tools.ts",
      "src/providers/factory.ts",
      "src/session/session-log.ts",
      "src/session/ids.ts",
    ];
    const forbidden =
      /from\s+["']vscode["']|require\(["']vscode["']\)|import\(["']vscode["']\)/;
    for (const rel of sources) {
      const text = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(text, `${rel} must not import vscode`).not.toMatch(forbidden);
    }
  });
});
