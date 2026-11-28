/**
 * Activity categorization, grouping, short model labels, and compact turn
 * telemetry formatting for the turn-based TUI transcript (#212).
 *
 * Pure and Ink-free so every presentation rule is directly unit-testable.
 */
import type { TuiTurnSummary } from "./runtime";
import { redactToolText, type ToolRecord } from "./tool-events";

export type TranscriptVerbosity = "low" | "medium" | "high";

export const TRANSCRIPT_VERBOSITIES: readonly TranscriptVerbosity[] = [
  "low",
  "medium",
  "high",
] as const;

export interface TranscriptDisplayConfig {
  verbosity: TranscriptVerbosity;
  showModel: boolean;
  showUsage: boolean;
  showContext: boolean;
  showCost: boolean;
}

export const DEFAULT_TRANSCRIPT_CONFIG: TranscriptDisplayConfig = {
  verbosity: "low",
  showModel: true,
  showUsage: true,
  showContext: true,
  showCost: true,
};

export function isTranscriptVerbosity(
  value: unknown,
): value is TranscriptVerbosity {
  return value === "low" || value === "medium" || value === "high";
}

export function nextVerbosity(
  current: TranscriptVerbosity,
): TranscriptVerbosity {
  const index = TRANSCRIPT_VERBOSITIES.indexOf(current);
  return TRANSCRIPT_VERBOSITIES[(index + 1) % TRANSCRIPT_VERBOSITIES.length];
}

export type ActivityCategory =
  | "read"
  | "search"
  | "edit"
  | "command"
  | "test"
  | "git"
  | "web"
  | "delegate"
  | "mcp"
  | "thinking"
  | "other";

export interface ActivityEntry {
  id: string;
  kind: "tool" | "reasoning";
  category: ActivityCategory;
  /** References `state.toolRecords[toolId]` as the single source of truth. */
  toolId?: string;
  toolName?: string;
  reasoningText?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: "running" | "done" | "failed";
}

export interface ActivityGroup {
  id: string;
  entries: ActivityEntry[];
}

export interface FormattedActivityStep {
  icon: string;
  label: string;
  status: "running" | "done" | "failed";
  meta?: string;
  errorPreview?: string;
}

export interface ActivityGroupSummary {
  summary: string;
  runningLabel?: string;
  failedCount: number;
  totalCount: number;
  durationMs: number;
  testHighlight?: { passed: boolean; text: string };
}

const READ_TOOLS = new Set(["read_file", "list_directory"]);
const SEARCH_TOOLS = new Set(["grep_search", "file_search", "codebase_search"]);
const EDIT_TOOLS = new Set([
  "edit_file",
  "create_file",
  "delete_file",
  "write_file",
  "generate_doc",
  "generate_diagram",
]);
const COMMAND_TOOLS = new Set([
  "run_terminal_cmd",
  "run_terminal",
  "bash",
  "shell",
]);
const WEB_TOOLS = new Set(["web_search", "fetch_url", "browser"]);
const DELEGATE_TOOLS = new Set([
  "delegate_task",
  "delegate",
  "spawn_subagent",
  "subagent",
]);

const MODEL_FILE_EXTENSIONS = /\.(gguf|bin|safetensors|onnx|pt)$/i;
const MAX_TARGET_LENGTH = 60;

export function categorizeTool(name: string): ActivityCategory {
  if (READ_TOOLS.has(name)) return "read";
  if (SEARCH_TOOLS.has(name)) return "search";
  if (EDIT_TOOLS.has(name)) return "edit";
  if (COMMAND_TOOLS.has(name)) return "command";
  if (name === "run_tests") return "test";
  if (name === "git") return "git";
  if (WEB_TOOLS.has(name)) return "web";
  if (DELEGATE_TOOLS.has(name)) return "delegate";
  if (name.startsWith("mcp_")) return "mcp";
  return "other";
}

/**
 * Derive a clean display name for local GGUF paths, HuggingFace cache folders,
 * and org-qualified model IDs while leaving full paths intact in model details.
 */
export function shortModelName(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return "";

  const normalized = trimmed.replace(/\\/g, "/");
  let base = normalized;

  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    const parts = normalized.split("/").filter(Boolean);
    base = parts[parts.length - 1] ?? normalized;
  } else if (normalized.includes("/")) {
    const parts = normalized.split("/").filter(Boolean);
    base = parts[parts.length - 1] ?? normalized;
  }

  if (base.startsWith("models--")) {
    const segments = base.split("--").filter(Boolean);
    base = segments[segments.length - 1] ?? base;
  }

  return base.replace(MODEL_FILE_EXTENSIONS, "");
}

function clampText(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (limit <= 0) return "";
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function parseArgsObject(argsJson: string): Record<string, unknown> | null {
  if (!argsJson || !argsJson.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON or partial args fall back to redacted plain text.
  }
  return null;
}

function stringProp(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return redactToolText(value.trim());
    }
  }
  return undefined;
}

export function extractToolTarget(
  name: string,
  argsJson: string,
  maxLength = MAX_TARGET_LENGTH,
): string {
  const obj = parseArgsObject(argsJson);
  if (!obj) {
    const raw = redactToolText(argsJson).trim();
    return raw && raw !== "{}" ? clampText(raw, maxLength) : "";
  }

  if (name === "read_file") {
    const filePath = stringProp(obj, ["path", "filePath", "file_path"]);
    if (!filePath) return "";
    const start = typeof obj.startLine === "number" ? obj.startLine : undefined;
    const end = typeof obj.endLine === "number" ? obj.endLine : undefined;
    const range =
      start !== undefined
        ? end !== undefined
          ? `:${start}-${end}`
          : `:${start}`
        : "";
    return clampText(`${filePath}${range}`, maxLength);
  }

  if (
    name === "list_directory" ||
    name === "edit_file" ||
    name === "create_file" ||
    name === "delete_file" ||
    name === "write_file"
  ) {
    return clampText(
      stringProp(obj, ["path", "filePath", "file_path", "directory"]) ?? "",
      maxLength,
    );
  }

  if (name === "generate_doc" || name === "generate_diagram") {
    return clampText(stringProp(obj, ["filename", "title"]) ?? "", maxLength);
  }

  if (
    name === "grep_search" ||
    name === "file_search" ||
    name === "codebase_search" ||
    name === "web_search"
  ) {
    const query = stringProp(obj, ["query", "pattern"]);
    return query ? clampText(`"${query}"`, maxLength) : "";
  }

  if (COMMAND_TOOLS.has(name)) {
    return clampText(stringProp(obj, ["command", "cmd"]) ?? "", maxLength);
  }

  if (name === "run_tests") {
    return clampText(stringProp(obj, ["pattern"]) ?? "", maxLength);
  }

  if (name === "git") {
    const action = stringProp(obj, ["action"]);
    const detail = stringProp(obj, ["message", "title", "type"]);
    const combined = [action, detail].filter(Boolean).join(" ");
    return clampText(combined, maxLength);
  }

  if (name === "fetch_url") {
    return clampText(stringProp(obj, ["url"]) ?? "", maxLength);
  }

  if (name === "browser") {
    const action = stringProp(obj, ["action"]);
    const detail = stringProp(obj, ["url", "selector"]);
    return clampText([action, detail].filter(Boolean).join(" "), maxLength);
  }

  if (DELEGATE_TOOLS.has(name)) {
    const task = stringProp(obj, ["task", "prompt"]);
    return task ? clampText(`"${task}"`, maxLength) : "";
  }

  const first = Object.values(obj).find(
    (value): value is string =>
      typeof value === "string" && value.trim() !== "",
  );
  return first ? clampText(redactToolText(first), maxLength) : "";
}

export function formatCompactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function verbForTool(name: string, running: boolean): string {
  switch (name) {
    case "read_file":
      return running ? "Reading" : "Read";
    case "list_directory":
      return running ? "Listing" : "List";
    case "grep_search":
      return running ? "Searching" : "Search";
    case "file_search":
      return running ? "Finding" : "Find";
    case "codebase_search":
      return running ? "Searching codebase" : "Semantic search";
    case "edit_file":
    case "write_file":
      return running ? "Editing" : "Edit";
    case "create_file":
      return running ? "Creating" : "Create";
    case "delete_file":
      return running ? "Deleting" : "Delete";
    case "generate_doc":
      return running ? "Writing doc" : "Write doc";
    case "generate_diagram":
      return running ? "Generating diagram" : "Diagram";
    case "run_terminal_cmd":
    case "run_terminal":
    case "bash":
    case "shell":
      return running ? "Running" : "Run";
    case "run_tests":
      return running ? "Running tests" : "Tests";
    case "git":
      return running ? "Running git" : "Git";
    case "web_search":
      return running ? "Searching web" : "Web search";
    case "fetch_url":
      return running ? "Fetching" : "Fetch";
    case "browser":
      return running ? "Browsing" : "Browser";
    case "delegate_task":
      return running ? "Delegating" : "Delegate";
    default:
      if (name.startsWith("mcp_")) {
        const cleaned = name.slice(4).replace(/_/g, ":");
        return running ? `Running ${cleaned}` : `MCP ${cleaned}`;
      }
      return running ? `Running ${name}` : name;
  }
}

export function formatActivityStep(
  entry: ActivityEntry,
  toolRecords: Record<string, ToolRecord>,
  maxWidth = 72,
): FormattedActivityStep {
  if (entry.kind === "reasoning") {
    const duration =
      entry.durationMs !== undefined && entry.durationMs > 0
        ? formatCompactDuration(entry.durationMs)
        : undefined;
    return {
      icon: entry.status === "running" ? "⠋" : "·",
      label: entry.status === "running" ? "Thinking…" : "Thought",
      status: entry.status,
      ...(duration ? { meta: duration } : {}),
    };
  }

  const record = entry.toolId ? toolRecords[entry.toolId] : undefined;
  const name = record?.start.name ?? entry.toolName ?? "tool";
  const target = record
    ? extractToolTarget(name, record.start.args, Math.max(20, maxWidth - 24))
    : "";
  const running = entry.status === "running";
  const icon = running ? "⠋" : entry.status === "failed" ? "✗" : "✓";

  let label = target
    ? `${verbForTool(name, running)} ${target}`
    : verbForTool(name, running);
  if (running) label = `${label}…`;

  if (!running && name === "run_tests" && record?.result?.testsSummary) {
    const summary = record.result.testsSummary;
    label = record.result.success
      ? `Tests passed (${summary.passed})`
      : `Tests failed (${summary.failed} failed${summary.passed > 0 ? `, ${summary.passed} passed` : ""})`;
  }

  const metaParts: string[] = [];
  if (record?.result?.exitCode !== undefined && record.result.exitCode !== 0) {
    metaParts.push(`exit ${record.result.exitCode}`);
  }
  const durationMs = record?.result?.durationMs ?? entry.durationMs;
  if (durationMs !== undefined && durationMs > 0) {
    metaParts.push(formatCompactDuration(durationMs));
  }

  let errorPreview: string | undefined;
  if (entry.status === "failed" && record?.result) {
    const rawError =
      record.result.error ??
      record.result.stderr ??
      record.result.output.trim().split("\n")[0] ??
      "";
    const redacted = clampText(
      redactToolText(rawError),
      Math.max(20, maxWidth - 8),
    );
    if (redacted) errorPreview = redacted;
  }

  return {
    icon,
    label: clampText(label, maxWidth),
    status: entry.status,
    ...(metaParts.length > 0 ? { meta: metaParts.join(" · ") } : {}),
    ...(errorPreview ? { errorPreview } : {}),
  };
}

function plural(count: number, singular: string, pluralWord?: string): string {
  return `${count} ${count === 1 ? singular : (pluralWord ?? `${singular}s`)}`;
}

export function summarizeActivityGroup(
  group: ActivityGroup,
  toolRecords: Record<string, ToolRecord>,
): ActivityGroupSummary {
  const readTargets = new Set<string>();
  const editTargets = new Set<string>();
  let readCount = 0;
  let searchCount = 0;
  let editCount = 0;
  let commandCount = 0;
  let testCount = 0;
  let gitCount = 0;
  let webCount = 0;
  let delegateCount = 0;
  let mcpCount = 0;
  let otherCount = 0;
  let thinkingCount = 0;
  let thinkingMs = 0;
  let failedCount = 0;
  let durationMs = 0;
  let runningEntry: ActivityEntry | undefined;
  let testHighlight: { passed: boolean; text: string } | undefined;

  for (const entry of group.entries) {
    if (entry.status === "failed") failedCount += 1;
    if (entry.status === "running") runningEntry = entry;

    const record = entry.toolId ? toolRecords[entry.toolId] : undefined;
    const entryDuration = record?.result?.durationMs ?? entry.durationMs ?? 0;
    durationMs += entryDuration;

    if (entry.kind === "reasoning") {
      thinkingCount += 1;
      thinkingMs += entryDuration;
      continue;
    }

    const name = record?.start.name ?? entry.toolName ?? "tool";
    const target = record ? extractToolTarget(name, record.start.args) : "";

    switch (entry.category) {
      case "read":
        readCount += 1;
        if (target) readTargets.add(target.split(":")[0]);
        break;
      case "search":
        searchCount += 1;
        break;
      case "edit":
        editCount += 1;
        if (target) editTargets.add(target);
        break;
      case "command":
        commandCount += 1;
        break;
      case "test": {
        testCount += 1;
        if (entry.status !== "running") {
          const ts = record?.result?.testsSummary;
          if (ts) {
            testHighlight = record?.result?.success
              ? { passed: true, text: `✓ Tests passed (${ts.passed})` }
              : {
                  passed: false,
                  text: `✗ Tests failed (${ts.failed} failed${ts.passed > 0 ? `, ${ts.passed} passed` : ""})`,
                };
          } else if (record?.result) {
            testHighlight = record.result.success
              ? { passed: true, text: "✓ Tests passed" }
              : { passed: false, text: "✗ Tests failed" };
          }
        }
        break;
      }
      case "git":
        gitCount += 1;
        break;
      case "web":
        webCount += 1;
        break;
      case "delegate":
        delegateCount += 1;
        break;
      case "mcp":
        mcpCount += 1;
        break;
      default:
        otherCount += 1;
        break;
    }
  }

  const parts: string[] = [];
  const exploredFiles = readTargets.size || readCount;
  if (exploredFiles > 0)
    parts.push(`Explored ${plural(exploredFiles, "file")}`);
  if (searchCount > 0) parts.push(`Searched ${plural(searchCount, "time")}`);
  if (commandCount > 0) parts.push(`Ran ${plural(commandCount, "command")}`);
  if (testCount > 0) {
    parts.push(
      testCount === 1 ? "Ran tests" : `Ran ${plural(testCount, "test run")}`,
    );
  }
  const editedFiles = editTargets.size || editCount;
  if (editedFiles > 0) parts.push(`Edited ${plural(editedFiles, "file")}`);
  if (gitCount > 0) parts.push(`${plural(gitCount, "git op")}`);
  if (webCount > 0) parts.push(`Checked ${plural(webCount, "web source")}`);
  if (delegateCount > 0)
    parts.push(`Delegated ${plural(delegateCount, "task")}`);
  if (mcpCount > 0) parts.push(`${plural(mcpCount, "MCP call")}`);
  if (otherCount > 0) parts.push(`${plural(otherCount, "tool call")}`);
  if (parts.length === 0 && thinkingCount > 0) {
    parts.push(
      thinkingMs > 0
        ? `Thought ${formatCompactDuration(thinkingMs)}`
        : "Thought",
    );
  }
  if (failedCount > 0) {
    parts.push(`${failedCount} failed`);
  }

  const runningLabel = runningEntry
    ? formatActivityStep(runningEntry, toolRecords).label
    : undefined;

  return {
    summary: parts.join(" · ") || "Activity",
    ...(runningLabel ? { runningLabel } : {}),
    failedCount,
    totalCount: group.entries.length,
    durationMs,
    ...(testHighlight ? { testHighlight } : {}),
  };
}

export function formatTurnFooter(
  summary: TuiTurnSummary,
  config: TranscriptDisplayConfig,
  status: "running" | "completed" | "failed" | "aborted" = "completed",
): string {
  const parts: string[] = [];

  if (config.verbosity === "high") {
    if (summary.durationMs !== undefined) {
      const dur = formatCompactDuration(summary.durationMs);
      const ttft =
        summary.firstTokenMs !== undefined
          ? ` (TTFT=${Math.round(summary.firstTokenMs)}ms)`
          : "";
      parts.push(`${dur}${ttft}`);
    }
    if (config.showUsage) {
      let tok = `in=${summary.inputTokens} out=${summary.outputTokens}`;
      if (summary.cachedInputTokens)
        tok += ` cached=${summary.cachedInputTokens}`;
      if (summary.reasoningTokens)
        tok += ` reasoning=${summary.reasoningTokens}`;
      parts.push(tok);
    }
    if (summary.tools > 0) {
      const toolTime =
        summary.toolDurationMs !== undefined
          ? ` (${formatCompactDuration(summary.toolDurationMs)})`
          : "";
      parts.push(`tools=${summary.tools}${toolTime}`);
    }
    if (
      config.showContext &&
      summary.contextWindow &&
      summary.contextWindow > 0
    ) {
      parts.push(
        `context=${summary.contextUsed?.toLocaleString() ?? 0}/${summary.contextWindow.toLocaleString()} (${summary.contextPercent ?? 0}%)`,
      );
    }
    if (config.showCost && summary.costUsd !== undefined) {
      if (summary.costKnown && summary.costUsd !== null) {
        parts.push(
          summary.costSource === "local"
            ? "cost=local"
            : `cost=$${summary.costUsd.toFixed(4)}`,
        );
      } else {
        parts.push(`cost=unknown (${summary.pricingVersion ?? "2026-11-01"})`);
      }
    }
    if (config.showModel && summary.model) {
      parts.push(
        summary.provider
          ? `${summary.provider}/${summary.model}`
          : summary.model,
      );
    }
  } else {
    if (summary.durationMs !== undefined) {
      const dur = formatCompactDuration(summary.durationMs);
      const ttft =
        config.verbosity === "medium" && summary.firstTokenMs !== undefined
          ? ` (ttft ${Math.round(summary.firstTokenMs)}ms)`
          : "";
      parts.push(`${dur}${ttft}`);
    }
    if (config.showUsage) {
      const total = summary.inputTokens + summary.outputTokens;
      if (total > 0) {
        const cached =
          config.verbosity === "medium" && summary.cachedInputTokens
            ? ` (${formatCompactTokens(summary.cachedInputTokens)} cached)`
            : "";
        parts.push(`${formatCompactTokens(total)} tokens${cached}`);
      }
    }
    if (summary.tools > 0) {
      parts.push(plural(summary.tools, "tool"));
    }
    if (
      config.showCost &&
      summary.costKnown &&
      summary.costUsd !== null &&
      summary.costUsd !== undefined &&
      summary.costSource !== "local"
    ) {
      parts.push(`$${summary.costUsd.toFixed(4)}`);
    }
    if (
      config.showContext &&
      summary.contextWindow &&
      summary.contextWindow > 0
    ) {
      parts.push(`${summary.contextPercent ?? 0}% context`);
    }
    if (config.showModel && summary.model) {
      parts.push(shortModelName(summary.model));
    }
  }

  if (status === "aborted") parts.push("aborted");
  else if (status === "failed") parts.push("failed");

  return parts.join(" · ");
}
