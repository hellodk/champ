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

describe("champ policy commands", () => {
  it("parses show and validate", () => {
    expect(parse(["policy", "show"])).toEqual({
      kind: "policy-command",
      command: { name: "policy-show" },
      cwd: "/tmp/ws",
    });
    expect(parse(["policy", "validate"])).toEqual({
      kind: "policy-command",
      command: { name: "policy-validate" },
      cwd: "/tmp/ws",
    });
  });

  it("rejects unknown and extra policy arguments", () => {
    expect(parse(["policy", "bogus"]).kind).toBe("error");
    expect(parse(["policy", "show", "extra"]).kind).toBe("error");
  });

  it("documents that headless runs deny approvals without auto-approval", () => {
    expect(USAGE).toMatch(/without\s+auto-approval\s+deny/i);
  });

  it("parses and validates --permission-profile", () => {
    expect(
      run(parse(["task", "--permission-profile", "read-only"])).flags
        .permissionProfile,
    ).toBe("read-only");
    expect(
      run(parse(["task", "--permission-profile=autonomous"])).flags
        .permissionProfile,
    ).toBe("autonomous");
    expect(parse(["task", "--permission-profile", "everything"]).kind).toBe(
      "error",
    );
  });
});

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

  it("parses --json for one-shot runs and rejects interactive modes", () => {
    expect(run(parse(["--json", "do work"])).flags.json).toBe(true);
    expect(USAGE).toContain("--json");
    expect(parse(["--json", "--repl"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--json only supports one-shot"),
    });
    expect(parse(["--json", "--tui"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--json only supports one-shot"),
    });
  });

  it("parses --rpc as a taskless protocol mode", () => {
    expect(run(parse(["--rpc"])).mode).toBe("rpc");
    expect(run(parse(["--rpc"])).flags.rpc).toBe(true);
    expect(USAGE).toContain("champ --rpc");
    expect(parse(["--rpc", "--json"])).toMatchObject({ kind: "error" });
    expect(parse(["--rpc", "--repl"])).toMatchObject({ kind: "error" });
    expect(parse(["--rpc", "do work"])).toMatchObject({ kind: "error" });
    expect(parse(["--rpc", "--sessions"])).toMatchObject({ kind: "error" });
    expect(parse(["--rpc", "provider", "list"])).toMatchObject({
      kind: "error",
    });
  });

  it("copies the usage text for error reporting", () => {
    expect(USAGE).toContain('champ "<task>"');
    expect(USAGE).toContain("--max-iter");
    expect(USAGE).toContain("--session <id>");
    expect(USAGE).toContain("--sessions");
    expect(USAGE).toContain("Full-screen TUI");
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

  it("selects the TUI when stdin is a terminal and no task is given", () => {
    const opts = run(parse([]));
    expect(opts.mode).toBe("tui");
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

  it("starts the full-screen TUI by default on a terminal", () => {
    expect(parseCliArgs([], { stdinIsTTY: true })).toMatchObject({
      kind: "run",
      options: { mode: "tui" },
    });
    expect(parseCliArgs(["--tui"], { stdinIsTTY: true })).toMatchObject({
      kind: "run",
      options: { mode: "tui" },
    });
  });

  it("keeps the line REPL available with --repl", () => {
    expect(parseCliArgs(["--repl"], { stdinIsTTY: true })).toMatchObject({
      kind: "run",
      options: { mode: "repl" },
    });
    expect(
      parseCliArgs(["--tui", "--repl"], { stdinIsTTY: true }),
    ).toMatchObject({
      kind: "error",
    });
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

  it("parses --import-session as an absolute path", () => {
    const opts = run(parse(["--import-session", "old.json"]));
    expect(opts.flags.importSession).toBe("/tmp/ws/old.json");
    expect(run(parse(["--import-session=old.json"])).flags.importSession).toBe(
      "/tmp/ws/old.json",
    );
    expect(USAGE).toContain("--import-session <file>");
  });

  it("rejects an empty --import-session value", () => {
    expect(parse(["--import-session", ""])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--import-session cannot be empty"),
    });
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

describe("cli arg parser — skills and file flags", () => {
  it("parses --skill review and --skill=review", () => {
    expect(run(parse(["--skill", "review"])).flags.skill).toBe("review");
    expect(run(parse(["--skill=review"])).flags.skill).toBe("review");
  });

  it("rejects an invalid skill name", () => {
    expect(parse(["--skill", "123bad"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining(
        '--skill must be a skill name like "review"',
      ),
    });
    expect(parse(["--skill", "../evil"])).toMatchObject({
      kind: "error",
    });
  });

  it("rejects --skill with --repl", () => {
    expect(parse(["--skill", "review", "--repl"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining(
        "--skill cannot be combined with --repl",
      ),
    });
  });

  it("rejects --skill with a leading-slash positional", () => {
    expect(parse(["--skill", "review", "/explain"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining(
        "give the skill either with --skill or /<name>, not both",
      ),
    });
  });

  it("runs --skill with no positional as oneshot even when stdinIsTTY is false", () => {
    const opts = run(parse(["--skill", "review"], false));
    expect(opts.mode).toBe("oneshot");
    expect(opts.task).toBe("");
    expect(opts.flags.skill).toBe("review");
  });

  it("parses --file src/a.ts and --file=src/a.ts", () => {
    expect(run(parse(["--file", "src/a.ts", "task"])).flags.file).toBe(
      "src/a.ts",
    );
    expect(run(parse(["--file=src/a.ts", "task"])).flags.file).toBe("src/a.ts");
  });

  it("returns list-skills for --list-skills", () => {
    expect(parse(["--list-skills"])).toMatchObject({
      kind: "list-skills",
      cwd: "/tmp/ws",
    });
    expect(parse(["--list-skills", "--cwd", "/elsewhere"])).toMatchObject({
      kind: "list-skills",
      cwd: "/elsewhere",
    });
  });

  it("rejects --list-skills with --repl or with a task", () => {
    expect(parse(["--list-skills", "--repl"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining(
        "cannot combine --list-skills with --repl",
      ),
    });
    expect(parse(["--list-skills", "task"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining(
        "cannot combine --list-skills with a task",
      ),
    });
    expect(parse(["--list-skills", "-"])).toMatchObject({ kind: "error" });
  });

  it("sets --no-skills", () => {
    expect(run(parse(["--no-skills", "task"])).flags.noSkills).toBe(true);
    expect(run(parse(["task"])).flags.noSkills).toBe(false);
  });

  it("USAGE contains all four new flags and two new command lines", () => {
    expect(USAGE).toContain("--skill <name>");
    expect(USAGE).toContain("--file <path>");
    expect(USAGE).toContain("--list-skills");
    expect(USAGE).toContain("--no-skills");
    expect(USAGE).toContain("/skills");
    expect(USAGE).toContain("/<skill> [args]");
  });
});

describe("cli arg parser — setup and provider commands", () => {
  it("parses each provider command form cleanly", () => {
    expect(parse(["setup"])).toMatchObject({
      kind: "provider-command",
      command: { name: "setup" },
    });
    expect(parse(["provider", "list"])).toMatchObject({
      kind: "provider-command",
      command: { name: "provider-list" },
    });
    expect(parse(["provider", "add"])).toMatchObject({
      kind: "provider-command",
      command: { name: "provider-add" },
    });
    expect(parse(["provider", "edit", "ep_1"])).toMatchObject({
      kind: "provider-command",
      command: { name: "provider-edit", id: "ep_1" },
    });
    expect(parse(["provider", "remove", "ep_1"])).toMatchObject({
      kind: "provider-command",
      command: { name: "provider-remove", id: "ep_1" },
    });
    expect(parse(["provider", "test", "ep_1"])).toMatchObject({
      kind: "provider-command",
      command: { name: "provider-test", id: "ep_1" },
    });
    expect(parse(["provider", "discover", "ep_1"])).toMatchObject({
      kind: "provider-command",
      command: { name: "provider-discover", id: "ep_1" },
    });
    expect(parse(["models"])).toMatchObject({
      kind: "provider-command",
      command: { name: "models" },
    });
    expect(parse(["models", "--endpoint", "ep_1"])).toMatchObject({
      kind: "provider-command",
      command: { name: "models", id: "ep_1" },
    });
    expect(parse(["models", "refresh", "--endpoint=ep_2"])).toMatchObject({
      kind: "provider-command",
      command: { name: "models-refresh", id: "ep_2" },
    });
    expect(parse(["model", "use", "ep_1/qwen", "--workspace"])).toMatchObject({
      kind: "provider-command",
      command: {
        name: "model-use",
        endpointAndModel: "ep_1/qwen",
        workspace: true,
      },
    });
    expect(parse(["config", "show"])).toMatchObject({
      kind: "provider-command",
      command: { name: "config-show" },
    });
    expect(parse(["config", "validate"])).toMatchObject({
      kind: "provider-command",
      command: { name: "config-validate" },
    });
    expect(parse(["config", "doctor"])).toMatchObject({
      kind: "provider-command",
      command: { name: "config-doctor" },
    });
    expect(parse(["config", "export", "--redact"])).toMatchObject({
      kind: "provider-command",
      command: { name: "config-export", redact: true },
    });
    expect(parse(["config", "export"])).toMatchObject({
      kind: "error",
    });
    expect(parse(["config", "migrate", "--dry-run"])).toMatchObject({
      kind: "provider-command",
      command: { name: "config-migrate", dryRun: true },
    });
    expect(parse(["config", "scrub-secrets", "--dry-run"])).toMatchObject({
      kind: "provider-command",
      command: { name: "config-scrub-secrets", dryRun: true },
    });
    expect(parse(["config", "routing", "manual"])).toMatchObject({
      kind: "provider-command",
      command: { name: "config-routing", mode: "manual" },
    });
    expect(parse(["model", "assign", "coding", "ep_1/qwen"])).toMatchObject({
      kind: "provider-command",
      command: {
        name: "model-assign",
        task: "coding",
        endpointAndModel: "ep_1/qwen",
      },
    });
    expect(parse(["provider", "test", "ep_1", "--inference"])).toMatchObject({
      kind: "provider-command",
      command: { name: "provider-test", id: "ep_1", inference: true },
    });
    expect(parse(["update"])).toMatchObject({
      kind: "update",
      options: { check: false, force: false },
    });
    expect(
      parse([
        "update",
        "--check",
        "--force",
        "--ref",
        "v2.1.0",
        "--repo",
        "https://example.com/champ.git",
        "--prefix",
        "/tmp/npm-global",
      ]),
    ).toMatchObject({
      kind: "update",
      options: {
        check: true,
        force: true,
        ref: "v2.1.0",
        repo: "https://example.com/champ.git",
        prefix: "/tmp/npm-global",
      },
    });
    expect(parse(["update", "--dry-run"])).toMatchObject({
      kind: "update",
      options: { check: true, force: false },
    });
  });

  it('keeps champ "setup the repo" and champ "update the readme" in task mode', () => {
    const setupTask = run(parse(["setup the repo"]));
    expect(setupTask.mode).toBe("oneshot");
    expect(setupTask.task).toBe("setup the repo");

    const updateTask = run(parse(["update the readme"]));
    expect(updateTask.mode).toBe("oneshot");
    expect(updateTask.task).toBe("update the readme");
  });

  it("rejects unknown subcommands and unsafe update flags with usage error", () => {
    expect(parse(["provider", "bogus"]).kind).toBe("error");
    expect(parse(["provider"]).kind).toBe("error");
    expect(parse(["config", "bogus"]).kind).toBe("error");
    expect(parse(["model", "bogus"]).kind).toBe("error");
    expect(parse(["models", "bogus"]).kind).toBe("error");
    expect(parse(["update", "extra"]).kind).toBe("error");
    expect(parse(["update", "--ref", "--upload-pack=evil"]).kind).toBe("error");
    expect(parse(["update", "--repo=-flag"]).kind).toBe("error");
    expect(parse(["update", "--prefix", "  "]).kind).toBe("error");
  });

  it("USAGE includes setup, provider, and update command lines", () => {
    expect(USAGE).toContain("champ setup");
    expect(USAGE).toContain("champ provider");
    expect(USAGE).toContain("champ update");
    expect(USAGE).toContain("--check");
    expect(USAGE).toContain("--force");
    expect(USAGE).toContain("--endpoint <id>");
    expect(USAGE).toContain("--workspace");
    expect(USAGE).toContain("--dry-run");
  });
});

describe("cli entry — no vscode on the CLI path (issue #136)", () => {
  it("never imports the vscode API", () => {
    const sources = [
      "src/cli.ts",
      "src/cli/args.ts",
      "src/cli/setup.ts",
      "src/cli/provider-commands.ts",
      "src/cli/update.ts",
      "src/cli/rules.ts",
      "src/cli/skills.ts",
      "src/cli/tool-scope.ts",
      "src/config/provider-model.ts",
      "src/config/provider-repository.ts",
      "src/config/credential-store.ts",
      "src/config/provider-catalog.ts",
      "src/config/provider-migration.ts",
      "src/config/model-discovery.ts",
      "src/config/model-selection.ts",
      "src/config/endpoint-registry.ts",
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

describe("cli arg parser — index management", () => {
  it("defaults champ index to status", () => {
    expect(parse(["index"])).toMatchObject({
      kind: "index-command",
      command: { name: "status" },
      cwd: "/tmp/ws",
    });
    expect(parse(["index", "--status", "--cwd", "/elsewhere"])).toMatchObject({
      kind: "index-command",
      command: { name: "status" },
      cwd: "/elsewhere",
    });
  });

  it("parses each index action", () => {
    for (const [flag, name] of [
      ["--rebuild", "rebuild"],
      ["--clear", "clear"],
      ["--watch", "watch"],
    ] as const) {
      expect(parse(["index", flag])).toMatchObject({
        kind: "index-command",
        command: { name },
      });
    }
  });

  it("rejects conflicting and misplaced index flags", () => {
    expect(parse(["index", "--rebuild", "--clear"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("only one of"),
    });
    expect(parse(["--rebuild", "task"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("require the `champ index` command"),
    });
    expect(parse(["index", "task"])).toMatchObject({ kind: "error" });
  });

  it("passes embedding overrides through index flags", () => {
    const result = parse([
      "index",
      "--embedding-model",
      "nomic-embed-text",
      "--embedding-provider=ollama",
    ]);
    expect(result.kind).toBe("index-command");
    if (result.kind === "index-command") {
      expect(result.flags.embeddingModel).toBe("nomic-embed-text");
      expect(result.flags.embeddingProvider).toBe("ollama");
    }
  });
});

describe("champ team commands", () => {
  it("parses list and history without a task", () => {
    expect(parse(["team", "list"])).toMatchObject({
      kind: "team-command",
      command: { name: "list" },
      cwd: "/tmp/ws",
    });
    expect(parse(["team", "history"])).toMatchObject({
      kind: "team-command",
      command: { name: "history" },
    });
  });

  it("parses run with the team name and the full task text", () => {
    expect(
      parse(["team", "run", "devops", "fix", "the", "build"]),
    ).toMatchObject({
      kind: "team-command",
      command: { name: "run", team: "devops", task: "fix the build" },
    });
  });

  it("parses resume with a validated run id", () => {
    expect(parse(["team", "resume", "team-abc_123"])).toMatchObject({
      kind: "team-command",
      command: { name: "resume", runId: "team-abc_123" },
    });
    expect(parse(["team", "resume", "../etc/passwd"]).kind).toBe("error");
  });

  it("rejects missing, extra, and unknown team arguments", () => {
    expect(parse(["team"]).kind).toBe("error");
    expect(parse(["team", "bogus"]).kind).toBe("error");
    expect(parse(["team", "list", "extra"]).kind).toBe("error");
    expect(parse(["team", "run", "devops"]).kind).toBe("error");
    expect(parse(["team", "run", "bad/name", "task"]).kind).toBe("error");
  });

  it("rejects interactive modes for team commands", () => {
    expect(parse(["team", "list", "--tui"]).kind).toBe("error");
    expect(parse(["team", "list", "--repl"]).kind).toBe("error");
    expect(parse(["team", "list", "--rpc"]).kind).toBe("error");
  });

  it("documents all four team commands in USAGE", () => {
    for (const command of [
      "team list",
      "team run",
      "team history",
      "team resume",
    ]) {
      expect(USAGE).toContain(`champ ${command}`);
    }
  });
});
