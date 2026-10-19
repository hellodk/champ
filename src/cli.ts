/**
 * Headless Champ CLI — runs the Champ agent outside VS Code (issue #136).
 *
 * Modes:
 *   champ "<task>"     one-shot: run the task, print the reply, exit
 *   champ              interactive REPL (when stdin is a terminal)
 *   champ --repl       REPL forced on (scripting; works with piped stdin)
 *   champ -            task read from stdin (also `echo "<t>" | champ`)
 *   champ --sessions   list stored sessions for the workspace, then exit
 *
 * Everything agent-side is reused unchanged: AgentController, providers,
 * ToolRegistry, safety and config. Only the tool layer is swapped for the
 * VSCode-free one in ./tools/headless, so this bundle must never import
 * `vscode` (the esbuild entry is built without `--external:vscode`, so a
 * stray import fails the build instead of at runtime).
 *
 * Sessions (issue #72, ./session/session-log.ts): `--session <id>` opts a run
 * into an append-only JSONL log under <workspace>/.champ/sessions, resuming
 * when the log exists; the REPL always keeps one. A resume replays the log
 * bounded at its newest checkpoint, so pre-checkpoint turns are never re-sent
 * — and, because the checkpoint stores any summary it was given, never
 * re-summarised either.
 *
 * Configuration comes from ~/.champ/config.yaml — the same single source the
 * extension uses since #126 — overridable with the CHAMP_CONFIG env var for
 * scripted runs. The file format is unchanged.
 *
 * Exit codes: 0 success, 1 agent/provider error, 2 usage/config error,
 * 130 aborted (SIGINT).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createInterface, type Interface as Readline } from "readline";
import { format } from "util";
import { parseCliArgs, USAGE, type CliFlags } from "./cli/args";
import {
  isProviderName,
  resolveLayered,
  VALID_PROVIDERS,
  type ChampConfig,
} from "./config/config-loader";
import { ProviderFactory, type SecretReader } from "./providers/factory";
import { AgentController } from "./agent/agent-controller";
import { createHeadlessToolRegistry } from "./tools/headless";
import {
  CorruptSessionLogError,
  SessionLog,
  type SessionReplay,
} from "./session/session-log";
import { newSessionId } from "./session/ids";
import type { LLMMessage, StreamDelta, TokenUsage } from "./providers/types";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_ABORTED = 130;

// Library diagnostics (provider context-window probes, config notices, …)
// default to console.log, i.e. stdout. The CLI reserves stdout for the
// agent's reply so it can be piped into other tools, so route console.log
// to stderr for the whole process. The reply is written with
// process.stdout.write directly and is unaffected.
console.log = (...args: unknown[]) => {
  process.stderr.write(`${format(...args)}\n`);
};

/** Marker pushed into the REPL line queue when stdin reaches EOF. */
const REPL_EOF = Symbol("repl-eof");
/** Marker pushed when the user interrupts (Ctrl-C) while idle. */
const REPL_INTERRUPT = Symbol("repl-interrupt");

/** The turn currently in flight, if any — Ctrl-C aborts it when set. */
let activeAbort: AbortController | null = null;

/**
 * Version reported by --version and the REPL banner. Read from the package
 * manifest next to dist/cli.js rather than inlined at build time, so the
 * bundle does not carry the whole extension manifest with it.
 */
function cliVersion(): string {
  try {
    const manifest = path.join(__dirname, "..", "package.json");
    const raw = fs.readFileSync(manifest, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const version =
      parsed && typeof parsed === "object"
        ? (parsed as { version?: unknown }).version
        : undefined;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Path of the config file. CHAMP_CONFIG exists for scripted runs (tests and
 * fleet provisioning) — the file format itself is unchanged.
 */
function configPath(): string {
  return (
    process.env.CHAMP_CONFIG ?? path.join(os.homedir(), ".champ", "config.yaml")
  );
}

function readConfigText(): string | null {
  try {
    const p = configPath();
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  } catch {
    // Unreadable config behaves like an absent one (falls back to defaults).
  }
  return null;
}

/**
 * Resolve the effective ChampConfig: the YAML file plus any provider
 * overrides passed on the command line.
 */
function buildConfig(flags: CliFlags): ChampConfig {
  const resolved = resolveLayered({
    userText: readConfigText(),
    source: "auto",
  });
  const config: ChampConfig = resolved.config ?? {};

  if (flags.provider) {
    if (!isProviderName(flags.provider)) {
      fail(
        `unknown provider "${flags.provider}" — valid providers: ${VALID_PROVIDERS.join(", ")}`,
      );
    }
    config.provider = flags.provider;
  }
  if (!config.provider && (flags.baseUrl || flags.model)) {
    // A local endpoint is the point of this CLI — default to it.
    config.provider = "openai-compatible";
  }

  if (config.provider && (flags.baseUrl || flags.model || flags.apiKey)) {
    const name = config.provider;
    const entry = { ...(config.providers?.[name] ?? {}) };
    if (flags.baseUrl) entry.baseUrl = flags.baseUrl;
    if (flags.model) entry.model = flags.model;
    if (flags.apiKey) entry.apiKey = flags.apiKey;
    config.providers = { ...(config.providers ?? {}), [name]: entry };
  }

  return config;
}

/** Print a fatal message and stop the process with the usage exit code. */
function fail(message: string): never {
  process.stderr.write(`champ: ${message}\n`);
  process.exit(EXIT_USAGE);
}

function parseApprovalAnswer(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

/**
 * Approval prompt on an existing readline (the REPL's). Resolves `false` if
 * the turn is aborted while the prompt is up, so a Ctrl-C cannot wedge the
 * session on a pending question.
 */
function askOn(rl: Readline, description: string): Promise<boolean> {
  return new Promise((resolve) => {
    const signal = activeAbort?.signal;
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => resolve(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    rl.question(`\n${description}\nAllow? [y/N] `, (answer) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(parseApprovalAnswer(answer));
    });
  });
}

/** Approval prompt on a one-off interface (non-REPL interactive runs). */
function askFresh(description: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    const finish = (approved: boolean) => {
      activeAbort?.signal.removeEventListener("abort", onAbort);
      rl.close();
      resolve(approved);
    };
    const onAbort = () => finish(false);
    activeAbort?.signal.addEventListener("abort", onAbort, { once: true });
    rl.question(`\n${description}\nAllow? [y/N] `, (answer) =>
      finish(parseApprovalAnswer(answer)),
    );
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

interface TurnOptions {
  requestApproval: (description: string) => Promise<boolean>;
  maxIterations?: number;
  onDone: (info: { tools: number; usage: TokenUsage }) => void;
  /** Persist whatever the turn added to the session log, if any. */
  onTurnEnd?: () => Promise<void>;
}

/** Shared per-turn options for an interactive session (REPL). */
interface SessionOptions {
  maxIterations?: number;
  /** Session log backing the REPL (null when persistence is off). */
  log: SessionLog | null;
  /** Workspace the session belongs to — used by `/sessions`. */
  workspace: string;
  /** Persist the turn's new messages to the session log. */
  onTurnEnd: () => Promise<void>;
}

interface TurnOutcome {
  text: string;
  error?: string;
  aborted: boolean;
}

/**
 * Run one user message through the controller: assistant text streams to
 * stdout (machine-readable), tool and token traces go to stderr.
 */
async function runTurn(
  controller: AgentController,
  text: string,
  options: TurnOptions,
): Promise<TurnOutcome> {
  let sawText = false;
  let tools = 0;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const abort = new AbortController();
  activeAbort = abort;

  const dispose = controller.onStreamDelta((delta: StreamDelta) => {
    switch (delta.type) {
      case "text":
        process.stdout.write(delta.text);
        sawText = true;
        break;
      case "tool_call_start": {
        const args = JSON.stringify(delta.toolCall.arguments ?? {});
        const shown = args.length > 200 ? `${args.slice(0, 200)}…` : args;
        process.stderr.write(`\n[tool] ${delta.toolCall.name} ${shown}\n`);
        tools++;
        break;
      }
      case "error":
        process.stderr.write(`\n[error] ${delta.error}\n`);
        break;
      case "done":
        usage.inputTokens = delta.usage.inputTokens;
        usage.outputTokens = delta.usage.outputTokens;
        break;
      default:
        // reasoning / terminal_chunk: not rendered by the CLI (v1).
        break;
    }
  });

  try {
    const result = await controller.processMessage(text, {
      maxIterations: options.maxIterations,
      requestApproval: options.requestApproval,
      abortSignal: abort.signal,
    });
    if (sawText) {
      process.stdout.write("\n");
    } else if (result.text) {
      process.stdout.write(`${result.text}\n`);
    }
    options.onDone({ tools, usage });
    return { text: result.text, aborted: abort.signal.aborted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: "", error: message, aborted: abort.signal.aborted };
  } finally {
    activeAbort = null;
    dispose();
    if (options.onTurnEnd) {
      // A failure to persist must not fail the turn that just succeeded, but
      // it must be visible: the history is in memory only until it lands.
      try {
        await options.onTurnEnd();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[champ] session save failed: ${message}\n`);
      }
    }
  }
}

/** One line per turn on stderr: how much work the agent did. */
function printSummary(info: { tools: number; usage: TokenUsage }): void {
  process.stderr.write(
    `[champ] tools=${info.tools} tokens in=${info.usage.inputTokens} out=${info.usage.outputTokens}\n`,
  );
}

/**
 * History to install when resuming a session. Messages before the newest
 * checkpoint stay on disk; what that checkpoint recorded about them — its
 * summary, or failing that how many were elided — is injected as a system
 * message, which SystemPromptBuilder merges into the system prompt. Nothing is
 * re-summarised here: replay is pure log reading.
 */
function resumedHistory(replay: SessionReplay): LLMMessage[] {
  const checkpoint = replay.checkpoint;
  let context: string | undefined;
  if (checkpoint) {
    const detail =
      checkpoint.summary !== undefined
        ? `Summary of earlier context: ${checkpoint.summary}`
        : `Earlier messages are not in context${
            replay.elided > 0 ? ` (${replay.elided} elided)` : ""
          }; ask the user if you need that context.`;
    context = `This session resumes at checkpoint "${checkpoint.label}". ${detail}`;
  }
  return context === undefined
    ? [...replay.messages]
    : [{ role: "system", content: context }, ...replay.messages];
}

/**
 * Per-turn persistence: append whatever the controller added to its history
 * since the last save. The counter starts at the current history length, so
 * resumed messages (already on disk) and the injected resume context (never
 * written) are not recorded twice.
 */
function createSessionRecorder(
  controller: AgentController,
  log: SessionLog | null,
): () => Promise<void> {
  let persisted = controller.getHistory().length;
  return async (): Promise<void> => {
    if (!log) return;
    const history = controller.getHistory();
    if (history.length < persisted) {
      // The history was reset mid-session; trust the new tail.
      persisted = history.length;
    }
    const fresh = history.slice(persisted);
    if (fresh.length > 0) await log.appendMessages(fresh);
    persisted = history.length;
  };
}

/** Listing shown by `--sessions` and the REPL `/sessions` command. */
async function sessionsReport(workspace: string): Promise<string> {
  const dir = SessionLog.dirFor(workspace);
  const sessions = await SessionLog.list(workspace);
  if (sessions.length === 0) return `no sessions in ${dir}\n`;

  const rows = sessions.map((session) => {
    const last = new Date(session.lastActivityAt).toISOString();
    const model = session.meta.model ? `  model=${session.meta.model}` : "";
    return `${session.meta.id}  messages=${session.messages}  checkpoints=${session.checkpoints}  last=${last}${model}`;
  });
  return `sessions in ${dir}\n${rows.join("\n")}\n`;
}

/** One-glance description of the current session, for `/session`. */
function sessionInfo(log: SessionLog | null): string {
  if (!log) return "no session for this run";
  const replay = log.replay();
  const checkpoint = replay.checkpoint
    ? `, checkpoint "${replay.checkpoint.label}" at ${replay.checkpoint.upTo} messages`
    : ", no checkpoint";
  return `${log.id} — ${replay.recorded} messages${checkpoint}\n  ${log.path}`;
}

/**
 * REPL line source: a queue fed by readline events, so a message typed while
 * a turn is running is held (not lost), Ctrl-D ends the session, and Ctrl-C
 * is delivered exactly once instead of being swallowed mid-turn.
 */
function createLineQueue(rl: Readline): {
  next: () => Promise<string | symbol>;
} {
  const queue: Array<string | symbol> = [];
  const waiters: Array<(value: string | symbol) => void> = [];
  let closed = false;

  const push = (value: string | symbol) => {
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  };

  rl.on("line", (line) => push(line));
  rl.on("close", () => {
    closed = true;
    push(REPL_EOF);
  });
  // Idle Ctrl-C: closing readline ends the queue, so the loop exits. A
  // turn in flight aborts first (see runTurn / activeAbort).
  rl.on("SIGINT", () => {
    if (activeAbort && !activeAbort.signal.aborted) {
      activeAbort.abort();
      return;
    }
    push(REPL_INTERRUPT);
  });

  return {
    next(): Promise<string | symbol> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(REPL_EOF);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function runRepl(
  controller: AgentController,
  opts: SessionOptions,
  banner: string,
): Promise<number> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "champ> ",
  });
  const lines = createLineQueue(rl);

  process.stderr.write(`${banner}\n`);
  rl.prompt();

  for (;;) {
    const line = await lines.next();

    if (line === REPL_EOF) break;
    if (line === REPL_INTERRUPT) break;
    if (line === "\u0003") continue; // stray Ctrl-C queued mid-turn

    const trimmed = String(line).trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    // Session and meta commands never reach the model.
    if (trimmed.startsWith("/")) {
      const [command, ...rest] = trimmed.split(/\s+/);
      if (command === "/exit" || command === "/quit" || command === "/q") {
        break;
      }

      switch (command) {
        case "/help":
          process.stderr.write(`${USAGE}`);
          break;
        case "/session":
          process.stderr.write(`[champ] ${sessionInfo(opts.log)}\n`);
          break;
        case "/sessions":
          process.stderr.write(await sessionsReport(opts.workspace));
          break;
        case "/checkpoint": {
          if (!opts.log) {
            process.stderr.write("[champ] no session for this run\n");
            break;
          }
          const checkpoint = await opts.log.markCheckpoint({
            label: rest.join(" ") || undefined,
          });
          process.stderr.write(
            `[champ] checkpoint "${checkpoint.label}" at ${checkpoint.upTo} messages — earlier context is elided on resume\n`,
          );
          break;
        }
        case "/compact": {
          const checkpoint = opts.log?.checkpoint;
          if (!opts.log || !checkpoint) {
            process.stderr.write(
              "[champ] nothing to compact — record a /checkpoint first\n",
            );
            break;
          }
          await opts.log.compact();
          process.stderr.write(
            `[champ] compacted ${opts.log.id} to checkpoint "${checkpoint.label}"\n`,
          );
          break;
        }
        default:
          process.stderr.write(
            `[champ] unknown command ${command} — /help for the list\n`,
          );
          break;
      }
      rl.prompt();
      continue;
    }

    // Approval questions share the REPL interface: readline routes the
    // answer to the question callback while the turn runs.
    const outcome = await runTurn(controller, trimmed, {
      maxIterations: opts.maxIterations,
      requestApproval: (description) => askOn(rl, description),
      onTurnEnd: opts.onTurnEnd,
      onDone: printSummary,
    });

    if (outcome.aborted) {
      process.stderr.write("\n[champ] aborted\n");
    } else if (outcome.error) {
      process.stderr.write(`champ: ${outcome.error}\n`);
    }
    rl.prompt();
  }

  rl.close();
  return EXIT_OK;
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2), {
    stdinIsTTY: Boolean(process.stdin.isTTY),
  });

  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`champ ${cliVersion()}\n`);
    return EXIT_OK;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`champ: ${parsed.message}\n`);
    return EXIT_USAGE;
  }
  if (parsed.kind === "sessions") {
    // Read-only query: no provider, no session, nothing to run.
    process.stdout.write(await sessionsReport(path.resolve(parsed.cwd)));
    return EXIT_OK;
  }

  const { mode, task: taskFromArgv, flags } = parsed.options;

  // ── Resolve the task ──────────────────────────────────────────────────
  let task = taskFromArgv;
  if (mode === "stdin") {
    task = (await readStdin()).trim();
    if (!task) fail("no task given and nothing on stdin");
  }

  // ── Build the agent ───────────────────────────────────────────────────
  const config = buildConfig(flags);
  if (!config.provider) {
    fail(
      "no provider configured — set `provider:` in ~/.champ/config.yaml or pass --provider/--base-url",
    );
  }

  const secrets: SecretReader = {
    get: () => Promise.resolve(undefined), // cloud keys come from env vars
  };

  let provider;
  try {
    provider = await new ProviderFactory().createFromChampConfig(
      config,
      secrets,
    );
  } catch (err) {
    fail(
      `could not build provider: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const workspace = path.resolve(flags.cwd);
  const controller = new AgentController(
    provider,
    createHeadlessToolRegistry(),
    workspace,
  );
  controller.setMode(config.agent?.defaultMode ?? "agent");

  // ── Session persistence ───────────────────────────────────────────────
  // `--session <id>` opts a run into the append-only session log, resuming
  // when the log exists. The REPL always keeps one: the user is in it.
  let sessionLog: SessionLog | null = null;
  try {
    if (flags.session) {
      sessionLog =
        (await SessionLog.open(workspace, flags.session)) ??
        (await SessionLog.create(workspace, {
          id: flags.session,
          model: provider.config.model,
          mode: controller.getMode(),
        }));
    } else if (mode === "repl") {
      sessionLog = await SessionLog.create(workspace, {
        id: newSessionId(),
        model: provider.config.model,
        mode: controller.getMode(),
      });
    }
  } catch (err) {
    if (err instanceof CorruptSessionLogError) {
      // A torn header is not something the user typed wrong: say what to do
      // about it instead of leaving a dead session id behind.
      fail(
        `${err.message} — delete that file to start over, or pass another --session id`,
      );
    }
    fail(err instanceof Error ? err.message : String(err));
  }

  let onTurnEnd: () => Promise<void> = async () => {};
  if (sessionLog) {
    const replay = sessionLog.replay();
    if (flags.session && replay.recorded > 0) {
      controller.setHistory(resumedHistory(replay));
      const elided = replay.elided > 0 ? `, ${replay.elided} elided` : "";
      const at = replay.checkpoint
        ? ` at checkpoint "${replay.checkpoint.label}"`
        : "";
      process.stderr.write(
        `[champ] resumed session ${sessionLog.id}: ${replay.messages.length} messages in context${elided}${at}\n`,
      );
    } else {
      process.stderr.write(
        `[champ] session ${sessionLog.id} — resume with --session ${sessionLog.id}\n`,
      );
    }
    onTurnEnd = createSessionRecorder(controller, sessionLog);
  }

  const onSigint = () => {
    if (activeAbort && !activeAbort.signal.aborted) activeAbort.abort();
    else process.exit(EXIT_ABORTED);
  };
  process.on("SIGINT", onSigint);

  // Approval policy: prompt only when a human can answer. Piped or
  // non-terminal runs approve automatically (documented in --help) —
  // refusing would make headless runs unable to do anything.
  const canPrompt =
    mode === "repl" || (mode === "oneshot" && Boolean(process.stdin.isTTY));
  const yolo = config.agent?.yoloMode === true;
  const autoApprove = flags.yes || yolo || !canPrompt;
  const requestApproval = async (description: string): Promise<boolean> =>
    autoApprove ? true : askFresh(description);

  if (!flags.yes && !yolo && !canPrompt) {
    process.stderr.write(
      "[champ] non-interactive run: destructive tools are approved automatically (pass --yes to silence this note)\n",
    );
  }

  let code: number;
  try {
    if (mode === "repl") {
      code = await runRepl(
        controller,
        {
          maxIterations: flags.maxIterations,
          log: sessionLog,
          workspace,
          onTurnEnd,
        },
        `Champ ${cliVersion()} — model ${provider.config.model ?? "?"}. /help for commands.`,
      );
    } else {
      const outcome = await runTurn(controller, task!, {
        requestApproval,
        maxIterations: flags.maxIterations,
        onTurnEnd,
        onDone: printSummary,
      });
      if (outcome.aborted) code = EXIT_ABORTED;
      else if (outcome.error) {
        process.stderr.write(`champ: ${outcome.error}\n`);
        code = EXIT_FAILURE;
      } else code = EXIT_OK;
    }
  } catch (err) {
    process.stderr.write(
      `champ: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    code = EXIT_FAILURE;
  }

  // Drop the signal listener instead of process.exit() so buffered stdout
  // flushes before the process drains.
  process.off("SIGINT", onSigint);
  return code;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(
      `champ: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = EXIT_FAILURE;
  },
);
