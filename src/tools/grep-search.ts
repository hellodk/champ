/**
 * grep_search tool: regex content search via ripgrep.
 *
 * Prefers the ripgrep binary bundled with VS Code, falling back to the
 * system `rg` on PATH. Output is capped and formatted as
 * file:line:match for easy parsing by the LLM.
 */
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";

const MAX_OUTPUT_BYTES = 20_000;

/**
 * Locate the ripgrep binary. VS Code ships one at
 * appRoot/node_modules/@vscode/ripgrep/bin/rg. Falls back to `rg` on PATH.
 */
function findRipgrep(): string {
  try {
    const bundled = path.join(
      vscode.env.appRoot ?? "",
      "node_modules",
      "@vscode",
      "ripgrep",
      "bin",
      process.platform === "win32" ? "rg.exe" : "rg",
    );
    if (bundled && fs.existsSync(bundled)) {
      return bundled;
    }
  } catch {
    // Fall through to PATH lookup.
  }
  return "rg";
}

export const grepSearchTool: Tool = {
  name: "grep_search",
  description:
    "Fast regex search across the workspace using ripgrep. Returns file:line:match entries.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Regex pattern to search for",
      },
      includePattern: {
        type: "string",
        description: 'Glob of files to include (e.g., "*.ts")',
      },
      excludePattern: {
        type: "string",
        description: 'Glob of files to exclude (e.g., "node_modules")',
      },
      caseSensitive: {
        type: "string",
        description: "Whether the search is case-sensitive (true/false)",
      },
    },
    required: ["query"],
  },
  requiresApproval: false,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = args.query as string;
    const includePattern = args.includePattern as string | undefined;
    const excludePattern = args.excludePattern as string | undefined;
    const caseSensitive = args.caseSensitive as boolean | undefined;

    const rgArgs: string[] = [
      "--line-number",
      "--with-filename",
      "--no-heading",
      "--color=never",
      "--max-count=100",
    ];
    if (caseSensitive === false) rgArgs.push("--ignore-case");
    if (includePattern) rgArgs.push("--glob", includePattern);
    if (excludePattern) rgArgs.push("--glob", `!${excludePattern}`);
    rgArgs.push("--", query, context.workspaceRoot);

    return new Promise<ToolResult>((resolve) => {
      let rgPath: string;
      try {
        rgPath = findRipgrep();
      } catch {
        rgPath = "rg";
      }

      let stdout = "";
      let stderr = "";

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(rgPath, rgArgs, {
          cwd: context.workspaceRoot,
          signal: context.abortSignal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolve({
          success: true,
          output: `No matches (ripgrep unavailable: ${msg})`,
        });
        return;
      }

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += chunk.toString();
        }
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", () => {
        // ripgrep not available or failed to spawn; treat as "no matches".
        resolve({
          success: true,
          output: "No matches found (ripgrep unavailable)",
        });
      });

      proc.on("close", (code) => {
        // ripgrep exits with 0 if matches found, 1 if none, 2+ on error.
        if (code === 1 || (code === 0 && !stdout.trim())) {
          resolve({ success: true, output: "No matches found" });
          return;
        }
        if (code !== null && code > 1) {
          resolve({
            success: false,
            output: `ripgrep error (exit ${code}): ${stderr.slice(0, 2000)}`,
          });
          return;
        }
        const capped =
          stdout.length >= MAX_OUTPUT_BYTES
            ? stdout.slice(0, MAX_OUTPUT_BYTES) + "\n\n[truncated]"
            : stdout;
        resolve({ success: true, output: capped || "No matches found" });
      });
    });
  },
};
