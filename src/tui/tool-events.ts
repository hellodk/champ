/**
 * Structured tool events retained by the TUI.
 *
 * The transcript shows a short summary, but the full redacted event stays in
 * session state so Ctrl-E can show what was actually read, written or run.
 */
export interface ToolStartEvent {
  id: string;
  name: string;
  args: string;
  startedAt?: string;
}

export interface ToolResultEvent {
  id: string;
  name: string;
  output: string;
  success: boolean;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  approval?: "approved" | "denied" | "auto";
  error?: string;
  fileEditDiff?: { path: string; oldContent: string; newContent: string };
  testsSummary?: { passed: number; failed: number; skipped: number };
}

export interface ToolRecord {
  start: ToolStartEvent;
  result?: ToolResultEvent;
}

export interface ToolDetailLine {
  label: string;
  value: string;
}

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]"],
  [
    /\b(api[_-]?key|token|secret|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
    "$1: [redacted]",
  ],
];

export function redactToolText(text: string): string {
  return REDACTIONS.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    text,
  );
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, width: number): string {
  const flat = flatten(text);
  if (width <= 0) return "";
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

export function toolSummary(record: ToolRecord, width: number): string {
  const prefix = `${record.start.name}${record.result?.output ? " → " : ""}`;
  const firstLine = record.result?.output.trim().split("\n")[0] ?? "";
  const summary = `${prefix}${truncate(firstLine, Math.max(0, width - prefix.length))}`;
  return truncate(summary, width);
}

export function toolDetailLines(record: ToolRecord): ToolDetailLine[] {
  const lines: ToolDetailLine[] = [
    { label: "tool", value: record.start.name },
    { label: "arguments", value: redactToolText(record.start.args) },
    {
      label: "output",
      value: record.result ? redactToolText(record.result.output) : "(pending)",
    },
  ];
  const result = record.result;
  if (!result) return lines;
  if (result.stderr) {
    lines.push({ label: "stderr", value: redactToolText(result.stderr) });
  }
  lines.push({ label: "exit code", value: String(result.exitCode ?? "-") });
  lines.push({
    label: "duration",
    value: result.durationMs === undefined ? "-" : `${result.durationMs}ms`,
  });
  lines.push({ label: "approval", value: result.approval ?? "auto" });
  if (result.error) {
    lines.push({ label: "error", value: redactToolText(result.error) });
  }
  if (result.fileEditDiff) {
    lines.push({
      label: "file",
      value: redactToolText(result.fileEditDiff.path),
    });
  }
  return lines;
}
