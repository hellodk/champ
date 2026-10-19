/**
 * Headless (VSCode-free) implementations of the seven fs/search tools.
 *
 * These are the CLI's counterparts to `src/tools/{read,edit,create,delete}-file`,
 * `list-directory`, `grep-search` and `file-search`, which depend on the VS Code
 * workspace API (`vscode.workspace.fs`, `findFiles`, `vscode.env.appRoot`) and
 * therefore cannot run outside the editor.
 *
 * Design notes:
 * - Tool names, parameter schemas and messages mirror the VS Code tools so the
 *   model sees one consistent surface in both environments.
 * - Path validation reuses `resolveInWorkspace` (symlink-aware boundary check).
 * - `grep_search` is a pure-Node walk: it must not depend on `rg` or VS Code's
 *   bundled ripgrep, so it works on a bare `champ` install. Output keeps the
 *   `path:line:content` shape ripgrep produces.
 * - `delete_file` enforces the documented "files only" rule (the VS Code tool
 *   never did), keeping the blast radius small.
 *
 * Must not import `vscode` — `src/cli.ts` bundles this module.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import type {
  Tool,
  ToolResult,
  ToolExecutionContext,
  ToolPreview,
} from "../types";
import { resolveInWorkspace } from "../../utils/workspace-path";
import { formatNumberedLines } from "../../utils/line-numbering";
import {
  buildEditPreview,
  findFuzzyMatch,
  formatNotFoundError,
} from "../../utils/edit-match";

/** Directory names never walked or searched. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "out",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".worktrees",
  "graphify-out",
  ".superpowers",
  ".champ",
]);

/** Hard cap on files touched by a single `grep_search` / `file_search` call. */
const MAX_FILES_SCANNED = 50_000;
/** Hard cap on grep matches reported back to the model. */
const MAX_GREP_RESULTS = 100;
/** Hard cap on grep output bytes (matches the VS Code tool's cap). */
const MAX_GREP_BYTES = 20_000;
/** Files larger than this are skipped by grep. */
const MAX_GREP_FILE_BYTES = 2_000_000;
/**
 * Files larger than this are read as a bounded prefix by `read_file`: the
 * formatter only emits `DEFAULT_READ_MAX_LINES` lines, so reading a
 * multi-hundred-MB file whole (and splitting it into every line) is a memory
 * spike for output nobody sees. Mirrors the grep guard.
 */
const MAX_READ_FILE_BYTES = 2_000_000;
/** Max files returned by `file_search` (matches the VS Code tool). */
const MAX_FILE_SEARCH_RESULTS = 10;

/** Read at most `maxBytes` from the start of `file`, cutting on a line boundary. */
async function readPrefix(file: string, maxBytes: number): Promise<string> {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf-8");
    // Drop the last (possibly partial) line so no half line — or half UTF-8
    // sequence — is reported as file content.
    const lastNewline = text.lastIndexOf("\n");
    return lastNewline > 0 ? text.slice(0, lastNewline) : text;
  } finally {
    await handle.close();
  }
}

function refused(relativePath: string): ToolResult {
  return {
    success: false,
    output: `Refused: "${relativePath}" is outside workspace`,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve a relative path against the workspace root or reject it. */
function resolveOrRefuse(
  context: ToolExecutionContext,
  relativePath: string,
): string | null {
  return resolveInWorkspace(context.workspaceRoot, relativePath);
}

/** True for directory entries, following symlinks to their target. */
function isDirectoryEntry(dir: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Convert a glob pattern to a RegExp over a workspace-relative path.
 * Supports `*` (no slash), `**` (crossing directories), `?`, and escapes
 * regex metacharacters. A pattern with no `/` matches at any depth, and a
 * pattern with a `/` is anchored to the root of the workspace.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        // Consume a following slash so `**/*.ts` == `**` + `*.ts`.
        if (pattern[i + 1] === "/") i++;
        source += ".*";
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      source += "\\" + c;
    } else {
      source += c;
    }
  }
  // A bare `*.ts` should match `src/a.ts` as well as `a.ts`, but not `a.tsx`.
  const hasWildcard = /[*?]/.test(pattern);
  if (!hasWildcard) {
    // Plain names (e.g. `node_modules`) act as a path-segment prefix.
    return new RegExp(`^(?:.*[\\/])?${source}`);
  }
  if (!pattern.includes("/")) return new RegExp(`^(?:.*[\\/])?${source}$`);
  return new RegExp(`^${source}$`);
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export const headlessReadFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file at a given path. Returns the file content with line numbers prefixed.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file from workspace root",
      },
      startLine: {
        type: "number",
        description: "Optional start line (1-based, inclusive)",
      },
      endLine: {
        type: "number",
        description: "Optional end line (1-based, inclusive)",
      },
    },
    required: ["path"],
  },
  requiresApproval: false,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const relativePath = args.path as string;
    const resolved = resolveOrRefuse(context, relativePath);
    if (!resolved) return refused(relativePath);

    try {
      // Staged content (already edited this turn) is the ground truth.
      const staged = context.stagedEdits?.getCurrent(resolved);
      let content: string;
      let sizeNote = "";
      if (staged !== undefined) {
        content = staged;
      } else {
        const stat = await fsp.stat(resolved);
        if (stat.size > MAX_READ_FILE_BYTES) {
          // Read a bounded prefix rather than the whole file: the formatter
          // emits at most DEFAULT_READ_MAX_LINES lines anyway, so a huge file
          // would only cost memory (see external review 4b).
          content = await readPrefix(resolved, MAX_READ_FILE_BYTES);
          sizeNote = `\n\n[${relativePath}: file is ${stat.size} bytes; showing the first ${MAX_READ_FILE_BYTES}]`;
        } else {
          content = await fsp.readFile(resolved, "utf-8");
        }
      }

      const output =
        formatNumberedLines(
          content,
          args.startLine as number | undefined,
          args.endLine as number | undefined,
        ) + sizeNote;
      return { success: true, output };
    } catch (err) {
      return {
        success: false,
        output: `File not found or unreadable: ${relativePath} (${errorMessage(err)})`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export const headlessEditFileTool: Tool = {
  name: "edit_file",
  description:
    "Edit a file by replacing specific content. Provide the exact old content to find and the new content to replace it with.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to workspace root",
      },
      old_content: {
        type: "string",
        description: "Exact content to find and replace",
      },
      new_content: {
        type: "string",
        description: "New content to replace with",
      },
    },
    required: ["path", "old_content", "new_content"],
  },
  requiresApproval: true,

  getPreview(args: Record<string, unknown>): ToolPreview | undefined {
    return buildEditPreview(
      (args.old_content as string) ?? "",
      (args.new_content as string) ?? "",
      (args.path as string) ?? "file",
    );
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const relativePath = args.path as string;
    const oldContent = args.old_content as string;
    const newContent = args.new_content as string;

    const resolved = resolveOrRefuse(context, relativePath);
    if (!resolved) return refused(relativePath);

    try {
      const staging = context.stagedEdits;
      const text =
        staging?.getCurrent(resolved) ??
        (await fsp.readFile(resolved, "utf-8"));

      let matchStart: number;
      let matchEnd: number;
      let fuzzyWarning: string | undefined;

      const firstIdx = text.indexOf(oldContent);
      if (firstIdx === -1) {
        const fuzzyMatch = findFuzzyMatch(text, oldContent);
        if (fuzzyMatch === null) {
          return {
            success: false,
            output: formatNotFoundError(relativePath, text, oldContent),
          };
        }
        matchStart = fuzzyMatch.start;
        matchEnd = fuzzyMatch.end;
        const matchLine = text.slice(0, matchStart).split("\n").length;
        fuzzyWarning = `Note: exact match not found — applied fuzzy match at line ${matchLine}. Review carefully.`;
      } else {
        if (text.indexOf(oldContent, firstIdx + 1) !== -1) {
          return {
            success: false,
            output: `Ambiguous match: old_content appears multiple times in ${relativePath}. Provide a longer, unique snippet that includes more surrounding context.`,
          };
        }
        matchStart = firstIdx;
        matchEnd = firstIdx + oldContent.length;
      }

      const newText =
        text.slice(0, matchStart) + newContent + text.slice(matchEnd);

      if (staging) {
        // Buffer: flushed to disk once the turn completes.
        staging.stage(resolved, text, newText, relativePath);
      } else {
        await fsp.writeFile(resolved, newText, "utf-8");
        context.editReviewTracker?.record({
          path: relativePath,
          oldContent: text,
          newContent: newText,
        });
      }

      const base = staging
        ? `Staged edit for ${relativePath} (will write when turn completes)`
        : `Successfully edited ${relativePath}`;
      const successMsg = fuzzyWarning ? `${base}\n${fuzzyWarning}` : base;

      context.auditLog?.record("file_edit", `edit:${relativePath}`);
      return {
        success: true,
        output: successMsg,
        metadata: {
          filesModified: [relativePath],
          fileEditDiff: {
            path: relativePath,
            oldContent: text,
            newContent: newText,
          },
        },
      };
    } catch (err) {
      return {
        success: false,
        output: `Error editing ${relativePath}: ${errorMessage(err)}`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// create_file
// ---------------------------------------------------------------------------

export const headlessCreateFileTool: Tool = {
  name: "create_file",
  description:
    "Create a new file with the given content. Parent directories are created if needed.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to workspace root",
      },
      content: {
        type: "string",
        description: "Content to write to the new file",
      },
    },
    required: ["path", "content"],
  },
  requiresApproval: true,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const relativePath = args.path as string;
    const content = args.content as string;

    const resolved = resolveOrRefuse(context, relativePath);
    if (!resolved) return refused(relativePath);

    try {
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, content, "utf-8");
      context.auditLog?.record("file_edit", `create:${relativePath}`);
      return {
        success: true,
        output: `Created ${relativePath}`,
        metadata: { filesCreated: [relativePath] },
      };
    } catch (err) {
      return {
        success: false,
        output: `Failed to create ${relativePath}: ${errorMessage(err)}`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// delete_file
// ---------------------------------------------------------------------------

export const headlessDeleteFileTool: Tool = {
  name: "delete_file",
  description: "Delete a file from the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to workspace root",
      },
    },
    required: ["path"],
  },
  requiresApproval: true,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const relativePath = args.path as string;

    const resolved = resolveOrRefuse(context, relativePath);
    if (!resolved) return refused(relativePath);

    try {
      const stat = await fsp.stat(resolved).catch(() => null);
      if (stat?.isDirectory()) {
        return {
          success: false,
          output: `Refused: "${relativePath}" is a directory. delete_file only removes files.`,
        };
      }
      await fsp.unlink(resolved);
      context.auditLog?.record("file_edit", `delete:${relativePath}`);
      return {
        success: true,
        output: `Deleted ${relativePath}`,
        metadata: { filesDeleted: [relativePath] },
      };
    } catch (err) {
      return {
        success: false,
        output: `Failed to delete ${relativePath}: ${errorMessage(err)}`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

export const headlessListDirectoryTool: Tool = {
  name: "list_directory",
  description:
    "List files and subdirectories at a given path. Returns entries with type indicators.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          'Directory path relative to workspace root (use "." for root)',
      },
    },
    required: ["path"],
  },
  requiresApproval: false,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const relativePath = args.path as string;

    const resolved = resolveOrRefuse(context, relativePath);
    if (!resolved) return refused(relativePath);

    try {
      const entries = await fsp.readdir(resolved, { withFileTypes: true });

      if (entries.length === 0) {
        return { success: true, output: `${relativePath} is empty` };
      }

      const formatted = entries
        .map((entry) =>
          isDirectoryEntry(resolved, entry) ? `${entry.name}/` : entry.name,
        )
        .sort()
        .join("\n");

      return { success: true, output: formatted };
    } catch (err) {
      return {
        success: false,
        output: `Could not list ${relativePath}: ${errorMessage(err)}`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// grep_search
// ---------------------------------------------------------------------------

export const headlessGrepSearchTool: Tool = {
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
        type: "boolean",
        description: "Whether the search is case-sensitive (default: false)",
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
    if (!query) return { success: true, output: "No matches found" };

    let regex: RegExp;
    try {
      regex = new RegExp(query, args.caseSensitive === false ? "i" : "");
    } catch (err) {
      return {
        success: false,
        output: `Invalid regex: ${errorMessage(err)}`,
      };
    }

    const includeRe = args.includePattern
      ? globToRegExp(args.includePattern as string)
      : null;
    const excludeRe = args.excludePattern
      ? globToRegExp(args.excludePattern as string)
      : null;

    const root = context.workspaceRoot;
    const matches: string[] = [];
    let truncated = false;
    let scanned = 0;
    const queue: string[] = [root];

    outer: while (queue.length > 0) {
      if (context.abortSignal.aborted) break;
      const dir = queue.pop()!;

      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable dir — skip, don't fail the search
      }

      for (const entry of entries) {
        if (context.abortSignal.aborted) break outer;
        const full = path.join(dir, entry.name);

        if (isDirectoryEntry(dir, entry)) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(full);
          continue;
        }
        if (!entry.isFile()) continue;

        const rel = path.relative(root, full).split(path.sep).join("/");
        if (rel.startsWith("..")) continue;
        if (includeRe && !includeRe.test(rel)) continue;
        if (excludeRe && excludeRe.test(rel)) continue;
        if (++scanned > MAX_FILES_SCANNED) break outer;

        let text: string;
        try {
          if (fs.statSync(full).size > MAX_GREP_FILE_BYTES) continue;
          text = await fsp.readFile(full, "utf-8");
        } catch {
          continue;
        }
        if (text.includes("\0")) continue; // binary

        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push(`${rel}:${i + 1}:${lines[i]}`);
            if (matches.length >= MAX_GREP_RESULTS) {
              truncated = true;
              break outer;
            }
          }
        }
      }
    }

    if (matches.length === 0)
      return { success: true, output: "No matches found" };

    const joined = matches.join("\n");
    const capped =
      joined.length > MAX_GREP_BYTES
        ? joined.slice(0, MAX_GREP_BYTES) + "\n\n[truncated]"
        : joined;
    return {
      success: true,
      output: truncated ? `${capped}\n\n[truncated]` : capped,
    };
  },
};

// ---------------------------------------------------------------------------
// file_search
// ---------------------------------------------------------------------------

export const headlessFileSearchTool: Tool = {
  name: "file_search",
  description:
    "Search for files by name (fuzzy match). Returns up to 10 matching file paths.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Partial file name to search for",
      },
    },
    required: ["query"],
  },
  requiresApproval: false,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { success: true, output: "No files found for empty query" };
    }

    const needle = query.toLowerCase();
    const root = context.workspaceRoot;
    const found: string[] = [];
    let scanned = 0;
    const queue: string[] = [root];

    outer: while (queue.length > 0) {
      if (context.abortSignal.aborted) break;
      const dir = queue.pop()!;

      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (context.abortSignal.aborted) break outer;
        const full = path.join(dir, entry.name);

        if (isDirectoryEntry(dir, entry)) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (++scanned > MAX_FILES_SCANNED) break outer;

        const rel = path.relative(root, full).split(path.sep).join("/");
        if (rel.startsWith("..")) continue;
        if (rel.toLowerCase().includes(needle)) {
          found.push(rel);
          if (found.length >= MAX_FILE_SEARCH_RESULTS) break outer;
        }
      }
    }

    if (found.length === 0) {
      return { success: true, output: `No files found matching "${query}"` };
    }
    return { success: true, output: found.join("\n") };
  },
};

/** The seven fs/search tools implemented against Node `fs`. */
export const headlessFsTools: Tool[] = [
  headlessReadFileTool,
  headlessEditFileTool,
  headlessCreateFileTool,
  headlessDeleteFileTool,
  headlessListDirectoryTool,
  headlessGrepSearchTool,
  headlessFileSearchTool,
];
