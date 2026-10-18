/**
 * Argument parsing for the headless `champ` CLI (issue #136).
 *
 * Pure with respect to VS Code and the filesystem: mode detection (one-shot /
 * REPL / stdin-pipe / session listing) is decided here from argv plus whether
 * stdin is a TTY, so it can be unit-tested without spawning the binary.
 * Session ids are validated here too (issue #72) so a traversal attempt is a
 * usage error, not a filesystem call.
 */
import { isValidSessionId } from "../session/ids";

/** How the CLI should run: one task, an interactive session, or piped input. */
export type CliMode = "oneshot" | "repl" | "stdin";

export interface CliFlags {
  help: boolean;
  version: boolean;
  /** Auto-approve destructive tools instead of prompting the user. */
  yes: boolean;
  /** Force the interactive session even when stdin is not a terminal. */
  repl: boolean;
  /** List stored sessions for the workspace instead of running a task. */
  listSessions: boolean;
  /** Workspace root the agent operates in. */
  cwd: string;
  /** Stored session to resume (created when it does not exist). */
  session?: string;
  /** Overrides for the active provider block in config.yaml. */
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Maximum tool-calling iterations per user message. */
  maxIterations?: number;
}

export interface CliOptions {
  mode: CliMode;
  /** The instruction to run. Always set for `oneshot`/`stdin`. */
  task?: string;
  flags: CliFlags;
}

export type CliParseResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "sessions"; cwd: string }
  | { kind: "error"; message: string }
  | { kind: "run"; options: CliOptions };

export interface ParseCliArgsEnv {
  /** True when stdin is a terminal (the user can answer prompts). */
  stdinIsTTY: boolean;
  /** Default workspace root when `--cwd` is absent. */
  cwd?: string;
}

export const USAGE = `champ — headless Champ agent CLI

Usage:
  champ "<task>"          Run a single task and exit
  champ                   Interactive REPL (when stdin is a terminal)
  champ --repl            Force the REPL (also with piped input, for scripting)
  champ -                 Read the task from stdin
  echo "<t>" | champ      Same as above (piped stdin)
  champ --sessions        List stored sessions for the workspace

Options:
  -h, --help              Show this help
  -v, --version           Print the version
  -y, --yes               Auto-approve destructive tools
  -r, --repl              Force the interactive REPL
      --cwd <dir>         Workspace root (default: current directory)
      --provider <name>   Override the provider configured in config.yaml
      --base-url <url>    Override the provider base URL
      --model <name>      Override the model
      --api-key <key>     Override the API key
      --max-iter <n>      Maximum tool-call iterations per message
      --session <id>      Resume a stored session (created when it is new)

Sessions are append-only JSONL logs in <workspace>/.champ/sessions. The REPL
keeps one automatically; --session does the same for one-shot runs. Resuming
replays the log bounded at the newest checkpoint, without re-summarising.
REPL commands: /session, /sessions, /checkpoint [label], /help, /exit.

Configuration is read from ~/.champ/config.yaml (or CHAMP_CONFIG).
Interactive runs prompt before destructive tools; non-interactive runs
(--yes, or piped stdin) approve them automatically.
`;

/** Flags that take a separate value argument. */
const VALUE_FLAGS: Record<string, keyof CliFlags> = {
  "--cwd": "cwd",
  "--provider": "provider",
  "--model": "model",
  "--base-url": "baseUrl",
  "--api-key": "apiKey",
  "--max-iter": "maxIterations",
  "--session": "session",
};

function error(message: string): CliParseResult {
  return { kind: "error", message: `${message}\n\n${USAGE}` };
}

/**
 * Parse CLI arguments into a run mode plus flags.
 *
 * Positional arguments are joined into a single task, so both
 * `champ "fix the tests"` and `champ fix the tests` work.
 */
export function parseCliArgs(
  argv: string[],
  env: ParseCliArgsEnv,
): CliParseResult {
  const flags: CliFlags = {
    help: false,
    version: false,
    yes: false,
    repl: false,
    listSessions: false,
    cwd: env.cwd ?? process.cwd(),
  };
  const positionals: string[] = [];
  let explicitStdin = false;
  let endOfFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (endOfFlags) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfFlags = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      flags.version = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "--repl" || arg === "-r") {
      flags.repl = true;
      continue;
    }
    if (arg === "--sessions") {
      flags.listSessions = true;
      continue;
    }

    // `champ -` reads the task from stdin explicitly.
    if (arg === "-") {
      explicitStdin = true;
      continue;
    }

    // Support `--flag=value` as well as `--flag value`.
    let name = arg;
    let inlineValue: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        name = arg.slice(0, eq);
        inlineValue = arg.slice(eq + 1);
      }
    }

    const valueKey = VALUE_FLAGS[name];
    if (valueKey) {
      const value = inlineValue ?? argv[++i];
      if (value === undefined) {
        return error(`Missing value for ${name}`);
      }
      if (valueKey === "maxIterations") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return error(`--max-iter must be a positive integer, got "${value}"`);
        }
        flags.maxIterations = parsed;
        continue;
      }
      switch (valueKey) {
        case "cwd":
          flags.cwd = value;
          break;
        case "provider":
          flags.provider = value;
          break;
        case "model":
          flags.model = value;
          break;
        case "baseUrl":
          flags.baseUrl = value;
          break;
        case "apiKey":
          flags.apiKey = value;
          break;
        case "session":
          if (!isValidSessionId(value)) {
            return error(
              `invalid session id "${value}" — use letters, digits, dot, dash or underscore`,
            );
          }
          flags.session = value;
          break;
        default:
          // Boolean flags never appear in VALUE_FLAGS.
          break;
      }
      continue;
    }

    if (name.startsWith("-") && name.length > 1) {
      return error(`Unknown option: ${name}`);
    }

    positionals.push(arg);
  }

  if (flags.help) return { kind: "help" };
  if (flags.version) return { kind: "version" };

  // Listing sessions is a read-only query about a workspace: it cannot be
  // combined with work, and it needs neither a provider nor a session.
  if (flags.listSessions) {
    if (positionals.length > 0 || explicitStdin) {
      return error("cannot combine --sessions with a task");
    }
    if (flags.repl) {
      return error("cannot combine --sessions with --repl");
    }
    return { kind: "sessions", cwd: flags.cwd };
  }

  // Mode precedence: --repl forces an interactive session (a task makes the
  // combination ambiguous, so it is rejected); otherwise an explicit task
  // wins, then explicit `-`, then a non-terminal stdin means piped input,
  // otherwise an interactive REPL.
  if (flags.repl && (positionals.length > 0 || explicitStdin)) {
    return error("cannot combine --repl with a task");
  }

  let mode: CliMode;
  let task: string | undefined;
  if (flags.repl) {
    mode = "repl";
  } else if (positionals.length > 0) {
    mode = "oneshot";
    task = positionals.join(" ");
  } else if (explicitStdin || !env.stdinIsTTY) {
    mode = "stdin";
  } else {
    mode = "repl";
  }

  return { kind: "run", options: { mode, task, flags } };
}
