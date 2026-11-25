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

/** Expand messages into the lines the terminal actually paints. */
export function buildTranscriptLines(
  messages: ChatMessage[],
  width: number,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  messages.forEach((message) => {
    lines.push({
      id: `${message.id}:role`,
      messageId: message.id,
      kind: "role",
      role: message.role,
      text: message.role.toUpperCase(),
    });
    markdownToLines(message.text, width).forEach((line, index) => {
      lines.push({
        id: `${message.id}:${index}`,
        messageId: message.id,
        kind: line.kind,
        role: message.role,
        text: line.text,
        segments: line.segments,
      });
    });
  });
  return lines;
}
