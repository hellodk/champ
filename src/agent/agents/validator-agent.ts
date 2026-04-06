/**
 * ValidatorAgent: runs lint/typecheck/tests via the terminal tool.
 *
 * Does not call the LLM. Reads diffs from the CodeAgent and runs
 * configured validation commands. A non-zero exit code from any command
 * marks the validation as failed.
 */
import type { Agent, AgentInput, AgentOutput, SharedMemory } from "./types";
import type { ToolRegistry } from "../../tools/registry";
import type { ToolExecutionContext } from "../../tools/types";

export interface ValidatorConfig {
  /** Shell commands to run for validation. Default: lint + typecheck + test. */
  commands?: Array<{ name: string; command: string }>;
  /** Workspace root. Defaults to process.cwd(). */
  workspaceRoot?: string;
}

const DEFAULT_COMMANDS = [
  { name: "lint", command: "npm run lint --silent" },
  { name: "typecheck", command: "npm run check-types --silent" },
  { name: "test", command: "npm run test --silent" },
];

export class ValidatorAgent implements Agent {
  readonly name = "validator";
  readonly role =
    "runs lint, typecheck, and tests to validate proposed changes";

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly config: ValidatorConfig = {},
  ) {}

  async execute(
    _input: AgentInput,
    memory: SharedMemory,
  ): Promise<AgentOutput> {
    const commands = this.config.commands ?? DEFAULT_COMMANDS;
    const workspaceRoot = this.config.workspaceRoot ?? process.cwd();
    const context: ToolExecutionContext = {
      workspaceRoot,
      abortSignal: new AbortController().signal,
      reportProgress: () => {},
      // Validation commands run without user prompting.
      requestApproval: async () => true,
    };

    const results: Array<{ name: string; success: boolean; output: string }> =
      [];
    let overallSuccess = true;

    for (const { name, command } of commands) {
      const result = await this.toolRegistry.execute(
        "run_terminal_cmd",
        { command },
        context,
      );
      results.push({ name, success: result.success, output: result.output });
      if (!result.success) {
        overallSuccess = false;
      }
    }

    const summary = results
      .map((r) => `${r.name}: ${r.success ? "PASS" : "FAIL"}`)
      .join(", ");
    const details = results
      .filter((r) => !r.success)
      .map((r) => `=== ${r.name} ===\n${r.output}`)
      .join("\n\n");

    const output: AgentOutput = {
      success: overallSuccess,
      output: overallSuccess
        ? `Validation passed: ${summary}`
        : `Validation failed: ${summary}\n\n${details}`,
      passed: overallSuccess,
    };

    memory.setOutput(this.name, output);
    return output;
  }
}
