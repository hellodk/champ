/**
 * Headless team runner for CI/cron.
 *
 * Usage:
 *   node dist/scripts/run-team.js \
 *     --team <name> --task "<text>" \
 *     [--provider ollama|claude] [--workspace <path>]
 *
 * Env vars:
 *   ANTHROPIC_API_KEY  — required for --provider claude
 *   OLLAMA_BASE_URL    — default: http://localhost:11434
 *   OLLAMA_MODEL       — default: llama3.1
 *
 * Exit codes: 0=success, 1=failure
 */
import * as path from "path";

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
      "Usage: node run-team.js --team <name> --task <text> [--provider ollama|claude] [--workspace <path>]",
    );
    process.exit(1);
  }

  const { TeamLoader } = await import("../src/agent/team-loader.js");
  const { TeamRunner } = await import("../src/agent/team-runner.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");

  const loader = new TeamLoader(workspaceArg);
  const teams = await loader.loadAll();
  const team = teams.find((t) => t.name === teamArg);
  if (!team) {
    console.error(
      `Team "${teamArg}" not found in ${path.join(workspaceArg, ".champ", "teams")}`,
    );
    process.exit(1);
  }

  let provider;
  if (providerArg === "claude") {
    const { ClaudeProvider } = await import("../src/providers/claude.js");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY required for claude provider");
      process.exit(1);
    }
    provider = new ClaudeProvider({
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      apiKey,
      maxTokens: 8192,
      temperature: 0.2,
    });
  } else {
    const { OllamaProvider } = await import("../src/providers/ollama.js");
    provider = new OllamaProvider({
      provider: "ollama",
      model: process.env.OLLAMA_MODEL ?? "llama3.1",
      baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      maxTokens: 8192,
      temperature: 0.2,
    });
  }

  const toolRegistry = new ToolRegistry();
  const runner = new TeamRunner();

  console.log(`\nRunning team "${team.name}" on task: ${taskArg}\n`);

  const state = await runner.run(team, taskArg, provider, toolRegistry, {
    workspaceRoot: workspaceArg,
    onEvent: (e) => {
      if (e.type === "agent_stream") process.stdout.write(e.chunk);
      else if (e.type === "state_update") {
        const r = e.state.agents.find((a) => a.status === "running");
        if (r) process.stderr.write(`\n[${r.name}] running...\n`);
      } else if (e.type === "budget_warning") {
        process.stderr.write(
          `\n[warn] Token budget: ${e.usedTokens}/${e.budgetTokens}\n`,
        );
      } else if (e.type === "blocked") {
        process.stderr.write(`\n[blocked] ${e.agentId}: ${e.reason}\n`);
      } else if (e.type === "error") {
        process.stderr.write(`\n[error] ${e.message}\n`);
      }
    },
  });

  console.log(`\nFinal status: ${state.status}`);
  process.exit(state.status === "failed" || state.status === "paused" ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
