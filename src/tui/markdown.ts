/**
 * Markdown to Ink-ready lines for the TUI transcript (issue #193).
 *
 * `marked` does the parsing; this module only flattens the token stream into
 * lines with styled segments so the terminal renderer never has to interpret
 * HTML. Fenced code is highlighted with the existing highlight.js dependency.
 */
import { marked, type Token, type Tokens } from "marked";
import hljs from "highlight.js";

export type MarkdownLineKind = "body" | "heading" | "list" | "code" | "quote";

export interface MarkdownSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
  highlight?: string;
}

export interface MarkdownLine {
  kind: MarkdownLineKind;
  text: string;
  segments: MarkdownSegment[];
}

interface Range {
  start: number;
  end: number;
}

function inlineSegments(
  tokens: Token[] | undefined,
  fallback: string,
): MarkdownSegment[] {
  if (!tokens || tokens.length === 0) return [{ text: fallback }];
  const segments: MarkdownSegment[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "escape":
        segments.push({ text: token.text });
        break;
      case "strong": {
        const strong = token as Tokens.Strong;
        for (const segment of inlineSegments(strong.tokens, strong.text)) {
          segments.push({ ...segment, bold: true });
        }
        break;
      }
      case "em": {
        const em = token as Tokens.Em;
        for (const segment of inlineSegments(em.tokens, em.text)) {
          segments.push({ ...segment, italic: true });
        }
        break;
      }
      case "codespan":
        segments.push({ text: (token as Tokens.Codespan).text, code: true });
        break;
      case "link": {
        const link = token as Tokens.Link;
        for (const segment of inlineSegments(link.tokens, link.text)) {
          segments.push({ ...segment, link: true });
        }
        break;
      }
      case "br":
        segments.push({ text: " " });
        break;
      default:
        if ("text" in token && typeof token.text === "string") {
          segments.push({ text: token.text });
        }
    }
  }
  return segments;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

/** Convert highlight.js HTML spans into plain segments with class names. */
function highlightedSegments(code: string, lang?: string): MarkdownSegment[] {
  let html: string;
  try {
    html =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(code).value;
  } catch {
    return [{ text: code }];
  }
  const segments: MarkdownSegment[] = [];
  const pattern = /<span class="hljs-([\w-]+)">([\s\S]*?)<\/span>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (match[1]) {
      segments.push({
        text: decodeEntities(match[2]),
        highlight: match[1],
      });
    } else if (match[3]) {
      segments.push({ text: decodeEntities(match[3]) });
    }
  }
  return segments.length > 0 ? segments : [{ text: code }];
}

/** Split highlight segments on newlines while preserving class names. */
function codeLines(code: string, lang?: string): MarkdownLine[] {
  const segments = highlightedSegments(code, lang);
  const rows: MarkdownSegment[][] = [[]];
  for (const segment of segments) {
    const parts = segment.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) rows.push([]);
      if (part.length > 0)
        rows[rows.length - 1].push({ ...segment, text: part });
    });
  }
  return rows.map((row) => ({
    kind: "code",
    text: row.map((segment) => segment.text).join(""),
    segments: row,
  }));
}

function wrapRanges(text: string, limit: number): Range[] {
  const ranges: Range[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start) end = space;
    }
    ranges.push({ start, end });
    start = end;
    while (start < text.length && text[start] === " ") start += 1;
  }
  return ranges;
}

function sliceSegments(
  segments: MarkdownSegment[],
  start: number,
  end: number,
): MarkdownSegment[] {
  const result: MarkdownSegment[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const segmentStart = cursor;
    const segmentEnd = cursor + segment.text.length;
    cursor = segmentEnd;
    if (segmentEnd <= start || segmentStart >= end) continue;
    const from = Math.max(0, start - segmentStart);
    const to = Math.min(segment.text.length, end - segmentStart);
    if (to > from)
      result.push({ ...segment, text: segment.text.slice(from, to) });
  }
  return result;
}

function splitOnNewlines(segments: MarkdownSegment[]): MarkdownSegment[][] {
  const paragraphs: MarkdownSegment[][] = [[]];
  for (const segment of segments) {
    const parts = segment.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) paragraphs.push([]);
      if (part.length > 0) {
        paragraphs[paragraphs.length - 1].push({ ...segment, text: part });
      }
    });
  }
  return paragraphs;
}

function pushWrapped(
  lines: MarkdownLine[],
  kind: MarkdownLineKind,
  segments: MarkdownSegment[],
  limit: number,
): void {
  for (const paragraph of splitOnNewlines(segments)) {
    const text = paragraph.map((segment) => segment.text).join("");
    if (text.length <= limit) {
      lines.push({ kind, text, segments: paragraph });
      continue;
    }
    for (const range of wrapRanges(text, limit)) {
      lines.push({
        kind,
        text: text.slice(range.start, range.end),
        segments: sliceSegments(paragraph, range.start, range.end),
      });
    }
  }
}

function listSegments(item: Tokens.ListItem): MarkdownSegment[] {
  const first = item.tokens[0] as Tokens.Text | undefined;
  if (first && first.type === "text" && first.tokens) {
    return inlineSegments(first.tokens, first.text);
  }
  return inlineSegments(item.tokens, item.text);
}

/** Parse markdown into terminal lines with inline style information. */
export function markdownToLines(text: string, width: number): MarkdownLine[] {
  const limit = Math.max(1, Math.floor(width));
  const lines: MarkdownLine[] = [];
  const tokens = marked.lexer(text);
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        pushWrapped(
          lines,
          "heading",
          inlineSegments(heading.tokens, heading.text),
          limit,
        );
        break;
      }
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        pushWrapped(
          lines,
          "body",
          inlineSegments(paragraph.tokens, paragraph.text),
          limit,
        );
        break;
      }
      case "text": {
        const plain = token as Tokens.Text;
        pushWrapped(
          lines,
          "body",
          inlineSegments(plain.tokens, plain.text),
          limit,
        );
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        let index = list.start === "" ? 1 : Number(list.start) || 1;
        for (const item of list.items) {
          const prefix = list.ordered ? `${index}. ` : "• ";
          pushWrapped(
            lines,
            "list",
            [{ text: prefix }, ...listSegments(item)],
            limit,
          );
          index += 1;
        }
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        lines.push(...codeLines(code.text, code.lang));
        break;
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        const inner = inlineSegments(quote.tokens, quote.text);
        pushWrapped(lines, "quote", [{ text: "│ " }, ...inner], limit);
        break;
      }
      case "space":
        break;
      default:
        pushWrapped(lines, "body", [{ text: token.raw }], limit);
    }
  }
  return lines;
}
