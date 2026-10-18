/**
 * Headless agentic benchmark for Champ.
 *
 * Drives Champ's real AgentController + OpenAICompatibleProvider against a
 * live OpenAI-compatible server, toggling the `supportsTools` config flag
 * to compare the prompt-based (XML) tool-calling path vs the native
 * OpenAI `tool_calls` path.
 *
 * Usage:
 *   pnpm run bench -- \
 *     --base-url http://192.168.1.5:8000/v1 \
 *     --model mlx-community--Qwen3.5-4B-MLX-8bit \
 *     --api-key dummy \
 *     --mode before|after|both \
 *     --out test-reports/bench/results.json
 *
 * Or build once (`pnpm run build:bench`) and run `node dist/scripts/bench-agent.js …`.
 * This entry is intentionally headless: it must not import `vscode`, so the
 * bundle has no `--external:vscode` and a stray import fails the build.
 *
 * env: BENCH_TASKS_DIR (optional) — override the sandbox work dir
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { AgentController } from "../src/agent/agent-controller";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible";
import { ToolRegistry } from "../src/tools/registry";
import type { Tool, ToolResult } from "../src/tools/types";
import type { StreamDelta } from "../src/providers/types";

const DEFAULT_MAX_ITERATIONS = 25;

interface BenchArgs {
  baseUrl: string;
  model: string;
  apiKey: string;
  mode: "before" | "after" | "both";
  out: string;
  log: string;
  maxIterations: number;
  workDir: string;
  timeoutMs: number;
  task?: string;
}

function parseArgs(argv: string[]): BenchArgs {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    baseUrl: get("--base-url") ?? "http://192.168.1.5:8000/v1",
    model: get("--model") ?? "mlx-community--Qwen3.5-4B-MLX-8bit",
    apiKey: get("--api-key") ?? "dummy",
    mode: (get("--mode") as BenchArgs["mode"]) ?? "both",
    out: get("--out") ?? "test-reports/bench/results.json",
    log: get("--log") ?? "test-reports/bench/progress.jsonl",
    maxIterations: Number(get("--max-iter") ?? DEFAULT_MAX_ITERATIONS),
    workDir:
      get("--work-dir") ?? process.env.BENCH_TASKS_DIR ?? "/tmp/champ-bench",
    timeoutMs: Number(get("--timeout-ms") ?? 900000),
    task: get("--task") ?? undefined,
  };
}

// ── Tool executors (headless, backed by local fs / exec) ──────────────
function bindPath(taskDir: string, p: unknown): string {
  const s = String(p ?? "").trim();
  return path.isAbsolute(s) ? s : path.join(taskDir, s);
}

async function exec(cmd: string): Promise<string> {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).slice(0, 8000);
  } catch (e: any) {
    return `ERR: ${e.stderr?.toString?.() || e.message}`;
  }
}

function makeTools(taskDir: string): Tool[] {
  const ok = (success: boolean, output: string): ToolResult => ({
    success,
    output,
  });
  const ctx = (
    name: string,
    desc: string,
    params: any,
    approval: boolean,
  ): Tool => ({
    name,
    description: desc,
    parameters: params,
    requiresApproval: approval,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        switch (name) {
          case "read_file": {
            const f = bindPath(taskDir, args.path);
            try {
              return ok(true, fs.readFileSync(f, "utf8"));
            } catch {
              return ok(false, `File not found: ${f}`);
            }
          }
          case "list_directory": {
            const d = bindPath(taskDir, args.path ?? ".");
            try {
              return ok(
                true,
                fs
                  .readdirSync(d, { withFileTypes: true })
                  .map((e) => `${e.isDirectory() ? "[d] " : "    "}${e.name}`)
                  .join("\n"),
              );
            } catch (e: any) {
              return ok(false, `Cannot list ${d}: ${e.message}`);
            }
          }
          case "grep_search": {
            return ok(
              true,
              await exec(
                `grep -rn "${String(args.query)}" ${bindPath(taskDir, args.path ?? ".")} || true`,
              ),
            );
          }
          case "file_search": {
            const results = await exec(
              `find ${taskDir} -name '${String(args.pattern)}' -not -path '*/node_modules/*' 2>/dev/null`,
            );
            return ok(true, results || "(no files matched)");
          }
          case "create_file": {
            const f = bindPath(taskDir, args.path);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, String(args.content ?? ""));
            return ok(true, `Created ${f}`);
          }
          case "edit_file": {
            const f = bindPath(taskDir, args.path);
            if (!fs.existsSync(f)) return ok(false, `File not found: ${f}`);
            const oldC = String(args.old_content ?? "");
            const newC = String(args.new_content ?? "");
            const cur = fs.readFileSync(f, "utf8");
            if (!cur.includes(oldC)) {
              return ok(false, `old_content not found in ${f}`);
            }
            fs.writeFileSync(f, cur.replace(oldC, newC));
            return ok(true, `Edited ${f}`);
          }
          case "run_terminal_cmd": {
            const cmd = String(args.command ?? "");
            const ran = cmd.startsWith("cd") ? cmd : `cd ${taskDir} && ${cmd}`;
            return ok(true, await exec(ran));
          }
          case "run_tests": {
            return ok(
              true,
              await exec(
                `cd ${taskDir} && ${String(args.command ?? "python -m pytest -q")}`,
              ),
            );
          }
          default:
            return ok(false, `Unknown tool: ${name}`);
        }
      } catch (e: any) {
        return ok(false, `Tool ${name} threw: ${e.message}`);
      }
    },
  });

  return [
    ctx(
      "read_file",
      "Read and return the full contents of a file. The path is relative to the workspace root.",
      {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      false,
    ),
    ctx(
      "list_directory",
      "List files (and directories) in a directory. Optionally accepts a path; defaults to workspace root.",
      {
        type: "object",
        properties: { path: { type: "string" } },
        required: [],
      },
      false,
    ),
    ctx(
      "grep_search",
      "Search file contents for a regex pattern and return matching lines.",
      {
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string" } },
        required: ["query"],
      },
      false,
    ),
    ctx(
      "file_search",
      "Search for files by glob pattern and return their paths.",
      {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
      false,
    ),
    ctx(
      "create_file",
      "Create a new file with the given content. Fails if the file already exists.",
      {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      true,
    ),
    ctx(
      "edit_file",
      "Perform a search-and-replace edit in a file. old_content must appear exactly once.",
      {
        type: "object",
        properties: {
          path: { type: "string" },
          old_content: { type: "string" },
          new_content: { type: "string" },
        },
        required: ["path", "old_content", "new_content"],
      },
      true,
    ),
    ctx(
      "run_terminal_cmd",
      "Run a shell command in the workspace and return its stdout.",
      {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      true,
    ),
    ctx(
      "run_tests",
      "Run the project test suite and return the results.",
      {
        type: "object",
        properties: { command: { type: "string" } },
        required: [],
      },
      true,
    ),
  ];
}

// ── Task definitions ──────────────────────────────────────────────────
interface Task {
  id: string;
  name: string;
  setup: (dir: string) => void;
  prompt: string;
  verifier: (
    dir: string,
    resultText: string,
  ) => { pass: boolean; detail: string };
}

const TASKS: Task[] = [
  {
    id: "bugfix_off_by_one",
    name: "Fix off-by-one in Python",
    setup(dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "app.py"),
        "def sum_to_n(n):\n    total = 0\n    for i in range(1, n):\n        total += i\n    return total\n\n" +
          'if __name__ == "__main__":\n    print(sum_to_n(5))\n',
      );
      fs.writeFileSync(
        path.join(dir, "test_app.py"),
        "def test_sum():\n    from app import sum_to_n\n    assert sum_to_n(5) == 10\n",
      );
    },
    prompt:
      "app.py has an off-by-one bug in sum_to_n: it should sum 1..n-1 but computes wrong. " +
      "Find the bug, fix it, and run the tests to confirm they pass. Use tools.",
    verifier(dir, _t) {
      try {
        const out = execSync("cd " + dir + " && python -m pytest -q 2>&1", {
          encoding: "utf8",
        });
        return {
          pass: out.includes("passed"),
          detail: out.split("\n").slice(-3).join(" "),
        };
      } catch (e: any) {
        return {
          pass: false,
          detail:
            "pytest failed: " + (e.stderr?.toString?.() || e.message || e),
        };
      }
    },
  },
  {
    id: "fetch_add_feature",
    name: "Add a function + test",
    setup(dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "maths.py"),
        "def add(a, b):\n    return a + b\n",
      );
      fs.writeFileSync(
        path.join(dir, "test_maths.py"),
        "from maths import add\n",
      );
    },
    prompt:
      "Add a new function `multiply(a, b)` to maths.py and a test for it in test_maths.py, " +
      "then run the tests. Use tools.",
    verifier(dir, _t) {
      const src = fs.readFileSync(path.join(dir, "maths.py"), "utf8");
      const tst = fs.readFileSync(path.join(dir, "test_maths.py"), "utf8");
      const hasMul =
        /def\s+multiply/.test(src) && /def\s+test_multiply/.test(tst);
      let runPass = false,
        detail = "";
      try {
        const out = execSync("cd " + dir + " && python -m pytest -q 2>&1", {
          encoding: "utf8",
        });
        runPass = out.includes("passed");
        detail = out.split("\n").slice(-3).join(" ");
      } catch (e: any) {
        detail = "pytest failed: " + e.message;
      }
      return {
        pass: hasMul && runPass,
        detail: (hasMul ? "" : "missing multiply/test ") + detail,
      };
    },
  },
  {
    id: "refactor_duplication",
    name: "Deduplicate repeated logic",
    setup(dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "util.py"),
        "def a(x):\n    return x * 2 + 1\n\n" +
          "def b(x):\n    return x * 2 + 1\n\n" +
          "def c(x):\n    return x * 2 + 1\n",
      );
      fs.writeFileSync(
        path.join(dir, "test_util.py"),
        "from util import a, b, c\n" +
          "def test_all():\n    assert a(1) == 3 and b(1) == 3 and c(1) == 3\n",
      );
    },
    prompt:
      "util.py has three identical functions a, b, c that all compute x*2+1. Refactor to remove " +
      "duplication (a single helper), keeping a, b, c working, and run the tests. Use tools.",
    verifier(dir, _t) {
      const src = fs.readFileSync(path.join(dir, "util.py"), "utf8");
      const dupBodies = (src.match(/x \* 2 \+ 1/g) || []).length;
      let runPass = false,
        detail = "";
      try {
        const out = execSync("cd " + dir + " && python -m pytest -q 2>&1", {
          encoding: "utf8",
        });
        runPass = out.includes("passed");
        detail = out.split("\n").slice(-3).join(" ");
      } catch (e: any) {
        detail = "pytest failed: " + e.message;
      }
      return {
        pass: dupBodies <= 1 && runPass,
        detail: `dups=${dupBodies} ` + detail,
      };
    },
  },
  {
    id: "diagnose_runtime_error",
    name: "Diagnose and fix a crash",
    setup(dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "main.py"),
        'def process(data):\n    return data["key"]\n\n' +
          'if __name__ == "__main__":\n    print(process({"other": 1}))\n',
      );
      fs.writeFileSync(
        path.join(dir, "test_main.py"),
        'def test_process():\n    from main import process\n    assert process({"key": 1}) == 1\n',
      );
    },
    prompt:
      "main.py crashes at runtime with a KeyError because process() accesses data['key'] but the " +
      "call site passes a dict without 'key'. Fix it so the program runs and tests pass. Use tools.",
    verifier(dir, _t) {
      let runOk = false,
        detail = "";
      try {
        const out = execSync("cd " + dir + " && python main.py 2>&1", {
          encoding: "utf8",
        });
        runOk = true;
        detail = "runs: " + out.trim().slice(0, 80);
      } catch (e: any) {
        detail =
          "still crashes: " +
          (e.stderr?.toString?.() || e.message || e).slice(0, 120);
      }
      return { pass: runOk, detail };
    },
  },
];

// ── Single-task run ───────────────────────────────────────────────────
interface RunMetrics {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
  reachedLimit: boolean;
}

async function runTask(
  task: Task,
  args: BenchArgs,
  supportsTools: boolean,
  workDir: string,
): Promise<{ resultText: string; metrics: RunMetrics }> {
  const provider = new OpenAICompatibleProvider({
    provider: "openai-compatible",
    model: args.model,
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    maxTokens: 4096,
    temperature: 0.1,
    supportsTools,
  });

  const toolRegistry = new ToolRegistry();
  const runTools = makeTools(workDir);
  for (const t of runTools) toolRegistry.register(t);

  const controller = new AgentController(provider, toolRegistry, workDir);
  // Strip the default repo-map injection noise; agent mode default prompt is fine.
  controller.setMode("agent");

  let iterations = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  controller.onIterationStart((i) => {
    iterations = Math.max(iterations, i + 1);
  });
  controller.onStreamDelta((d: StreamDelta) => {
    if (d.type === "done" && d.usage) {
      inputTokens += d.usage.inputTokens ?? 0;
      outputTokens += d.usage.outputTokens ?? 0;
    }
  });

  const start = Date.now();
  const abort = new AbortController();
  const killTimer = setTimeout(() => abort.abort(), args.timeoutMs);

  let resultText = "";
  let reachedLimit = false;
  try {
    const result = await controller.processMessage(task.prompt, {
      maxIterations: args.maxIterations,
      requestApproval: () => Promise.resolve(true),
      abortSignal: abort.signal,
    });
    resultText = result.text || "";
  } catch (e: any) {
    resultText = "RUN_ERROR: " + (e?.message || String(e));
  } finally {
    clearTimeout(killTimer);
  }

  const wallMs = Date.now() - start;
  // Detect if the loop hit the iteration cap (24 = cap-1, cap emitted warning)
  if (iterations >= args.maxIterations) reachedLimit = true;

  return {
    resultText,
    metrics: { iterations, inputTokens, outputTokens, wallMs, reachedLimit },
  };
}

// ── Orchestration ─────────────────────────────────────────────────────
interface TaskResult {
  taskId: string;
  taskName: string;
  mode: "prompt-based" | "native";
  supportsTools: boolean;
  pass: boolean;
  detail: string;
  iterations: number;
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  reachedLimit: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const modes: Array<{ label: TaskResult["mode"]; supported: boolean }> = [];
  if (args.mode === "before" || args.mode === "both")
    modes.push({ label: "prompt-based", supported: false });
  if (args.mode === "after" || args.mode === "both")
    modes.push({ label: "native", supported: true });

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.mkdirSync(path.dirname(args.log), { recursive: true });

  // Resume support: skip (mode, task) pairs already recorded in the log.
  const seen = new Set<string>();
  if (fs.existsSync(args.log)) {
    for (const line of fs.readFileSync(args.log, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        seen.add(`${r.mode}|${r.taskId}`);
      } catch {
        /* ignore malformed */
      }
    }
  }

  for (const mode of modes) {
    for (const task of TASKS) {
      if (args.task && task.id !== args.task) continue;
      if (seen.has(`${mode.label}|${task.id}`)) {
        process.stderr.write(
          `  [skip] ${mode.label}/${task.id} already recorded\n`,
        );
        continue;
      }

      const workDir = path.join(args.workDir, task.id);
      fs.rmSync(workDir, { recursive: true, force: true });
      task.setup(workDir);

      const { resultText, metrics } = await runTask(
        task,
        args,
        mode.supported,
        workDir,
      );
      const verdict = task.verifier(workDir, resultText);

      const row: TaskResult = {
        taskId: task.id,
        taskName: task.name,
        mode: mode.label,
        supportsTools: mode.supported,
        pass: verdict.pass,
        detail: verdict.detail,
        iterations: metrics.iterations,
        wallMs: metrics.wallMs,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        reachedLimit: metrics.reachedLimit,
      };
      const line = JSON.stringify(row);
      fs.appendFileSync(args.log, line + "\n");
      process.stderr.write(`  [DONE] ${line}\n`);
    }
  }

  // Re-emit full summary from the log.
  const rows: TaskResult[] = [];
  for (const line of fs.readFileSync(args.log, "utf8").split("\n")) {
    if (line.trim()) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  const summary = {
    baseUrl: args.baseUrl,
    model: args.model,
    maxIterations: args.maxIterations,
    timestamp: new Date().toISOString(),
    tasks: rows,
  };
  fs.writeFileSync(args.out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
