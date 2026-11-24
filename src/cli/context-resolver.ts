/**
 * Headless @-reference resolution for the CLI, REPL and TUI.
 *
 * The VS Code extension builds a ContextResolver with editor-aware deps in
 * `extension.ts`. The terminal has no editor, but still needs @Web, @Files,
 * @Folders, @Codebase and @Git to behave the same way. This adapter wires the
 * shared resolver to plain Node filesystem/shell helpers and the CLI's own
 * web_search tool — nothing here imports `vscode`.
 */
import * as fs from "fs/promises";
import * as nodePath from "path";
import {
  ContextResolver,
  type ContextReference,
} from "../agent/context-resolver";

export interface CliContextResolverDeps {
  workspaceRoot: string;
  indexingService: { search(query: string, topK?: number): Promise<unknown[]> };
  webSearchTool: {
    execute(args: Record<string, unknown>): Promise<{
      success: boolean;
      output: string;
    }>;
  };
}

export interface CliContextResolver {
  parseReferences(text: string): ContextReference[];
  /** Append resolved reference content after the user's original text. */
  resolve(text: string): Promise<string>;
}

export function createCliContextResolver(
  deps: CliContextResolverDeps,
): CliContextResolver {
  const resolver = new ContextResolver({
    workspaceRoot: deps.workspaceRoot,
    indexingService: deps.indexingService,
    webSearchTool: deps.webSearchTool,
    fileReader: {
      readFile: (absPath) => fs.readFile(absPath, "utf8"),
      readdir: async (absPath) => {
        const entries = await fs.readdir(absPath, { withFileTypes: true });
        return entries.map((entry) => [
          entry.name,
          entry.isDirectory() ? ("directory" as const) : ("file" as const),
        ]);
      },
    },
    runShellCommand: async (cmd, cwd) => {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const { stdout } = await promisify(execFile)("sh", ["-c", cmd], {
        cwd,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout;
    },
    docsReader: {
      readPackageDocs: async (packageName) => {
        const candidate = nodePath.join(
          deps.workspaceRoot,
          "node_modules",
          packageName,
          "README.md",
        );
        try {
          const text = await fs.readFile(candidate, "utf8");
          return text.split("\n").slice(0, 200).join("\n");
        } catch {
          return null;
        }
      },
    },
  });

  return {
    parseReferences: (text) => resolver.parseReferences(text),
    resolve: async (text) => {
      const refs = resolver.parseReferences(text);
      if (refs.length === 0) return text;
      const resolved = await resolver.resolve(refs);
      if (resolved.length === 0) return text;
      const blocks = resolved.map(
        (item) => `[${item.type}: ${item.label}]\n${item.content}`,
      );
      return `${text}\n\n${blocks.join("\n\n")}`;
    },
  };
}
