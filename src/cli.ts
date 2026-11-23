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
import * as path from "path";
import { createInterface, type Interface as Readline } from "readline";
import { format } from "util";
import { parseCliArgs, USAGE, type CliFlags } from "./cli/args";
import { loadCliRules, rulesPrompt } from "./cli/rules";
import {
  buildSkillContext,
  formatSkillList,
  loadCliSkills,
  resolveInvocation,
  type ResolvedInvocation,
} from "./cli/skills";
import { applyAllowedTools } from "./cli/tool-scope";
import { runProviderCommand } from "./cli/provider-commands";
import { runPolicyCommand } from "./cli/policy-commands";
import { createCliContext } from "./cli/context";
import { runIndexCommand } from "./cli/index-commands";
import {
  abortActiveTurn,
  activeAbortSignal,
  executeTurn,
  parseApprovalAnswer,
  type TurnOutcome,
  type TurnStatus,
} from "./cli/turn-runtime";
import { runUpdateCommand } from "./cli/update";
import { ChainCredentialStore } from "./config/credential-store";
import { champConfigDir } from "./config/home";
import { BudgetEnforcer } from "./config/budget";
import { FileBudgetLedger } from "./config/budget-ledger";
import { createPolicyEngine, type PolicyEngine } from "./policy/engine";
import { EndpointRegistry } from "./config/endpoint-registry";
import { discoverModels, testEndpoint } from "./config/model-discovery";
import { migrateFromYaml, scrubYamlSecrets } from "./config/provider-migration";
import { SettingsRepository } from "./config/settings-repository";
import { selectActiveModel } from "./config/active-model";
import {
  ModelSelectionService,
  type SelectionTask,
} from "./config/model-selection";
import {
  isProviderKind,
  type Endpoint,
  type TaskAssignment,
} from "./config/provider-model";
import { EndpointRepository } from "./config/provider-repository";
import { SmartRouter } from "./providers/smart-router";
import { createCliIndexingService } from "./indexing/cli-indexing";
import type { RulesEngine } from "./rules/rules-engine";
import type { SkillRegistry } from "./skills/skill-registry";
import type { ToolRegistry } from "./tools/registry";
import {
  isProviderName,
  resolveLayered,
  VALID_PROVIDERS,
  type ChampConfig,
} from "./config/config-loader";
import { ProviderFactory, type SecretReader } from "./providers/factory";
import { AgentController } from "./agent/agent-controller";
import {
  createCliMcpSecretResolver,
  createHeadlessToolRegistry,
  loadHeadlessMcpServers,
} from "./tools/headless";
import {
  CorruptSessionLogError,
  SessionLog,
  type SessionReplay,
} from "./session/session-log";
import { newSessionId } from "./session/ids";
import type { LLMMessage, TokenUsage } from "./providers/types";
import { runTui } from "./tui/app";
import type { EndpointSummary } from "./tui/state";
import type { TuiRuntime, TuiTurnEvents } from "./tui/runtime";

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
  return process.env.CHAMP_CONFIG ?? path.join(champConfigDir(), "config.yaml");
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
  if (flags.embeddingModel || flags.embeddingProvider) {
    config.indexing = {
      ...(config.indexing ?? {}),
      ...(flags.embeddingModel ? { embeddingModel: flags.embeddingModel } : {}),
      ...(flags.embeddingProvider
        ? (() => {
            if (!isProviderName(flags.embeddingProvider)) {
              fail(
                `unknown embedding provider "${flags.embeddingProvider}" — valid providers: ${VALID_PROVIDERS.join(", ")}`,
              );
            }
            return { embeddingProvider: flags.embeddingProvider };
          })()
        : {}),
    };
  }

  return config;
}

async function resolveProviderFromRegistry(
  flags: CliFlags,
  workspace: string,
  taskKind: SelectionTask,
  config: ChampConfig,
): Promise<{
  endpoint: Endpoint;
  model: string;
  credentials: ChainCredentialStore;
  routingMode: "auto" | "manual";
  assignments: Partial<
    Record<TaskAssignment, { endpointId: string; model: string }>
  >;
  endpoints: Endpoint[];
} | null> {
  const repository = new EndpointRepository();
  if (!fs.existsSync(repository.path())) {
    return null;
  }

  const credentials = new ChainCredentialStore();
  const registry = new EndpointRegistry({
    repository,
    credentials,
    discovery: { discoverModels, testEndpoint },
    now: () => new Date().toISOString(),
  });

  let doc;
  try {
    doc = await registry.readDocument();
  } catch (err) {
    process.stderr.write(
      `[champ] could not read ${repository.path()}: ${err instanceof Error ? err.message : String(err)} — falling back to legacy config\n`,
    );
    return null;
  }

  const selector = new ModelSelectionService(repository, (msg) =>
    process.stderr.write(`${msg}\n`),
  );
  const selected = selector.resolveFromDocument(doc, {
    task: taskKind,
    workspaceDir: workspace,
    preferredModel: flags.model,
    currentFile: flags.file,
    routingRules: config.routing?.rules,
  });
  if (!selected) {
    return null;
  }

  return {
    endpoint: selected.endpoint,
    model: selected.model,
    credentials,
    routingMode: doc.routingMode,
    assignments: doc.assignments,
    endpoints: doc.endpoints,
  };
}

/** Print a fatal message and stop the process with the usage exit code. */
function fail(message: string): never {
  process.stderr.write(`champ: ${message}\n`);
  process.exit(EXIT_USAGE);
}

/**
 * Approval prompt on an existing readline (the REPL's). Resolves `false` if
 * the turn is aborted while the prompt is up, so a Ctrl-C cannot wedge the
 * session on a pending question.
 */
function askOn(rl: Readline, description: string): Promise<boolean> {
  return new Promise((resolve) => {
    const signal = activeAbortSignal();
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
    const signal = activeAbortSignal();
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    const finish = (approved: boolean) => {
      signal?.removeEventListener("abort", onAbort);
      rl.close();
      resolve(approved);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finish(false);
      return;
    }
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
  /** No human can answer an approval prompt — ASK is denied, never silently approved. */
  headless?: boolean;
  /** Shared per-process budget, enforced from actual provider usage. */
  budget?: BudgetEnforcer;
  /** Managed/user/project/session policy shared by both clients. */
  policy?: PolicyEngine;
}

/** Shared per-turn options for an interactive session (REPL). */
interface SessionOptions {
  maxIterations?: number;
  /** Session log backing the REPL (null when persistence is off). */
  log: SessionLog | null;
  /** Workspace the session belongs to — used by `/sessions`. */
  workspace: string;
  /** Loaded rules engine for per-turn project/user rules injection. */
  rules: RulesEngine;
  /** Loaded skills registry for REPL slash-command dispatch. */
  registry: SkillRegistry;
  /** Tool registry for per-turn allowedTools scoping. */
  toolRegistry: ToolRegistry;
  /** Optional --file path for skill context and glob rules. */
  file?: string;
  /** Persist the turn's new messages to the session log. */
  onTurnEnd: () => Promise<void>;
  /** Shared per-process budget, enforced from actual provider usage. */
  budget?: BudgetEnforcer;
  /** Managed/user/project/session policy shared by both clients. */
  policy?: PolicyEngine;
}

function warnMissingTools(
  missing: string[],
  skillName: string,
  toolRegistry: ToolRegistry,
): void {
  if (missing.length === 0) return;
  const list = missing.join(", ");
  if (toolRegistry.getAll().length === 0) {
    process.stderr.write(
      `[skills] /${skillName}: declared tools not available in the CLI: ${list} — the turn runs with no tools.\n`,
    );
  } else {
    process.stderr.write(
      `[skills] /${skillName}: declared tools not available in the CLI: ${list} (ignored).\n`,
    );
  }
}

async function runSkillTurn(
  controller: AgentController,
  toolRegistry: ToolRegistry,
  rulesEngine: RulesEngine,
  invocation: ResolvedInvocation,
  currentFile: string | undefined,
  opts: TurnOptions,
): Promise<TurnOutcome> {
  const scope = applyAllowedTools(
    toolRegistry,
    invocation.skill.metadata.allowedTools,
  );
  warnMissingTools(scope.missing, invocation.skill.metadata.name, toolRegistry);
  const previousMode = controller.getMode();
  try {
    if (invocation.mode) controller.setMode(invocation.mode);
    controller.setProjectRules(
      rulesPrompt(rulesEngine, {
        mode: controller.getMode(),
        currentFile,
      }),
    );
    return await runTurn(controller, invocation.prompt, opts);
  } finally {
    scope.restore();
    controller.setMode(previousMode);
    controller.setProjectRules(
      rulesPrompt(rulesEngine, { mode: previousMode, currentFile }),
    );
  }
}

/**
 * Run one user message through the controller: assistant text streams to
 * stdout (machine-readable), tool and token traces go to stderr. Shared with
 * the full-screen TUI through `executeTurn`.
 */
async function runTurn(
  controller: AgentController,
  text: string,
  options: TurnOptions,
): Promise<TurnOutcome> {
  let sawText = false;
  return executeTurn({
    controller,
    text,
    requestApproval: options.requestApproval,
    maxIterations: options.maxIterations,
    headless: options.headless,
    budget: options.budget,
    policy: options.policy,
    onTurnEnd: options.onTurnEnd,
    events: {
      onText: (chunk) => {
        process.stdout.write(chunk);
        sawText = true;
      },
      onTool: (call) => {
        const args = JSON.stringify(call.arguments ?? {});
        const shown = args.length > 200 ? `${args.slice(0, 200)}…` : args;
        process.stderr.write(`\n[tool] ${call.name} ${shown}\n`);
      },
      onError: (message) => process.stderr.write(`\n[error] ${message}\n`),
      onDone: (summary) => {
        if (sawText) process.stdout.write("\n");
        options.onDone(summary);
      },
      onPersistError: (message) =>
        process.stderr.write(`[champ] session save failed: ${message}\n`),
    },
  });
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

/** Translate registry endpoints into the read-only view consumed by the TUI. */
async function endpointSummaries(
  registry: EndpointRegistry,
  credentials: ChainCredentialStore,
): Promise<EndpointSummary[]> {
  const endpoints = await registry.list();
  return Promise.all(
    endpoints.map(async (endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      provider: endpoint.provider,
      baseUrl: endpoint.baseUrl ?? "",
      hasCredential: endpoint.credential
        ? Boolean(await credentials.get(endpoint.credential))
        : false,
      models: endpoint.models.map((model) => model.id),
    })),
  );
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
  // turn in flight aborts first (see executeTurn / abortActiveTurn).
  rl.on("SIGINT", () => {
    if (abortActiveTurn()) return;
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
        case "/skills":
          process.stderr.write(`${formatSkillList(opts.registry)}\n`);
          break;
        default: {
          const { context, notes: ctxNotes } = buildSkillContext(
            opts.workspace,
            "",
            { file: opts.file },
          );
          const resolved = resolveInvocation(opts.registry, trimmed, context);
          if (resolved.kind === "skill") {
            for (const note of [...ctxNotes, ...resolved.invocation.notes]) {
              process.stderr.write(`${note}\n`);
            }
            const outcome = await runSkillTurn(
              controller,
              opts.toolRegistry,
              opts.rules,
              resolved.invocation,
              context.currentFile,
              {
                maxIterations: opts.maxIterations,
                requestApproval: (description) => askOn(rl, description),
                onTurnEnd: opts.onTurnEnd,
                onDone: printSummary,
                budget: opts.budget,
              },
            );
            if (outcome.aborted) {
              process.stderr.write("\n[champ] aborted\n");
            } else if (outcome.error) {
              process.stderr.write(`champ: ${outcome.error}\n`);
            }
          } else if (resolved.kind === "unknown") {
            process.stderr.write(
              `[champ] unknown command /${resolved.name} — /help for the list\n`,
            );
            if (resolved.suggestions.length > 0) {
              const sugg = resolved.suggestions.map((s) => `/${s}`).join(", ");
              process.stderr.write(`[champ] did you mean: ${sugg}\n`);
            }
          } else {
            process.stderr.write(
              `[champ] unknown command ${command} — /help for the list\n`,
            );
          }
          break;
        }
      }
      rl.prompt();
      continue;
    }

    // Approval questions share the REPL interface: readline routes the
    // answer to the question callback while the turn runs.
    const { context: plainCtx } = buildSkillContext(opts.workspace, "", {
      file: opts.file,
    });
    controller.setProjectRules(
      rulesPrompt(opts.rules, {
        mode: controller.getMode(),
        currentFile: plainCtx.currentFile,
      }),
    );
    const outcome = await runTurn(controller, trimmed, {
      maxIterations: opts.maxIterations,
      requestApproval: (description) => askOn(rl, description),
      onTurnEnd: opts.onTurnEnd,
      onDone: printSummary,
      budget: opts.budget,
      policy: opts.policy,
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
  if (parsed.kind === "list-skills") {
    const { registry, problems } = loadCliSkills({
      workspaceRoot: path.resolve(parsed.cwd),
      skipDisk: parsed.noSkills,
    });
    for (const problem of problems) {
      process.stderr.write(`[champ] skill ignored: ${problem}\n`);
    }
    process.stdout.write(`${formatSkillList(registry)}\n`);
    return EXIT_OK;
  }
  if (parsed.kind === "update") {
    return runUpdateCommand(parsed.options);
  }
  if (parsed.kind === "policy-command") {
    let engine: PolicyEngine;
    try {
      engine = createPolicyEngine({
        workspace: path.resolve(parsed.cwd),
        workspaceTrusted: process.env.CHAMP_TRUST_WORKSPACE === "1",
      });
    } catch (err) {
      fail(
        `policy configuration rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return runPolicyCommand(parsed.command, {
      engine,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  }
  if (parsed.kind === "provider-command") {
    const repository = new EndpointRepository();
    const credentials = new ChainCredentialStore();
    const registry = new EndpointRegistry({
      repository,
      credentials,
      discovery: { discoverModels, testEndpoint },
      now: () => new Date().toISOString(),
    });
    const settings = new SettingsRepository({
      configPath: configPath(),
      workspaceDir: path.resolve(parsed.cwd),
      credentials,
      repository,
    });
    return runProviderCommand(parsed.command, {
      registry,
      credentials,
      settings,
      cwd: path.resolve(parsed.cwd),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      migrate: ({ dryRun }) =>
        migrateFromYaml({
          configText: readConfigText(),
          registry,
          credentials,
          dryRun,
        }),
      scrubSecrets: ({ dryRun }) =>
        scrubYamlSecrets({
          configText: readConfigText(),
          registry,
          credentials,
          dryRun,
          writeConfigText: (updatedText) => {
            const target = configPath();
            const tmp = `${target}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, updatedText, {
              encoding: "utf8",
              mode: 0o600,
            });
            fs.renameSync(tmp, target);
          },
        }),
    });
  }

  if (parsed.kind === "index-command") {
    const workspace = path.resolve(parsed.cwd);
    const config = buildConfig(parsed.flags);
    const registryChoice = await resolveProviderFromRegistry(
      parsed.flags,
      workspace,
      "embedding",
      config,
    );
    const credentials =
      registryChoice?.credentials ?? new ChainCredentialStore();
    return runIndexCommand(parsed.command, {
      workspace,
      config,
      endpoints: registryChoice?.endpoints ?? [],
      credentials: {
        get: (key: string) => credentials.get({ kind: "keyring", id: key }),
      },
      embeddingAssignment: registryChoice?.assignments.embedding?.model,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  }

  const { mode, task: taskFromArgv, flags } = parsed.options;

  // ── Resolve the task ──────────────────────────────────────────────────
  let task = taskFromArgv;
  if (mode === "stdin") {
    task = (await readStdin()).trim();
    if (!task) fail("no task given and nothing on stdin");
  }

  // ── Build the agent ───────────────────────────────────────────────────
  const workspace = path.resolve(flags.cwd);
  const config = buildConfig(flags);
  // Budgets are optional; when configured they are enforced from actual
  // provider usage across the whole process (all REPL turns / one shot).
  const budget = config.agent?.budget
    ? new BudgetEnforcer(config.agent.budget, {
        ledger: new FileBudgetLedger(
          path.join(path.dirname(configPath()), "budget-ledger.json"),
        ),
        project: workspace,
      })
    : undefined;
  const hasExplicitEndpointOverride = Boolean(flags.provider || flags.baseUrl);
  const endpointRepository = new EndpointRepository();
  const endpointCredentials = new ChainCredentialStore();
  const endpointRegistry = new EndpointRegistry({
    repository: endpointRepository,
    credentials: endpointCredentials,
    discovery: { discoverModels, testEndpoint },
    now: () => new Date().toISOString(),
  });
  const settings = new SettingsRepository({
    configPath: configPath(),
    workspaceDir: workspace,
    credentials: endpointCredentials,
    repository: endpointRepository,
  });
  const interactive = mode === "tui" || mode === "repl";
  const registryChoice = hasExplicitEndpointOverride
    ? null
    : await resolveProviderFromRegistry(
        flags,
        workspace,
        interactive ? "default" : "coding",
        config,
      );

  let provider;
  if (registryChoice) {
    const secretProvider: SecretReader = {
      get: async (key: string) => {
        if (flags.apiKey) return flags.apiKey;
        return registryChoice.credentials.get({ kind: "keyring", id: key });
      },
    };
    try {
      provider = await new ProviderFactory().createFromEndpoint(
        registryChoice.endpoint,
        {
          model: registryChoice.model,
          secretProvider,
        },
      );
    } catch (err) {
      fail(
        `could not build provider: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    if (!config.provider) {
      fail(
        "no provider configured — set `provider:` in ~/.champ/config.yaml or pass --provider/--base-url",
      );
    }

    const secrets: SecretReader = {
      get: () => Promise.resolve(undefined), // cloud keys come from env vars
    };

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
  }
  let liveController: AgentController | null = null;
  const indexingService = await createCliIndexingService({
    workspaceRoot: workspace,
    config,
    endpoints: registryChoice?.endpoints ?? [],
    credentials: {
      get: (key: string) =>
        endpointCredentials.get({ kind: "keyring", id: key }),
    },
    embeddingAssignment: registryChoice?.assignments.embedding?.model,
    logger: (message) => process.stderr.write(`[rag] ${message}\n`),
  });
  process.once("exit", () => indexingService?.dispose());
  const toolRegistry = createHeadlessToolRegistry({
    credentials: endpointCredentials,
    getAgentController: () => liveController,
    getIndexingService: indexingService
      ? async () => {
          const stats = await indexingService.initialize();
          if (stats) {
            process.stderr.write(
              `[rag] indexed ${stats.chunksIndexed} chunks with ${stats.embeddingModel}\n`,
            );
          }
          return indexingService.isReady() ? indexingService : null;
        }
      : undefined,
  });
  if (config.mcp?.servers?.length) {
    try {
      await loadHeadlessMcpServers(toolRegistry, config.mcp.servers, {
        secrets: createCliMcpSecretResolver(endpointCredentials),
        onError: (server, error) =>
          process.stderr.write(`[mcp] ${server}: ${error}\n`),
      });
    } catch (err) {
      process.stderr.write(
        `[mcp] could not load servers: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  const controller = new AgentController(provider, toolRegistry, workspace);
  liveController = controller;
  const cliContext = createCliContext(workspace);

  let policy: PolicyEngine;
  try {
    policy = createPolicyEngine({
      workspace,
      // No CLI workspace-trust UI exists: project grants require an explicit
      // opt-in, while managed/user DENY rules always apply.
      workspaceTrusted: process.env.CHAMP_TRUST_WORKSPACE === "1",
    });
  } catch (err) {
    fail(
      `policy configuration rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  controller.setMode(config.agent?.defaultMode ?? "agent");
  if (
    registryChoice &&
    registryChoice.routingMode === "auto" &&
    !flags.model &&
    (registryChoice.assignments.coding || registryChoice.assignments.chat)
  ) {
    const cliRouter = new SmartRouter();
    const factory = new ProviderFactory();
    const secretProvider: SecretReader = {
      get: async (key: string) =>
        flags.apiKey ??
        registryChoice.credentials.get({ kind: "keyring", id: key }),
    };
    cliRouter.registerProvider(
      registryChoice.endpoint.name,
      provider,
      registryChoice.endpoint.provider,
      registryChoice.endpoint.baseUrl,
    );
    const staticModels: import("./providers/smart-router").DiscoveredModel[] =
      [];
    for (const ep of registryChoice.endpoints) {
      if (!ep.enabled) continue;
      if (ep.id !== registryChoice.endpoint.id) {
        try {
          const epProv = await factory.createFromEndpoint(ep, {
            model: ep.models[0]?.id ?? "",
            secretProvider,
          });
          cliRouter.registerProvider(ep.name, epProv, ep.provider, ep.baseUrl);
        } catch {
          continue;
        }
      }
      for (const m of ep.models) {
        const caps = (m.capabilities ?? [
          "coding",
          "general",
        ]) as import("./providers/smart-router").ModelCapability[];
        staticModels.push({
          id: m.id,
          providerName: ep.name,
          providerType: ep.provider,
          capabilities: caps,
          speed: "medium",
          contextWindow: m.contextWindow ?? ep.contextWindow ?? 8192,
          sizeHint: "",
          quantizationLevel: "",
          source: "discovered",
        });
      }
    }
    if (staticModels.length > 0) {
      cliRouter.registerStaticModels(staticModels);
      if (registryChoice.assignments.coding?.model) {
        cliRouter.setTaskModel(
          "coding",
          registryChoice.assignments.coding.model,
        );
      }
      if (registryChoice.assignments.chat?.model) {
        cliRouter.setTaskModel("chat", registryChoice.assignments.chat.model);
      }
      controller.setSmartRouter(cliRouter);
    }
  }
  const rulesEngine = await loadCliRules({
    workspaceRoot: workspace,
    userRules: config.userRules,
  });
  const skills = loadCliSkills({
    workspaceRoot: workspace,
    skipDisk: flags.noSkills,
  });
  for (const problem of skills.problems) {
    process.stderr.write(`[champ] skill ignored: ${problem}\n`);
  }

  // ── Session persistence ───────────────────────────────────────────────
  // `--session <id>` opts a run into the append-only session log, resuming
  // when the log exists. The REPL always keeps one: the user is in it.
  let sessionLog: SessionLog | null = null;
  let isResuming = false;
  try {
    if (flags.session) {
      sessionLog =
        (await SessionLog.open(workspace, flags.session)) ??
        (await SessionLog.create(workspace, {
          id: flags.session,
          model: provider.config.model,
          mode: controller.getMode(),
        }));
    } else if (interactive) {
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
      isResuming = true;
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

  // Same grounding the extension attaches: a lazy workspace outline plus the
  // workspace-local and user-level memory banks. Loading is best-effort — a
  // corrupt memory file must never prevent a turn from running. On a resumed
  // session the checkpoint is the context boundary, so workspace memory (which
  // may contain pre-checkpoint turns) is deliberately not re-injected.
  await Promise.allSettled([
    cliContext.memoryBank.load(),
    cliContext.globalMemoryBank.load(),
  ]);
  controller.setRepoMapProvider(cliContext.repoMapProvider);
  if (!isResuming) controller.setMemoryBank(cliContext.memoryBank);
  controller.setGlobalMemoryBank(cliContext.globalMemoryBank);

  const onSigint = () => {
    if (!abortActiveTurn()) process.exit(EXIT_ABORTED);
  };
  process.on("SIGINT", onSigint);

  // Approval policy: a human can answer only in the REPL or a TTY one-shot.
  // In headless runs ASK is DENIED — it is never silently approved. Auto-
  // approval requires an explicit opt-in (`--yes` or yoloMode), so a piped
  // run cannot accidentally gain destructive access.
  const canPrompt =
    interactive || (mode === "oneshot" && Boolean(process.stdin.isTTY));
  const yolo = config.agent?.yoloMode === true;
  const autoApprove = flags.yes || yolo;
  const headless = !canPrompt && !autoApprove;
  const requestApproval = async (description: string): Promise<boolean> => {
    if (headless) return false;
    return autoApprove ? true : askFresh(description);
  };

  if (headless) {
    process.stderr.write(
      "[champ] non-interactive run without --yes: actions requiring approval are denied (pass --yes to auto-approve)\n",
    );
  }

  let code: number;
  try {
    if (mode === "tui") {
      const initialEndpoints = await endpointSummaries(
        endpointRegistry,
        endpointCredentials,
      );

      const submitFromTui = async (
        text: string,
        events: TuiTurnEvents,
        askApproval: (description: string) => Promise<boolean>,
      ) => {
        const trimmed = text.trim();
        if (!trimmed)
          return { text: "", aborted: false, status: "success" as TurnStatus };

        if (trimmed.startsWith("/")) {
          const [command, ...rest] = trimmed.split(/\s+/);
          if (command === "/session") {
            events.onText?.(`[champ] ${sessionInfo(sessionLog)}\n`);
            return {
              text: "",
              aborted: false,
              status: "success" as TurnStatus,
            };
          }
          if (command === "/sessions") {
            events.onText?.(await sessionsReport(workspace));
            return {
              text: "",
              aborted: false,
              status: "success" as TurnStatus,
            };
          }
          if (command === "/checkpoint") {
            if (!sessionLog) {
              events.onError?.("no session for this run");
              return {
                text: "",
                aborted: false,
                status: "success" as TurnStatus,
              };
            }
            const checkpoint = await sessionLog.markCheckpoint({
              label: rest.join(" ") || undefined,
            });
            events.onText?.(
              `[champ] checkpoint "${checkpoint.label}" at ${checkpoint.upTo} messages\n`,
            );
            return {
              text: "",
              aborted: false,
              status: "success" as TurnStatus,
            };
          }
          if (command === "/compact") {
            if (!sessionLog?.checkpoint) {
              events.onError?.(
                "nothing to compact — record a /checkpoint first",
              );
              return {
                text: "",
                aborted: false,
                status: "success" as TurnStatus,
              };
            }
            await sessionLog.compact();
            events.onText?.(
              `[champ] compacted ${sessionLog.id} to "${sessionLog.checkpoint.label}"\n`,
            );
            return {
              text: "",
              aborted: false,
              status: "success" as TurnStatus,
            };
          }
          if (command === "/skills") {
            events.onText?.(`${formatSkillList(skills.registry)}\n`);
            return {
              text: "",
              aborted: false,
              status: "success" as TurnStatus,
            };
          }
        }

        const { context, notes } = buildSkillContext(workspace, "", {
          file: flags.file,
        });
        for (const note of notes) events.onText?.(`${note}\n`);
        const resolved = resolveInvocation(skills.registry, trimmed, context);
        if (resolved.kind === "unknown") {
          const suggestion = resolved.suggestions.length
            ? ` Did you mean ${resolved.suggestions.map((s) => `/${s}`).join(", ")}?`
            : "";
          events.onError?.(`unknown command /${resolved.name}.${suggestion}`);
          return { text: "", aborted: false, status: "success" as TurnStatus };
        }

        const turnOptions = {
          requestApproval: autoApprove ? async () => true : askApproval,
          maxIterations: flags.maxIterations,
          budget,
          policy,
          onTurnEnd,
        };
        const runEvents = {
          onText: events.onText,
          onTool: (call: {
            name: string;
            arguments?: Record<string, unknown>;
          }) => {
            const args = JSON.stringify(call.arguments ?? {});
            const shown = args.length > 200 ? `${args.slice(0, 200)}…` : args;
            events.onTool?.(call.name, shown);
          },
          onError: events.onError,
          onDone: (summary: { tools: number; usage: TokenUsage }) =>
            events.onDone?.({
              tools: summary.tools,
              inputTokens: summary.usage.inputTokens,
              outputTokens: summary.usage.outputTokens,
            }),
        };

        if (resolved.kind === "skill") {
          const scope = applyAllowedTools(
            toolRegistry,
            resolved.invocation.skill.metadata.allowedTools,
          );
          warnMissingTools(
            scope.missing,
            resolved.invocation.skill.metadata.name,
            toolRegistry,
          );
          const previousMode = controller.getMode();
          try {
            if (resolved.invocation.mode) {
              controller.setMode(resolved.invocation.mode);
            }
            return await executeTurn({
              controller,
              text: resolved.invocation.prompt,
              ...turnOptions,
              events: runEvents,
            });
          } finally {
            scope.restore();
            controller.setMode(previousMode);
          }
        }

        controller.setProjectRules(
          rulesPrompt(rulesEngine, {
            mode: controller.getMode(),
            currentFile: context.currentFile,
          }),
        );
        return executeTurn({
          controller,
          text: trimmed,
          ...turnOptions,
          events: runEvents,
        });
      };

      const tuiRuntime: TuiRuntime = {
        header: {
          version: cliVersion(),
          model: provider.config.model ?? "unknown",
          workspace,
          sessionId: sessionLog?.id,
          routingMode: registryChoice?.routingMode ?? "auto",
        },
        initialEndpoints,
        initialScreen: initialEndpoints.length === 0 ? "providers" : "chat",
        submit: submitFromTui,
        abort: () => {
          abortActiveTurn();
        },
        refreshEndpoints: () =>
          endpointSummaries(endpointRegistry, endpointCredentials),
        addEndpoint: async (input) => {
          if (!isProviderKind(input.provider)) {
            throw new Error(`unknown provider "${input.provider}"`);
          }
          const endpoint = await endpointRegistry.add({
            name: input.name,
            provider: input.provider,
            baseUrl: input.baseUrl,
            credential: input.credentialId
              ? { kind: "keyring", id: input.credentialId }
              : undefined,
            models: input.model ? [{ id: input.model }] : undefined,
          });
          if (input.apiKey) {
            const status = await endpointRegistry.setCredential(
              endpoint.id,
              input.apiKey,
            );
            if (!status.persisted) {
              process.stderr.write(
                `[champ] credential not persisted: ${status.reason ?? "unknown"}\n`,
              );
            }
          }
          try {
            await endpointRegistry.discover(endpoint.id);
          } catch {
            // Manual model entry still works when discovery is unavailable.
          }
          return `Added ${endpoint.name} (${endpoint.id})`;
        },
        selectModel: async (endpointId, model) => {
          const selected = await selectActiveModel(
            endpointRegistry,
            endpointId,
            model,
          );
          if (!selected.ok) throw new Error(selected.reason);
          return `Model ${selected.model} is now active`;
        },
        testEndpoint: async (endpointId) => {
          const result = await endpointRegistry.test(endpointId);
          const detail = result.error ?? result.detail ?? "";
          return `${result.ok ? "ok" : "FAIL"} ${endpointId}${result.statusCode ? ` status=${result.statusCode}` : ""}${result.latencyMs ? ` ${result.latencyMs}ms` : ""}${detail ? ` — ${detail}` : ""}`;
        },
        validate: async () => {
          const diagnostics = await settings.validate();
          return diagnostics.map((d) => `${d.level}\t${d.code}\t${d.message}`);
        },
        doctor: async () => {
          const report = await settings.doctor();
          const lines = [
            ...report.checks.map(
              (check) =>
                `${check.ok ? "ok" : "FAIL"}\t${check.name}\t${check.detail}`,
            ),
            ...report.diagnostics
              .filter((d) => d.level !== "info")
              .map((d) => `${d.level}\t${d.code}\t${d.message}`),
          ];
          return { healthy: report.healthy, lines };
        },
        exportRedacted: () => settings.export({ redact: true }),
        exit: () => {
          process.exitCode = EXIT_OK;
        },
      };

      await runTui(tuiRuntime);
      code = EXIT_OK;
    } else if (mode === "repl") {
      code = await runRepl(
        controller,
        {
          maxIterations: flags.maxIterations,
          log: sessionLog,
          workspace,
          rules: rulesEngine,
          registry: skills.registry,
          toolRegistry,
          file: flags.file,
          onTurnEnd,
          budget,
          policy,
        },
        `Champ ${cliVersion()} — model ${provider.config.model ?? "?"}. /help for commands.`,
      );
    } else {
      const { context: skillCtx, notes: ctxNotes } = buildSkillContext(
        workspace,
        "",
        { file: flags.file },
      );
      const effectiveTask = flags.skill
        ? `/${flags.skill}${task ? ` ${task}` : ""}`
        : task!;
      const resolved = resolveInvocation(
        skills.registry,
        effectiveTask,
        skillCtx,
      );

      if (resolved.kind === "unknown") {
        process.stderr.write(
          `[champ] unknown command /${resolved.name} — /help for the list\n`,
        );
        if (resolved.suggestions.length > 0) {
          const sugg = resolved.suggestions.map((s) => `/${s}`).join(", ");
          process.stderr.write(`[champ] did you mean: ${sugg}\n`);
        }
        code = EXIT_USAGE;
      } else {
        let outcome: TurnOutcome;
        if (resolved.kind === "skill") {
          for (const note of [...ctxNotes, ...resolved.invocation.notes]) {
            process.stderr.write(`${note}\n`);
          }
          outcome = await runSkillTurn(
            controller,
            toolRegistry,
            rulesEngine,
            resolved.invocation,
            skillCtx.currentFile,
            {
              requestApproval,
              maxIterations: flags.maxIterations,
              onTurnEnd,
              onDone: printSummary,
              headless,
              budget,
              policy,
            },
          );
        } else {
          controller.setProjectRules(
            rulesPrompt(rulesEngine, {
              mode: controller.getMode(),
              currentFile: skillCtx.currentFile,
            }),
          );
          outcome = await runTurn(controller, task!, {
            requestApproval,
            maxIterations: flags.maxIterations,
            onTurnEnd,
            onDone: printSummary,
            headless,
            budget,
            policy,
          });
        }
        if (outcome.status === "cancelled") code = EXIT_ABORTED;
        else if (outcome.status === "failed" || outcome.status === "partial") {
          process.stderr.write(`champ: ${outcome.error ?? "turn failed"}\n`);
          code = EXIT_FAILURE;
        } else code = EXIT_OK;
      }
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
