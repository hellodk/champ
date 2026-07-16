/**
 * remote_run_terminal_cmd tool: executes a shell command on a remote host via SSH.
 *
 * Uses ssh2-sftp-client to establish SSH connection and execute commands.
 * Commands are passed through the CommandSandbox before execution. Output is
 * capped and timeout-enforced to prevent runaway commands.
 *
 * Remote target format: "user@host:port" (port defaults to 22)
 */
import { exec } from "child_process";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import { CommandSandbox } from "../safety/command-sandbox";
import { terminalOutputBuffer } from "../agent/terminal-output-buffer";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 15_000;

const sandbox = new CommandSandbox();

/**
 * Parse SSH remote target format: "user@host:port" or "user@host"
 * Returns { user, host, port } or null if invalid format.
 */
function parseRemoteTarget(remote: string): {
  user: string;
  host: string;
  port: number;
} | null {
  const match = remote.match(/^([^@]+)@([^:]+)(?::(\d+))?$/);
  if (!match) return null;

  const [, user, host, portStr] = match;
  const port = portStr ? parseInt(portStr, 10) : 22;

  if (!user || !host || isNaN(port) || port < 1 || port > 65535) {
    return null;
  }

  return { user, host, port };
}

export const remoteRunTerminalTool: Tool = {
  name: "remote_run_terminal_cmd",
  description:
    "Execute a shell command on a remote host via SSH. Returns stdout, stderr, and exit code.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      remote: {
        type: "string",
        description:
          "Remote target in format 'user@host:port' (port defaults to 22)",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 30000)",
      },
    },
    required: ["command", "remote"],
  },
  requiresApproval: true,

  getPreview(
    args: Record<string, unknown>,
  ): import("./types").ToolPreview | undefined {
    const command = args.command as string | undefined;
    const remote = args.remote as string | undefined;
    if (!command || !remote) return undefined;
    return {
      type: "command",
      content: `SSH: ${remote}\n${command}`,
      label: "Run remote terminal",
    };
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const command = args.command as string;
    const remote = args.remote as string;
    const timeoutMs =
      (args.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;

    // Validate remote format
    if (!remote || remote.trim().length === 0) {
      return {
        success: false,
        output: 'Error: "remote" parameter is required',
      };
    }

    const parsed = parseRemoteTarget(remote);
    if (!parsed) {
      return {
        success: false,
        output: `Invalid remote target format: "${remote}". Expected format: user@host or user@host:port`,
      };
    }

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

      // Construct SSH command using ssh executable
      const sshCmd = `ssh -p ${parsed.port} ${parsed.user}@${parsed.host} "${command.replace(/"/g, '\\"')}"`;

      let child: ReturnType<typeof exec> | null = null;
      try {
        child = exec(sshCmd, { timeout: timeoutMs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolve({
          success: false,
          output: `Failed to spawn SSH command: ${msg}`,
        });
        return;
      }

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child) child.kill("SIGKILL");
      }, timeoutMs);

      const abortHandler = () => {
        if (child) child.kill("SIGTERM");
      };
      context.abortSignal.addEventListener("abort", abortHandler);

      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stdoutBytes += text.length;
          if (stdout.length < MAX_OUTPUT_BYTES) {
            stdout += text;
          }
          context.reportProgress(text);
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stderrBytes += text.length;
          if (stderr.length < MAX_OUTPUT_BYTES) {
            stderr += text;
          }
        });
      }

      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        context.abortSignal.removeEventListener("abort", abortHandler);
        resolve({
          success: false,
          output: `SSH command failed: ${err.message}`,
        });
      });

      child.on("close", (code, signal) => {
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

        // Write combined output to shared buffer so @Terminal context can read it.
        const fullOutput = [stdout, stderr].filter(Boolean).join("\n");
        terminalOutputBuffer.write(fullOutput);

        resolve({
          success: code === 0 && !timedOut,
          output: sections.join("\n\n"),
        });
      });
    });
  },
};
