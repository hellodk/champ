/**
 * Headless team runner with live terminal UI.
 *
 * Usage:
 *   node dist/scripts/run-team.js \
 *     --team <name> --task "<text>" \
 *     [--provider ollama|llamacpp|claude] [--workspace <path>]
 *
 * Env vars:
 *   OLLAMA_BASE_URL    — default: http://127.0.0.1:11434
 *   OLLAMA_MODEL       — default: qwen3:8b
 *   LLAMACPP_BASE_URL  — default: http://localhost:8080/v1
 *   LLAMACPP_MODEL     — required for llamacpp
 *   ANTHROPIC_API_KEY  — required for claude
 *
 * Exit codes: 0=success, 1=failure
 */
import * as path from "path";

// ── Terminal colours ──────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
};

const AGENT_COLORS = [C.cyan, C.yellow, C.magenta, C.green, C.blue, C.white];
const agentColorMap = new Map<string, string>();
let colorIdx = 0;

function agentColor(id: string): string {
  if (!agentColorMap.has(id)) {
    agentColorMap.set(id, AGENT_COLORS[colorIdx++ % AGENT_COLORS.length]);
  }
  return agentColorMap.get(id)!;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Box drawing ───────────────────────────────────────────────────────────────
const W = 68; // box width

function boxTop(): string {
  return C.bold + C.blue + "╔" + "═".repeat(W - 2) + "╗" + C.reset;
}
function boxBottom(): string {
  return C.bold + C.blue + "╚" + "═".repeat(W - 2) + "╝" + C.reset;
}
function boxSep(): string {
  return C.blue + "╠" + "═".repeat(W - 2) + "╣" + C.reset;
}
function boxRow(content: string): string {
  const visible = stripAnsi(content).length;
  const pad = Math.max(0, W - 2 - visible - 1);
  return (
    C.blue +
    "║" +
    C.reset +
    " " +
    content +
    " ".repeat(pad) +
    C.blue +
    "║" +
    C.reset
  );
}

function divider(label = ""): string {
  const inner = label ? ` ${label} ` : "";
  const dashes = "─".repeat(Math.max(0, W - 2 - inner.length));
  return (
    C.gray +
    "──" +
    C.reset +
    C.bold +
    inner +
    C.reset +
    C.gray +
    dashes +
    C.reset
  );
}

// ── Status icons ──────────────────────────────────────────────────────────────
const ICON: Record<string, string> = {
  pending: C.gray + "○" + C.reset,
  running: C.yellow + "◉" + C.reset,
  done: C.green + "✓" + C.reset,
  failed: C.red + "✗" + C.reset,
  blocked: C.red + "⊘" + C.reset,
  skipped: C.gray + "—" + C.reset,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function elapsed(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const teamArg = get("--team");
  const taskArg = get("--task");
  const providerArg = get("--provider") ?? "ollama";
  const workspaceArg = get("--workspace") ?? process.cwd();

  if (!teamArg || !taskArg) {
    console.error(
      "Usage: node run-team.js --team <name> --task <text> [--provider ollama|llamacpp|claude] [--workspace <path>]",
    );
    process.exit(1);
  }

  const { TeamLoader } = await import("../src/agent/team-loader.js");
  const { TeamRunner } = await import("../src/agent/team-runner.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");

  const toolRegistry = new ToolRegistry();
  const loader = new TeamLoader(workspaceArg);
  const runner = new TeamRunner();
  const teams = await loader.loadAll();
  const team = teams.find((t) => t.name === teamArg);
  if (!team) {
    console.error(
      `Team "${teamArg}" not found in ${path.join(workspaceArg, ".champ", "teams")}`,
    );
    process.exit(1);
  }

  // ── Provider selection ──────────────────────────────────────────────────────
  let provider;
  let modelLabel: string;

  if (providerArg === "claude") {
    const { ClaudeProvider } = await import("../src/providers/claude.js");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY required for claude provider");
      process.exit(1);
    }
    const model = "claude-sonnet-4-20250514";
    provider = new ClaudeProvider({
      provider: "claude",
      model,
      apiKey,
      maxTokens: 8192,
      temperature: 0.2,
    });
    modelLabel = `${model} @ Anthropic`;
  } else if (providerArg === "llamacpp") {
    const { LlamaCppProvider } = await import("../src/providers/llamacpp.js");
    const baseUrl = process.env.LLAMACPP_BASE_URL ?? "http://localhost:8080/v1";
    const model = process.env.LLAMACPP_MODEL ?? "";
    provider = new LlamaCppProvider({
      provider: "llamacpp",
      model,
      baseUrl,
      maxTokens: 2048,
      temperature: 0.2,
    });
    modelLabel = `${model || "(auto)"} @ ${baseUrl}`;
  } else {
    const { OllamaProvider } = await import("../src/providers/ollama.js");
    const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    const model = process.env.OLLAMA_MODEL ?? "qwen3:8b";
    provider = new OllamaProvider({
      provider: "ollama",
      model,
      baseUrl,
      maxTokens: 4096,
      temperature: 0.2,
    });
    modelLabel = `${model} @ ${baseUrl}`;
  }

  // ── Print header ─────────────────────────────────────────────────────────────
  console.log();
  console.log(boxTop());
  console.log(boxRow(C.bold + C.white + "  CHAMP TEAM RUN" + C.reset));
  console.log(boxSep());
  console.log(boxRow(C.gray + "  Team  " + C.reset + truncate(team.name, 54)));
  console.log(boxRow(C.gray + "  Task  " + C.reset + truncate(taskArg, 54)));
  console.log(boxRow(C.gray + "  Model " + C.reset + truncate(modelLabel, 54)));
  console.log(
    boxRow(
      C.gray +
        "  Mode  " +
        C.reset +
        (team.execution?.mode ?? "auto") +
        C.gray +
        "   Agents " +
        C.reset +
        String(team.agents.length) +
        C.gray +
        "   Parallel " +
        C.reset +
        String(team.execution?.maxParallel ?? 4),
    ),
  );
  console.log(boxBottom());
  console.log();

  // ── Print agent list ──────────────────────────────────────────────────────────
  console.log(divider("AGENTS"));
  for (const a of team.agents) {
    const col = agentColor(a.id);
    const deps = a.dependsOn?.length
      ? C.gray + ` ← ${a.dependsOn.join(", ")}` + C.reset
      : "";
    console.log(
      `  ${ICON["pending"]}  ${col}${C.bold}${a.name.padEnd(14)}${C.reset}  ${C.dim}${a.role ?? ""}${C.reset}${deps}`,
    );
  }
  console.log();

  // ── Event tracking ────────────────────────────────────────────────────────────
  const startTimes = new Map<string, number>();
  const announced = new Set<string>(); // agents whose "started" banner was shown
  const completed = new Set<string>(); // agents whose "done" banner was shown
  let midLine = false; // true if last write didn't end with \n
  const runStart = Date.now();
  let totalTokens = 0;

  // Lookup agent name by id
  const agentName = (id: string) =>
    team.agents.find((a) => a.id === id)?.name ?? id;

  function ensureNewLine(): void {
    if (midLine) {
      process.stdout.write("\n");
      midLine = false;
    }
  }

  const state = await runner.run(team, taskArg, provider, toolRegistry, {
    workspaceRoot: workspaceArg,
    onEvent: (e) => {
      if (e.type === "state_update") {
        // Detect newly-running agents
        for (const a of e.state.agents) {
          if (a.status === "running" && !announced.has(a.id)) {
            announced.add(a.id);
            startTimes.set(a.id, Date.now());
            ensureNewLine();
            const col = agentColor(a.id);
            console.log(
              divider(`${col}${C.bold}${agentName(a.id)}${C.reset}  starting`),
            );
          }
          // Detect newly-completed agents
          if (
            (a.status === "done" || a.status === "failed") &&
            !completed.has(a.id)
          ) {
            completed.add(a.id);
            const t = startTimes.get(a.id);
            const dur = t ? elapsed(Date.now() - t) : "?";
            const usage =
              (e.state as any).agents?.find?.((x: any) => x.id === a.id)
                ?.tokenCount ?? 0;
            totalTokens += usage;
            ensureNewLine();
            const col = agentColor(a.id);
            const icon = a.status === "done" ? ICON["done"] : ICON["failed"];
            const stat =
              a.status === "done"
                ? C.green + "done" + C.reset
                : C.red + "FAILED" + C.reset;
            console.log(
              `  ${icon}  ${col}${C.bold}${agentName(a.id).padEnd(14)}${C.reset}  ${stat}  ${C.gray}${dur}${usage ? `  ${usage} tok` : ""}${C.reset}`,
            );
            console.log();
          }
        }
      } else if (e.type === "agent_stream") {
        const col = agentColor(e.agentId);
        const name = agentName(e.agentId);
        const prefix = `${col}[${name}]${C.reset} `;
        // Prefix each line in the chunk
        const chunk = e.chunk;
        if (!midLine) {
          process.stdout.write(prefix);
        }
        // Replace interior newlines with newline + prefix (except trailing)
        const lines = chunk.split("\n");
        for (let i = 0; i < lines.length; i++) {
          process.stdout.write(lines[i]);
          if (i < lines.length - 1) {
            process.stdout.write(
              "\n" +
                (lines[i + 1] !== undefined && i + 1 < lines.length - 1
                  ? prefix
                  : lines.length > 1 &&
                      i + 1 === lines.length - 1 &&
                      lines[lines.length - 1] === ""
                    ? ""
                    : prefix),
            );
          }
        }
        midLine = !chunk.endsWith("\n");
      } else if (e.type === "blocked") {
        ensureNewLine();
        console.log(
          `  ${ICON["blocked"]}  ${C.yellow}${agentName(e.agentId)}${C.reset}  ${C.gray}blocked: ${e.reason}${C.reset}`,
        );
      } else if (e.type === "budget_warning") {
        ensureNewLine();
        console.log(
          `  ${C.yellow}⚠ token budget:${C.reset} ${e.usedTokens.toLocaleString()} / ${e.budgetTokens.toLocaleString()}`,
        );
      } else if (e.type === "error") {
        ensureNewLine();
        console.log(
          `  ${ICON["failed"]}  ${C.red}error:${C.reset} ${e.message}`,
        );
      }
    },
  });

  // ── Final summary ─────────────────────────────────────────────────────────────
  ensureNewLine();
  console.log();

  const totalDur = elapsed(Date.now() - runStart);
  const ok = state.status === "completed";
  const doneIcon = ok ? ICON["done"] : ICON["failed"];
  const doneCol = ok ? C.green : C.red;

  console.log(C.bold + C.blue + "═".repeat(W) + C.reset);
  const summary =
    `  ${doneIcon}  ` +
    doneCol +
    C.bold +
    state.status.toUpperCase() +
    C.reset +
    C.gray +
    "   " +
    team.agents.length +
    " agents" +
    C.reset +
    (totalTokens
      ? C.gray + "   " + totalTokens.toLocaleString() + " tokens" + C.reset
      : "") +
    C.gray +
    "   " +
    totalDur +
    C.reset;
  console.log(summary);
  console.log(C.bold + C.blue + "═".repeat(W) + C.reset);
  console.log();

  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
