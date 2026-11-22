/**
 * run_terminal_cmd tool: executes a shell command and captures output.
 *
 * Execution goes through an ExecutionBackend: a declared filesystem scope,
 * explicit environment allowlist, resource limits and process-tree
 * termination. The regex sandboxes remain as pre-execution filters.
 */
import * as fs from "fs";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import { CommandSandbox } from "../safety/command-sandbox";
import { AdvancedCommandSandbox } from "../safety/advanced-command-sandbox";
import {
  createExecutionBackend,
  type ExecutionBackend,
} from "../safety/execution-backend";
import { PolicyEngine } from "../policy/engine";
import { terminalOutputBuffer } from "../agent/terminal-output-buffer";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 15_000;
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TMPDIR"];

const sandbox = new CommandSandbox();
const advancedSandbox = new AdvancedCommandSandbox({
  workspacePath: process.cwd(),
  allowedWorkspacePaths: [process.cwd()],
});

let defaultBackend: ExecutionBackend | undefined;
function getDefaultBackend(): ExecutionBackend {
  defaultBackend ??= createExecutionBackend();
  return defaultBackend;
}

export const runTerminalTool: Tool = {
  name: "run_terminal_cmd",
  description:
    "Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 30000)",
      },
    },
    required: ["command"],
  },
  requiresApproval: true,

  getPreview(
    args: Record<string, unknown>,
  ): import("./types").ToolPreview | undefined {
    const command = args.command as string | undefined;
    if (!command) return undefined;
    return { type: "command", content: command, label: "Run terminal" };
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const command = args.command as string;
    const timeoutMs =
      (args.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;

    const policy =
      context.policy ??
      (context.sessionPolicy
        ? new PolicyEngine({ session: context.sessionPolicy })
        : undefined);
    if (policy) {
      const evaluation = policy.evaluate(
        { kind: "shell", id: command, args },
        { headless: context.headless === true },
      );
      if (evaluation.decision === "DENY") {
        return {
          success: false,
          output: `Command denied by policy (${evaluation.source}): ${evaluation.reason}`,
        };
      }
    }

    // Sandbox check first — this happens even after approval as a safety net.
    const check = sandbox.check(command);
    if (!check.allowed) {
      return {
        success: false,
        output: `Command blocked by safety sandbox: ${check.reason}`,
      };
    }

    // Defense-in-depth: advanced sandbox enforces path/allowlist restrictions
    // only when an explicit allowlist/denylist is configured, so it does not
    // block legitimate commands in the default permissive mode.
    if (advancedSandbox.isRestrictedMode()) {
      const advCheck = advancedSandbox.check(command);
      if (!advCheck.allowed) {
        return {
          success: false,
          output: `Command blocked by advanced sandbox: ${advCheck.reason}`,
        };
      }
    }

    // Fall back to the process cwd if the workspace root doesn't exist on disk.
    const cwd = fs.existsSync(context.workspaceRoot)
      ? context.workspaceRoot
      : process.cwd();

    const result = await (
      context.executionBackend ?? getDefaultBackend()
    ).execute({
      command,
      shell: "bash",
      cwd,
      allowedPaths: [cwd],
      allowNetwork: false,
      envAllowlist: ENV_ALLOWLIST,
      env: { TERM: "dumb" },
      limits: { timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES },
      abortSignal: context.abortSignal,
      onOutput: (stream, text) => {
        if (stream === "stdout") context.reportProgress(text);
      },
    });

    const sections: string[] = [];
    if (result.stdout.trim()) sections.push(`STDOUT:\n${result.stdout}`);
    if (result.stderr.trim()) sections.push(`STDERR:\n${result.stderr}`);
    if (result.truncated) sections.push("[truncated]");
    if (result.timedOut) {
      sections.push(`Command timed out and was killed after ${timeoutMs}ms`);
    }
    sections.push(
      `Exit code: ${result.exitCode ?? (result.signal ? `signal ${result.signal}` : "unknown")}`,
    );

    // Write combined output to shared buffer so @Terminal context can read it.
    terminalOutputBuffer.write(result.output);

    return {
      success: result.exitCode === 0 && !result.timedOut,
      output: sections.join("\n\n"),
    };
  },
};
