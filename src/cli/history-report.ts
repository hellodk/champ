/** Pure paging/formatting helpers for REPL `/history` and `/sessions`. */
export interface HistoryMessage {
  role: string;
  content: unknown;
}

export interface HistoryLine {
  number: number;
  role: string;
  text: string;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join(" ");
  }
  return "";
}

/** Flatten user/assistant turns into numbered, single-line entries. */
export function toHistoryLines(
  messages: readonly HistoryMessage[],
): HistoryLine[] {
  return messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message, index) => ({
      number: index + 1,
      role: message.role,
      text: messageText(message.content)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160),
    }));
}

export interface PageOptions {
  query?: string;
  page?: number;
  pageSize?: number;
}

/** Format one page of history lines, newest order preserved. */
export function formatHistoryPage(
  lines: readonly HistoryLine[],
  options: PageOptions = {},
): string {
  const query = (options.query ?? "").trim().toLowerCase();
  const matches = query
    ? lines.filter((line) =>
        `${line.role} ${line.text}`.toLowerCase().includes(query),
      )
    : lines;
  const pageSize = Math.max(1, options.pageSize ?? 10);
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const page = Math.min(Math.max(1, options.page ?? 1), pageCount);
  const start = (page - 1) * pageSize;
  const body = matches
    .slice(start, start + pageSize)
    .map(
      (line) =>
        `  ${String(line.number).padStart(4)} ${line.role.padEnd(9)} ${line.text}`,
    )
    .join("\n");
  return (
    `[champ] history (${matches.length} match${matches.length === 1 ? "" : "es"}) — page ${page}/${pageCount}\n` +
    (body ? `${body}\n` : "  (no messages)\n")
  );
}

/** Format one page of a generic session list. */
export function formatSessionPage<T>(
  items: readonly T[],
  options: PageOptions = {},
): {
  text: string;
  visible: T[];
} {
  const pageSize = Math.max(1, options.pageSize ?? 10);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(1, options.page ?? 1), pageCount);
  const start = (page - 1) * pageSize;
  const visible = items.slice(start, start + pageSize);
  return {
    visible,
    text: `[champ] sessions (${items.length}) — page ${page}/${pageCount}\n`,
  };
}
