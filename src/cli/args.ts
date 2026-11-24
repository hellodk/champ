/**
 * Argument parsing for the headless `champ` CLI (issue #136).
 *
 * Pure with respect to VS Code and the filesystem: mode detection (one-shot /
 * REPL / stdin-pipe / session listing) is decided here from argv plus whether
 * stdin is a TTY, so it can be unit-tested without spawning the binary.
 * Session ids are validated here too (issue #72) so a traversal attempt is a
 * usage error, not a filesystem call.
 */
import * as path from "path";
import { isValidSessionId } from "../session/ids";
import { isTaskAssignment } from "../config/provider-model";
import { isPermissionProfile, PERMISSION_PROFILES } from "../policy/profiles";
import type { ProviderCommand } from "./provider-commands";
import type { PolicyCommand } from "./policy-commands";
import type { IndexCommand } from "./index-commands";
import type { TeamCommand } from "./team-commands";
import { validateRepoOrRef, type UpdateCommandOptions } from "./update";

/** How the CLI should run: one task, the full-screen UI, a line REPL, or piped input. */
export type CliMode = "oneshot" | "tui" | "repl" | "stdin" | "rpc";

export interface CliFlags {
  help: boolean;
  version: boolean;
  /** Auto-approve destructive tools instead of prompting the user. */
  yes: boolean;
  /** Explicit operator-set permission profile (`--permission-profile`). */
  permissionProfile?: string;
  /** Force the full-screen TUI even when stdin is not a terminal. */
  tui: boolean;
  /** Force the line REPL even when stdin is not a terminal. */
  repl: boolean;
  /** Emit one JSON object per line on stdout; diagnostics stay on stderr. */
  json: boolean;
  /** Speak newline-delimited JSON RPC on stdin/stdout. */
  rpc: boolean;
  /** List stored sessions for the workspace instead of running a task. */
  listSessions: boolean;
  /** Workspace root the agent operates in. */
  cwd: string;
  /** Stored session to resume (created when it does not exist). */
  session?: string;
  /** Import a legacy extension session JSON file into the JSONL store. */
  importSession?: string;
  /** Overrides for the active provider block in config.yaml. */
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Maximum tool-calling iterations per user message. */
  maxIterations?: number;
  /** Run a named skill in one-shot mode (`--skill <name>`). */
  skill?: string;
  /** Target file for skill context and auto-attached glob rules (`--file <path>`). */
  file?: string;
  /** List available skills and exit (`--list-skills`). */
  listSkills: boolean;
  /** Skip loading workspace/user skill directories (`--no-skills`). */
  noSkills: boolean;
  /** Optional endpoint id/name filter for `champ models` commands. */
  endpoint?: string;
  /** Persist `champ model use` reference to `<workspace>/.champ/provider.json`. */
  workspace: boolean;
  /** Preview `champ config migrate` / `scrub-secrets` without writing changes. */
  dryRun: boolean;
  /** Required for `champ config export` — redact all secret material. */
  redact: boolean;
  /** Send a 1-token inference request during `champ provider test` (`--inference`). */
  inference: boolean;
  /** Check for a newer CLI version without installing (`champ update --check`). */
  check: boolean;
  /** Reinstall even when already at the latest version (`champ update --force`). */
  force: boolean;
  /** Git ref/branch/tag for `champ update --ref <ref>`. */
  ref?: string;
  /** Git repository URL for `champ update --repo <url>`. */
  repo?: string;
  /** Custom npm global prefix for `champ update --prefix <dir>`. */
  prefix?: string;
  /** Override the embedding model used by `champ index`. */
  embeddingModel?: string;
  /** Override the provider name used for explicit embedding models. */
  embeddingProvider?: string;
  /** `champ index` action flags. */
  indexStatus: boolean;
  indexRebuild: boolean;
  indexClear: boolean;
  indexWatch: boolean;
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
  | { kind: "list-skills"; cwd: string; noSkills: boolean }
  | { kind: "provider-command"; command: ProviderCommand; cwd: string }
  | { kind: "policy-command"; command: PolicyCommand; cwd: string }
  | { kind: "update"; options: UpdateCommandOptions }
  | {
      kind: "index-command";
      command: IndexCommand;
      cwd: string;
      flags: CliFlags;
    }
  | {
      kind: "team-command";
      command: TeamCommand;
      cwd: string;
      flags: CliFlags;
    }
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
  champ                   Full-screen TUI (when stdin is a terminal)
  champ --tui             Force the full-screen TUI
  champ --repl            Line REPL instead of the TUI (also with piped input)
  champ --rpc             Newline-delimited JSON RPC on stdin/stdout
  champ -                 Read the task from stdin
  echo "<t>" | champ      Same as above (piped stdin)
  champ --sessions        List stored sessions for the workspace
  champ setup             Guided interactive provider setup
  champ provider <cmd>    Manage endpoints: list | add | edit <id> | remove <id> | test <id> [--inference] | discover <id>
  champ models [refresh]  List or refresh discovered models
  champ model use <id/m>  Select default or workspace model
  champ model assign <t> <id/m>  Assign model to task: default | coding | chat | completion | embedding
  champ config <cmd>      show | validate | doctor | export --redact | migrate [--dry-run] | scrub-secrets [--dry-run] | routing <auto|manual>
  champ policy <cmd>      show | validate   Inspect effective enterprise policy rules
  champ index [--status|--rebuild|--clear|--watch]  Inspect or manage the semantic index
  champ team list         List team definitions in .champ/teams
  champ team run <name> "<task>"  Run a team definition
  champ team history      List recorded team runs
  champ team resume <runId>  Resume a team run from its checkpoints
  champ update            Update the champ CLI installation from upstream git

Options:
  -h, --help              Show this help
  -v, --version           Print the version
  -y, --yes               Auto-approve destructive tools
      --permission-profile <name>  read-only | supervised | autonomous
      --json              Emit structured JSONL events on stdout (one-shot runs)
      --rpc               Newline-delimited JSON RPC on stdin/stdout
      --tui               Force the full-screen TUI
  -r, --repl              Force the line REPL instead of the TUI
      --cwd <dir>         Workspace root (default: current directory)
      --provider <name>   Override the provider configured in config.yaml
      --base-url <url>    Override the provider base URL
      --model <name>      Override the model
      --api-key <key>     Override the API key
      --max-iter <n>      Maximum tool-call iterations per message
      --session <id>      Resume a stored session (created when it is new)
      --import-session <file>  Import a legacy extension session JSON file
      --skill <name>      Run a skill (same as /<name>) in one-shot mode
      --file <path>       The file skills and glob rules should assume
      --list-skills       Print available skills and exit
      --no-skills         Ignore workspace/user skill directories
      --endpoint <id>     Filter \`models\` / \`models refresh\` by endpoint
      --workspace         Write \`model use\` selection to workspace .champ/provider.json
      --dry-run           Preview \`config migrate\`, \`config scrub-secrets\`, or \`update\` without writing
      --redact            Required for \`config export\`; redacts all secret material
      --inference         Send a minimal inference request during \`champ provider test\`
      --check             Check if a newer CLI update is available without installing
      --force             Reinstall CLI even when already on the latest commit
      --ref <ref>         Branch or tag to install during \`champ update\`
      --repo <url>        Git repository URL for \`champ update\`
      --prefix <dir>      Custom npm global prefix for \`champ update\`
      --embedding-model <id>   Override the embedding model for indexing
      --embedding-provider <name>  Provider name for an explicit embedding model

Sessions are append-only JSONL logs in <workspace>/.champ/sessions. The REPL
keeps one automatically; --session does the same for one-shot runs. Resuming
replays the log bounded at the newest checkpoint, without re-summarising.
REPL commands: /skills, /<skill> [args], /session, /sessions, /checkpoint [label], /help, /exit.

Configuration is read from ~/.champ/providers.json (managed by \`champ setup\`) and
~/.champ/config.yaml (or CHAMP_CONFIG).
Interactive runs prompt before destructive tools. Non-interactive runs without
auto-approval deny actions that require approval. Permission profiles are an
operator-set floor: read-only denies state changes, supervised prompts for them,
autonomous allows them. An explicit --permission-profile takes precedence over
--yes / yoloMode; --yes alone selects the autonomous profile.
`;

/** Flags that take a separate value argument. */
const VALUE_FLAGS: Record<string, keyof CliFlags> = {
  "--cwd": "cwd",
  "--provider": "provider",
  "--model": "model",
  "--base-url": "baseUrl",
  "--api-key": "apiKey",
  "--permission-profile": "permissionProfile",
  "--max-iter": "maxIterations",
  "--session": "session",
  "--import-session": "importSession",
  "--skill": "skill",
  "--file": "file",
  "--endpoint": "endpoint",
  "--ref": "ref",
  "--repo": "repo",
  "--prefix": "prefix",
  "--embedding-model": "embeddingModel",
  "--embedding-provider": "embeddingProvider",
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
    tui: false,
    repl: false,
    json: false,
    rpc: false,
    listSessions: false,
    listSkills: false,
    noSkills: false,
    workspace: false,
    dryRun: false,
    redact: false,
    inference: false,
    check: false,
    force: false,
    indexStatus: false,
    indexRebuild: false,
    indexClear: false,
    indexWatch: false,
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
    if (arg === "--tui") {
      flags.tui = true;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--rpc") {
      flags.rpc = true;
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
    if (arg === "--list-skills") {
      flags.listSkills = true;
      continue;
    }
    if (arg === "--no-skills") {
      flags.noSkills = true;
      continue;
    }
    if (arg === "--workspace") {
      flags.workspace = true;
      continue;
    }
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (arg === "--redact") {
      flags.redact = true;
      continue;
    }
    if (arg === "--inference") {
      flags.inference = true;
      continue;
    }
    if (arg === "--check") {
      flags.check = true;
      continue;
    }
    if (arg === "--force") {
      flags.force = true;
      continue;
    }
    if (arg === "--status") {
      flags.indexStatus = true;
      continue;
    }
    if (arg === "--rebuild") {
      flags.indexRebuild = true;
      continue;
    }
    if (arg === "--clear") {
      flags.indexClear = true;
      continue;
    }
    if (arg === "--watch") {
      flags.indexWatch = true;
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
      if (valueKey === "permissionProfile") {
        if (!isPermissionProfile(value)) {
          return error(
            `--permission-profile must be one of ${PERMISSION_PROFILES.join(", ")}, got "${value}"`,
          );
        }
        flags.permissionProfile = value;
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
        case "importSession":
          if (!value.trim()) {
            return error("--import-session cannot be empty");
          }
          flags.importSession = path.resolve(flags.cwd, value);
          break;
        case "skill":
          if (!/^[A-Za-z][\w-]*$/.test(value)) {
            return error(
              `--skill must be a skill name like "review", got "${value}"`,
            );
          }
          flags.skill = value;
          break;
        case "file":
          flags.file = value;
          break;
        case "endpoint":
          flags.endpoint = value;
          break;
        case "ref": {
          const refErr = validateRepoOrRef(value, "ref");
          if (refErr) return error(refErr);
          flags.ref = value.trim();
          break;
        }
        case "repo": {
          const repoErr = validateRepoOrRef(value, "repo");
          if (repoErr) return error(repoErr);
          flags.repo = value.trim();
          break;
        }
        case "prefix":
          if (!value.trim()) {
            return error("prefix cannot be empty");
          }
          flags.prefix = value;
          break;
        case "embeddingModel":
          if (!value.trim()) {
            return error("--embedding-model cannot be empty");
          }
          flags.embeddingModel = value.trim();
          break;
        case "embeddingProvider":
          if (!value.trim()) {
            return error("--embedding-provider cannot be empty");
          }
          flags.embeddingProvider = value.trim();
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
  if (
    flags.rpc &&
    (flags.json ||
      flags.listSessions ||
      flags.listSkills ||
      flags.skill ||
      positionals.length > 0 ||
      flags.indexStatus ||
      flags.indexRebuild ||
      flags.indexClear ||
      flags.indexWatch)
  ) {
    return error(
      "--rpc takes no command or task and cannot be combined with --json",
    );
  }

  // Listing sessions is a read-only query about a workspace: it cannot be
  // combined with work, and it needs neither a provider nor a session.
  if (flags.listSessions) {
    if (positionals.length > 0 || explicitStdin) {
      return error("cannot combine --sessions with a task");
    }
    if (flags.repl) {
      return error("cannot combine --sessions with --repl");
    }
    if (flags.tui) {
      return error("cannot combine --sessions with --tui");
    }
    return { kind: "sessions", cwd: flags.cwd };
  }

  if (flags.listSkills) {
    if (positionals.length > 0 || explicitStdin) {
      return error("cannot combine --list-skills with a task");
    }
    if (flags.repl) {
      return error("cannot combine --list-skills with --repl");
    }
    if (flags.tui) {
      return error("cannot combine --list-skills with --tui");
    }
    return { kind: "list-skills", cwd: flags.cwd, noSkills: flags.noSkills };
  }

  if (flags.skill) {
    if (flags.repl) {
      return error(
        "--skill cannot be combined with --repl (use /<skill> inside the REPL)",
      );
    }
    if (flags.tui) {
      return error(
        "--skill cannot be combined with --tui (use /<skill> inside the TUI)",
      );
    }
    if (positionals[0]?.startsWith("/")) {
      return error("give the skill either with --skill or /<name>, not both");
    }
  }

  const indexActions = [
    flags.indexStatus && "status",
    flags.indexRebuild && "rebuild",
    flags.indexClear && "clear",
    flags.indexWatch && "watch",
  ].filter(Boolean) as IndexCommand["name"][];
  if (indexActions.length > 1) {
    return error(
      "only one of --status, --rebuild, --clear, --watch is allowed",
    );
  }
  if (indexActions.length > 0 && positionals[0] !== "index") {
    return error("index flags require the `champ index` command");
  }

  if (!endOfFlags && !flags.skill) {
    const commandResult = parseProviderCommand(positionals, flags);
    if (commandResult) {
      return commandResult;
    }
  }

  // Mode precedence: explicit interactive flags win (and are mutually
  // exclusive); otherwise an explicit --skill or task wins, then explicit `-`,
  // then a non-terminal stdin means piped input, otherwise the full-screen TUI.
  if (flags.tui && flags.repl) {
    return error("cannot combine --tui and --repl");
  }
  if (flags.rpc && (flags.tui || flags.repl)) {
    return error("cannot combine --rpc with --tui or --repl");
  }
  if (flags.rpc && (flags.json || positionals.length > 0 || explicitStdin)) {
    return error("--rpc takes no task and cannot be combined with --json");
  }
  if ((flags.tui || flags.repl) && (positionals.length > 0 || explicitStdin)) {
    return error(
      `cannot combine ${flags.tui ? "--tui" : "--repl"} with a task`,
    );
  }

  let mode: CliMode;
  let task: string | undefined;
  if (flags.rpc) {
    mode = "rpc";
  } else if (flags.tui) {
    mode = "tui";
  } else if (flags.repl) {
    mode = "repl";
  } else if (flags.skill) {
    mode = "oneshot";
    task = positionals.join(" ");
  } else if (positionals.length > 0) {
    mode = "oneshot";
    task = positionals.join(" ");
  } else if (explicitStdin || !env.stdinIsTTY) {
    mode = "stdin";
  } else {
    mode = "tui";
  }

  if (flags.json && (mode === "tui" || mode === "repl")) {
    return error("--json only supports one-shot agent runs");
  }

  return { kind: "run", options: { mode, task, flags } };
}

function parseProviderCommand(
  positionals: string[],
  flags: CliFlags,
): CliParseResult | null {
  const head = positionals[0];
  if (!head) return null;

  switch (head) {
    case "index": {
      if (positionals.length > 1) {
        return error(
          `unexpected arguments for "index": ${positionals.slice(1).join(" ")}`,
        );
      }
      if (flags.repl) return error("cannot combine index with --repl");
      if (flags.tui) return error("cannot combine index with --tui");
      const action =
        (flags.indexRebuild && "rebuild") ||
        (flags.indexClear && "clear") ||
        (flags.indexWatch && "watch") ||
        "status";
      return {
        kind: "index-command",
        command: { name: action },
        cwd: flags.cwd,
        flags,
      };
    }

    case "team": {
      if (flags.repl) return error("cannot combine team with --repl");
      if (flags.tui) return error("cannot combine team with --tui");
      const sub = positionals[1];
      const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
      if (sub === "list" || sub === "history") {
        if (positionals.length > 2) {
          return error(`unexpected arguments for "team ${sub}"`);
        }
        return {
          kind: "team-command",
          command: { name: sub },
          cwd: flags.cwd,
          flags,
        };
      }
      if (sub === "run") {
        const team = positionals[2];
        const task = positionals.slice(3).join(" ").trim();
        if (!team || !namePattern.test(team)) {
          return error(
            '"team run" requires a team name like "devops-platform"',
          );
        }
        if (!task) return error('"team run" requires a task description');
        return {
          kind: "team-command",
          command: { name: "run", team, task },
          cwd: flags.cwd,
          flags,
        };
      }
      if (sub === "resume") {
        const runId = positionals[2];
        if (!runId || !namePattern.test(runId)) {
          return error('"team resume" requires a run id');
        }
        if (positionals.length > 3) {
          return error('unexpected arguments for "team resume"');
        }
        return {
          kind: "team-command",
          command: { name: "resume", runId },
          cwd: flags.cwd,
          flags,
        };
      }
      return error(
        `unknown team subcommand "${sub ?? ""}" (expected: list, run, history, resume)`,
      );
    }

    case "setup": {
      if (positionals.length > 1) {
        return error(
          `unexpected arguments for "setup": ${positionals.slice(1).join(" ")}`,
        );
      }
      return {
        kind: "provider-command",
        command: { name: "setup" },
        cwd: flags.cwd,
      };
    }

    case "provider": {
      const sub = positionals[1];
      if (!sub) {
        return error(
          'missing subcommand for "provider" (expected: list, add, edit, remove, test, discover)',
        );
      }
      switch (sub) {
        case "list":
          return {
            kind: "provider-command",
            command: { name: "provider-list" },
            cwd: flags.cwd,
          };
        case "add":
          return {
            kind: "provider-command",
            command: { name: "provider-add" },
            cwd: flags.cwd,
          };
        case "test": {
          const id = positionals[2];
          if (!id) {
            return error(`missing endpoint id for "provider ${sub}"`);
          }
          return {
            kind: "provider-command",
            command: {
              name: "provider-test",
              id,
              inference: flags.inference || undefined,
            },
            cwd: flags.cwd,
          };
        }
        case "edit":
        case "remove":
        case "discover": {
          const id = positionals[2];
          if (!id) {
            return error(`missing endpoint id for "provider ${sub}"`);
          }
          const name = `provider-${sub}` as
            | "provider-edit"
            | "provider-remove"
            | "provider-discover";
          return {
            kind: "provider-command",
            command: { name, id },
            cwd: flags.cwd,
          };
        }
        default:
          return error(`unknown provider subcommand "${sub}"`);
      }
    }

    case "models": {
      const sub = positionals[1];
      if (!sub) {
        return {
          kind: "provider-command",
          command: { name: "models", id: flags.endpoint },
          cwd: flags.cwd,
        };
      }
      if (sub === "refresh" && positionals.length === 2) {
        return {
          kind: "provider-command",
          command: { name: "models-refresh", id: flags.endpoint },
          cwd: flags.cwd,
        };
      }
      return error(`unknown models subcommand "${sub}"`);
    }

    case "model": {
      const sub = positionals[1];
      if (sub === "use") {
        const target = positionals[2];
        if (!target) {
          return error('missing <endpoint-id>/<model> for "model use"');
        }
        return {
          kind: "provider-command",
          command: {
            name: "model-use",
            endpointAndModel: target,
            workspace: flags.workspace || undefined,
          },
          cwd: flags.cwd,
        };
      }
      if (sub === "assign") {
        const task = positionals[2];
        const target = positionals[3];
        if (!task || !isTaskAssignment(task)) {
          return error(
            'expected task name for "model assign": default, coding, chat, completion, or embedding',
          );
        }
        if (!target) {
          return error('missing <endpoint-id>/<model> for "model assign"');
        }
        return {
          kind: "provider-command",
          command: {
            name: "model-assign",
            task,
            endpointAndModel: target,
          },
          cwd: flags.cwd,
        };
      }
      return error(`unknown model subcommand "${sub ?? ""}"`);
    }

    case "config": {
      const sub = positionals[1];
      if (sub === "show") {
        return {
          kind: "provider-command",
          command: { name: "config-show" },
          cwd: flags.cwd,
        };
      }
      if (sub === "validate") {
        return {
          kind: "provider-command",
          command: { name: "config-validate" },
          cwd: flags.cwd,
        };
      }
      if (sub === "doctor") {
        return {
          kind: "provider-command",
          command: { name: "config-doctor" },
          cwd: flags.cwd,
        };
      }
      if (sub === "export") {
        if (!flags.redact) {
          return error("config export requires --redact");
        }
        if (positionals.length !== 2) {
          return error('unexpected arguments for "config export"');
        }
        return {
          kind: "provider-command",
          command: { name: "config-export", redact: true },
          cwd: flags.cwd,
        };
      }
      if (sub === "migrate") {
        return {
          kind: "provider-command",
          command: {
            name: "config-migrate",
            dryRun: flags.dryRun || undefined,
          },
          cwd: flags.cwd,
        };
      }
      if (sub === "scrub-secrets") {
        return {
          kind: "provider-command",
          command: {
            name: "config-scrub-secrets",
            dryRun: flags.dryRun || undefined,
          },
          cwd: flags.cwd,
        };
      }
      if (sub === "routing") {
        const mode = positionals[2];
        if (mode !== "auto" && mode !== "manual") {
          return error('expected "auto" or "manual" for "config routing"');
        }
        return {
          kind: "provider-command",
          command: { name: "config-routing", mode },
          cwd: flags.cwd,
        };
      }
      return error(`unknown config subcommand "${sub ?? ""}"`);
    }

    case "policy": {
      const sub = positionals[1];
      if (positionals.length > 2) {
        return error(
          `unexpected arguments for "policy": ${positionals.slice(2).join(" ")}`,
        );
      }
      if (sub === "show") {
        return {
          kind: "policy-command",
          command: { name: "policy-show" },
          cwd: flags.cwd,
        };
      }
      if (sub === "validate") {
        return {
          kind: "policy-command",
          command: { name: "policy-validate" },
          cwd: flags.cwd,
        };
      }
      return error(
        `unknown policy subcommand "${sub ?? ""}" (expected: show, validate)`,
      );
    }

    case "update": {
      if (positionals.length > 1) {
        return error(
          `unexpected arguments for "update": ${positionals.slice(1).join(" ")}`,
        );
      }
      return {
        kind: "update",
        options: {
          check: flags.check || flags.dryRun,
          force: flags.force,
          ref: flags.ref,
          repo: flags.repo,
          prefix: flags.prefix,
        },
      };
    }

    default:
      return null;
  }
}
