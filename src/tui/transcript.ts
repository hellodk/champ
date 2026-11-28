/**
 * Line model for the Ink transcript viewport (#191, #193).
 *
 * The reducer thinks in rendered lines, not messages: a single assistant
 * message can be dozens of terminal lines. Markdown parsing produces the same
 * line unit with extra style information, so scrolling and rendering agree on
 * what a "line" is.
 */
import type { ChatMessage, ChatRole } from "./state";
import { markdownToLines, type MarkdownSegment } from "./markdown";

/** Default number of transcript lines painted in the chat viewport. */
export const TRANSCRIPT_VIEWPORT_LINES = 16;

export type TranscriptLineKind =
  | "role"
  | "body"
  | "heading"
  | "list"
  | "code"
  | "quote";

export interface TranscriptLine {
  /** Stable identity for React keys. */
  id: string;
  messageId: string;
  kind: TranscriptLineKind;
  role: ChatRole;
  text: string;
  segments?: MarkdownSegment[];
}

export interface CachedMessageLines {
  text: string;
  width: number;
  lines: TranscriptLine[];
}

/**
 * High-performance memoization cache for transcript lines.
 * Avoids re-parsing unchanged markdown and re-wrapping lines on streaming deltas.
 */
export class TranscriptLineCache {
  private cache = new Map<string, CachedMessageLines>();

  get(messageId: string): CachedMessageLines | undefined {
    return this.cache.get(messageId);
  }

  set(messageId: string, entry: CachedMessageLines): void {
    this.cache.set(messageId, entry);
  }

  delete(messageId: string): boolean {
    return this.cache.delete(messageId);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Prune entries for messages that have been removed or trimmed by retention caps.
   */
  prune(activeMessageIds: Set<string>): void {
    for (const id of this.cache.keys()) {
      if (!activeMessageIds.has(id)) {
        this.cache.delete(id);
      }
    }
  }
}

/** Default singleton cache instance used across TUI rendering turns. */
const defaultLineCache = new TranscriptLineCache();

export function getDefaultTranscriptLineCache(): TranscriptLineCache {
  return defaultLineCache;
}

export function clearTranscriptLineCache(): void {
  defaultLineCache.clear();
}

/** Word-wrap one paragraph, preserving explicit newlines and long words. */
export function wrapTranscriptText(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const output: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= limit) {
      output.push(paragraph);
      continue;
    }
    let rest = paragraph;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(" ", limit);
      if (cut <= 0) cut = limit;
      output.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    output.push(rest);
  }
  return output;
}

/**
 * Expand messages into the lines the terminal actually paints.
 * Uses message-level line caching so only messages receiving new content are re-rendered.
 */
export function buildTranscriptLines(
  messages: ChatMessage[],
  width: number,
  cache: TranscriptLineCache = defaultLineCache,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];

  for (const message of messages) {
    const cached = cache.get(message.id);
    if (cached && cached.text === message.text && cached.width === width) {
      for (const line of cached.lines) {
        lines.push(line);
      }
      continue;
    }

    const msgLines: TranscriptLine[] = [
      {
        id: `${message.id}:role`,
        messageId: message.id,
        kind: "role",
        role: message.role,
        text: message.role.toUpperCase(),
      },
    ];

    markdownToLines(message.text, width).forEach((line, index) => {
      msgLines.push({
        id: `${message.id}:${index}`,
        messageId: message.id,
        kind: line.kind,
        role: message.role,
        text: line.text,
        segments: line.segments,
      });
    });

    cache.set(message.id, {
      text: message.text,
      width,
      lines: msgLines,
    });

    for (const line of msgLines) {
      lines.push(line);
    }
  }

  // Periodic pruning if the cache has accumulated orphaned messages after retention trimming
  if (cache.size > messages.length + 100) {
    const activeIds = new Set(messages.map((m) => m.id));
    cache.prune(activeIds);
  }

  return lines;
}
