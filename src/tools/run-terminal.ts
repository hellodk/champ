/**
 * run_terminal_cmd tool: executes a shell command and captures output.
 *
 * Uses child_process.spawn with bash -c for output capture. Commands
 * are passed through the CommandSandbox before execution. Output is
 * capped and timeout-enforced to prevent runaway commands.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import { CommandSandbox } from "../safety/command-sandbox";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 15_000;

const sandbox = new CommandSandbox();

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

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const command = args.command as string;
    const timeoutMs =
      (args.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;

    // Sandbox check first — this happens even after approval as a safety net.
    const check = sandbox.check(command);
    if (!check.allowed) {
      return {
        success: false,
        output: `Command blocked by safety sandbox: ${check.reason}`,
      };
    }

    return new Promise<ToolResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;

      // Fall back to the process cwd if the workspace root doesn't exist
      // on disk. spawn() emits ENOENT when the cwd is missing, which is
      // confusing and hides the real error output.
      const cwd = fs.existsSync(context.workspaceRoot)
        ? context.workspaceRoot
        : process.cwd();

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("bash", ["-c", command], {
          cwd,
          env: { ...process.env, TERM: "dumb" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolve({ success: false, output: `Failed to spawn command: ${msg}` });
        return;
      }

      // Enforce timeout manually so we can report it distinctly from other
      // kill scenarios.
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);

      const abortHandler = () => proc.kill("SIGTERM");
      context.abortSignal.addEventListener("abort", abortHandler);

      proc.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutBytes += text.length;
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += text;
        }
        context.reportProgress(text);
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrBytes += text.length;
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += text;
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        context.abortSignal.removeEventListener("abort", abortHandler);
        resolve({ success: false, output: `Command failed: ${err.message}` });
      });

      proc.on("close", (code, signal) => {
        clearTimeout(timeoutHandle);
        context.abortSignal.removeEventListener("abort", abortHandler);

        const sections: string[] = [];
        if (stdout.trim()) {
          const capped =
            stdoutBytes > MAX_OUTPUT_BYTES
              ? stdout.slice(0, MAX_OUTPUT_BYTES) + "\n[truncated]"
              : stdout;
          sections.push(`STDOUT:\n${capped}`);
        }
        if (stderr.trim()) {
          const capped =
            stderrBytes > MAX_OUTPUT_BYTES
              ? stderr.slice(0, MAX_OUTPUT_BYTES) + "\n[truncated]"
              : stderr;
          sections.push(`STDERR:\n${capped}`);
        }
        if (timedOut) {
          sections.push(
            `Command timed out and was killed after ${timeoutMs}ms`,
          );
        }
        sections.push(
          `Exit code: ${code ?? (signal ? `signal ${signal}` : "unknown")}`,
        );

        resolve({
          success: code === 0 && !timedOut,
          output: sections.join("\n\n"),
        });
      });
    });
  },
};
