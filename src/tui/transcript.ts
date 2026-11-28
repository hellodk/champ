/**
 * Line model for the Ink transcript viewport (#191, #193).
 *
 * The reducer thinks in rendered lines, not messages: a single assistant
 * message can be dozens of terminal lines. Markdown parsing produces the same
 * line unit with extra style information, so scrolling and rendering agree on
 * what a "line" is.
 */
import {
  formatActivityStep,
  formatCompactDuration,
  formatTurnFooter,
  summarizeActivityGroup,
  type ActivityEntry,
  type ActivityGroup,
  type TranscriptDisplayConfig,
} from "./activity";
import {
  latestActivityGroupId,
  type ChatMessage,
  type ChatRole,
  type TranscriptTurn,
  type TurnItem,
} from "./state";
import { markdownToLines, type MarkdownSegment } from "./markdown";
import { toolDetailLines, type ToolRecord } from "./tool-events";

/** Default number of transcript lines painted in the chat viewport. */
export const TRANSCRIPT_VIEWPORT_LINES = 16;

const TERMINAL_CHROME_ROWS = 12;
const MIN_VIEWPORT_LINES = 8;

/**
 * Adapt viewport height to the live terminal row count while falling back to
 * `TRANSCRIPT_VIEWPORT_LINES` in non-TTY / test environments.
 */
export function computeTranscriptViewportLines(terminalRows?: number): number {
  if (
    terminalRows === undefined ||
    !Number.isFinite(terminalRows) ||
    terminalRows <= 0
  ) {
    return TRANSCRIPT_VIEWPORT_LINES;
  }
  return Math.max(
    MIN_VIEWPORT_LINES,
    Math.floor(terminalRows) - TERMINAL_CHROME_ROWS,
  );
}

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

export type TurnTranscriptLineKind =
  | "user_prompt"
  | "user_continuation"
  | "assistant_first"
  | "body"
  | "heading"
  | "list"
  | "code"
  | "quote"
  | "activity_summary"
  | "activity_running"
  | "activity_item"
  | "activity_highlight"
  | "activity_detail"
  | "reasoning"
  | "turn_footer"
  | "error"
  | "notice"
  | "spacer";

export interface TurnTranscriptLine {
  /** Stable identity for React keys. */
  id: string;
  turnId: string;
  itemId?: string;
  groupId?: string;
  toolId?: string;
  kind: TurnTranscriptLineKind;
  text: string;
  segments?: MarkdownSegment[];
  status?: "running" | "done" | "failed";
  meta?: string;
  expanded?: boolean;
}

export interface TurnTranscriptOptions {
  width: number;
  config: TranscriptDisplayConfig;
  expandedGroups: ReadonlySet<string>;
  toolRecords: Record<string, ToolRecord>;
}

interface CachedTurnBlock {
  signature: string;
  lines: TurnTranscriptLine[];
}

/**
 * Per-block memoization cache for the turn-based transcript renderer.
 * Only blocks whose signature changes (e.g. active streaming prose or a newly
 * completed tool) are re-wrapped and re-parsed.
 */
export class TurnTranscriptCache {
  private cache = new Map<string, CachedTurnBlock>();

  get(key: string): CachedTurnBlock | undefined {
    return this.cache.get(key);
  }

  set(key: string, entry: CachedTurnBlock): void {
    this.cache.set(key, entry);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  prune(activeKeys: Set<string>): void {
    for (const key of this.cache.keys()) {
      if (!activeKeys.has(key)) {
        this.cache.delete(key);
      }
    }
  }
}

const defaultTurnCache = new TurnTranscriptCache();

export function getDefaultTurnTranscriptCache(): TurnTranscriptCache {
  return defaultTurnCache;
}

export function clearTurnTranscriptCache(): void {
  defaultTurnCache.clear();
}

const HIGH_DETAIL_MAX_LINES = 6;

function activityGroupSignature(
  group: ActivityGroup,
  options: TurnTranscriptOptions,
  isExpanded: boolean,
  isLatest: boolean,
): string {
  const entrySig = group.entries
    .map((entry) => {
      const record = entry.toolId
        ? options.toolRecords[entry.toolId]
        : undefined;
      return [
        entry.id,
        entry.status,
        entry.durationMs ?? "",
        entry.reasoningText?.length ?? 0,
        record?.start.args.length ?? 0,
        record?.result?.output.length ?? 0,
        record?.result?.exitCode ?? "",
        record?.result?.testsSummary?.passed ?? "",
        record?.result?.testsSummary?.failed ?? "",
      ].join(":");
    })
    .join("|");
  return `${options.width}|${options.config.verbosity}|${isExpanded ? 1 : 0}|${isLatest ? 1 : 0}|${entrySig}`;
}

function renderActivityStepLines(
  turnId: string,
  itemId: string,
  groupId: string,
  entry: ActivityEntry,
  options: TurnTranscriptOptions,
  includeDetails: boolean,
): TurnTranscriptLine[] {
  const lines: TurnTranscriptLine[] = [];
  const stepWidth = Math.max(20, options.width - 6);
  const step = formatActivityStep(entry, options.toolRecords, stepWidth);
  lines.push({
    id: `${itemId}:entry:${entry.id}`,
    turnId,
    itemId,
    groupId,
    toolId: entry.toolId,
    kind: "activity_item",
    text: `${step.icon} ${step.label}`,
    status: step.status,
    meta: step.meta,
  });

  if (entry.kind === "reasoning" && includeDetails && entry.reasoningText) {
    const wrapped = wrapTranscriptText(
      entry.reasoningText.trim(),
      Math.max(16, options.width - 8),
    );
    wrapped.slice(0, HIGH_DETAIL_MAX_LINES).forEach((line, idx) => {
      lines.push({
        id: `${itemId}:reason:${entry.id}:${idx}`,
        turnId,
        itemId,
        groupId,
        kind: "reasoning",
        text: line,
      });
    });
    if (wrapped.length > HIGH_DETAIL_MAX_LINES) {
      lines.push({
        id: `${itemId}:reason:${entry.id}:more`,
        turnId,
        itemId,
        groupId,
        kind: "reasoning",
        text: `… (+${wrapped.length - HIGH_DETAIL_MAX_LINES} more lines)`,
      });
    }
    return lines;
  }

  if (includeDetails && entry.toolId) {
    const record = options.toolRecords[entry.toolId];
    if (record) {
      const detailWidth = Math.max(16, options.width - 8);
      for (const detail of toolDetailLines(record)) {
        if (!detail.value || detail.label === "tool") continue;
        const wrapped = wrapTranscriptText(
          `${detail.label}: ${detail.value}`,
          detailWidth,
        );
        wrapped.slice(0, HIGH_DETAIL_MAX_LINES).forEach((line, idx) => {
          lines.push({
            id: `${itemId}:detail:${entry.id}:${detail.label}:${idx}`,
            turnId,
            itemId,
            groupId,
            toolId: entry.toolId,
            kind: "activity_detail",
            text: line,
          });
        });
        if (wrapped.length > HIGH_DETAIL_MAX_LINES) {
          lines.push({
            id: `${itemId}:detail:${entry.id}:${detail.label}:more`,
            turnId,
            itemId,
            groupId,
            toolId: entry.toolId,
            kind: "activity_detail",
            text: `… (+${wrapped.length - HIGH_DETAIL_MAX_LINES} more lines)`,
          });
        }
      }
      return lines;
    }
  }

  if (step.errorPreview) {
    lines.push({
      id: `${itemId}:err:${entry.id}`,
      turnId,
      itemId,
      groupId,
      toolId: entry.toolId,
      kind: "activity_detail",
      text: `└─ ${step.errorPreview}`,
      status: "failed",
    });
  }

  return lines;
}

function buildActivityGroupLines(
  turnId: string,
  itemId: string,
  group: ActivityGroup,
  options: TurnTranscriptOptions,
  isExpanded: boolean,
  isLatest: boolean,
): TurnTranscriptLine[] {
  const lines: TurnTranscriptLine[] = [];
  const summary = summarizeActivityGroup(group, options.toolRecords);
  const { verbosity } = options.config;

  if (verbosity === "high") {
    const dur =
      summary.durationMs > 0
        ? ` · ${formatCompactDuration(summary.durationMs)}`
        : "";
    lines.push({
      id: `${itemId}:hdr`,
      turnId,
      itemId,
      groupId: group.id,
      kind: "activity_summary",
      text: `Activity (${summary.totalCount} ${summary.totalCount === 1 ? "step" : "steps"}${dur})`,
      status: summary.failedCount > 0 ? "failed" : "done",
      expanded: true,
    });
    for (const entry of group.entries) {
      lines.push(
        ...renderActivityStepLines(
          turnId,
          itemId,
          group.id,
          entry,
          options,
          true,
        ),
      );
    }
    return lines;
  }

  if (isExpanded) {
    const dur =
      summary.durationMs > 0
        ? ` · ${formatCompactDuration(summary.durationMs)}`
        : "";
    lines.push({
      id: `${itemId}:hdr`,
      turnId,
      itemId,
      groupId: group.id,
      kind: "activity_summary",
      text: `Activity (${summary.totalCount} ${summary.totalCount === 1 ? "step" : "steps"}${dur})`,
      status: summary.failedCount > 0 ? "failed" : "done",
      meta: isLatest ? "Ctrl-E to collapse" : undefined,
      expanded: true,
    });
    for (const entry of group.entries) {
      lines.push(
        ...renderActivityStepLines(
          turnId,
          itemId,
          group.id,
          entry,
          options,
          false,
        ),
      );
    }
    return lines;
  }

  if (verbosity === "medium") {
    let foldable: ActivityEntry[] = [];
    let foldIdx = 0;
    const flushFoldable = () => {
      if (foldable.length === 0) return;
      if (foldable.length === 1) {
        lines.push(
          ...renderActivityStepLines(
            turnId,
            itemId,
            group.id,
            foldable[0],
            options,
            false,
          ),
        );
      } else {
        const sub = summarizeActivityGroup(
          { id: `${group.id}:sub:${foldIdx}`, entries: foldable },
          options.toolRecords,
        );
        lines.push({
          id: `${itemId}:fold:${foldIdx}`,
          turnId,
          itemId,
          groupId: group.id,
          kind: "activity_summary",
          text: sub.summary,
          status: sub.failedCount > 0 ? "failed" : "done",
          meta: isLatest && foldIdx === 0 ? "Ctrl-E to expand" : undefined,
          expanded: false,
        });
      }
      foldIdx += 1;
      foldable = [];
    };

    for (const entry of group.entries) {
      const canFold =
        entry.status === "done" &&
        (entry.category === "read" ||
          entry.category === "search" ||
          entry.category === "thinking");
      if (canFold) {
        foldable.push(entry);
      } else {
        flushFoldable();
        lines.push(
          ...renderActivityStepLines(
            turnId,
            itemId,
            group.id,
            entry,
            options,
            false,
          ),
        );
      }
    }
    flushFoldable();
    return lines;
  }

  // Low verbosity (default): one compact collapsible row per activity run.
  if (summary.runningLabel) {
    const doneEntries = group.entries.filter((e) => e.status !== "running");
    const prefix =
      doneEntries.length > 0
        ? `${summarizeActivityGroup({ id: group.id, entries: doneEntries }, options.toolRecords).summary} · `
        : "";
    lines.push({
      id: `${itemId}:live`,
      turnId,
      itemId,
      groupId: group.id,
      kind: "activity_running",
      text: `${prefix}${summary.runningLabel}`,
      status: "running",
      meta: isLatest ? "Ctrl-E to expand" : undefined,
      expanded: false,
    });
    return lines;
  }

  lines.push({
    id: `${itemId}:sum`,
    turnId,
    itemId,
    groupId: group.id,
    kind: "activity_summary",
    text: summary.summary,
    status: summary.failedCount > 0 ? "failed" : "done",
    meta: isLatest ? "Ctrl-E to expand" : undefined,
    expanded: false,
  });
  if (summary.testHighlight) {
    lines.push({
      id: `${itemId}:test`,
      turnId,
      itemId,
      groupId: group.id,
      kind: "activity_highlight",
      text: summary.testHighlight.text,
      status: summary.testHighlight.passed ? "done" : "failed",
    });
  }
  return lines;
}

function buildTurnItemLines(
  turn: TranscriptTurn,
  item: TurnItem,
  options: TurnTranscriptOptions,
  latestGroupId: string | undefined,
  cache: TurnTranscriptCache,
  activeKeys: Set<string>,
): TurnTranscriptLine[] {
  const key = `item:${item.id}`;
  activeKeys.add(key);

  if (item.kind === "assistant_text") {
    const signature = `a|${options.width}|${item.text}`;
    const cached = cache.get(key);
    if (cached && cached.signature === signature) return cached.lines;

    const mdLines = markdownToLines(item.text, Math.max(10, options.width - 2));
    const built: TurnTranscriptLine[] = mdLines.map((line, idx) => ({
      id: `${item.id}:${idx}`,
      turnId: turn.id,
      itemId: item.id,
      kind: idx === 0 ? "assistant_first" : line.kind,
      text: line.text,
      segments: line.segments,
    }));
    cache.set(key, { signature, lines: built });
    return built;
  }

  if (item.kind === "activity_group") {
    const isExpanded = options.expandedGroups.has(item.group.id);
    const isLatest = item.group.id === latestGroupId;
    const signature = activityGroupSignature(
      item.group,
      options,
      isExpanded,
      isLatest,
    );
    const cached = cache.get(key);
    if (cached && cached.signature === signature) return cached.lines;

    const built = buildActivityGroupLines(
      turn.id,
      item.id,
      item.group,
      options,
      isExpanded,
      isLatest,
    );
    cache.set(key, { signature, lines: built });
    return built;
  }

  const signature = `${item.kind}|${options.width}|${item.text}`;
  const cached = cache.get(key);
  if (cached && cached.signature === signature) return cached.lines;

  const built: TurnTranscriptLine[] = wrapTranscriptText(
    item.text,
    Math.max(10, options.width - 2),
  ).map((line, idx) => ({
    id: `${item.id}:${idx}`,
    turnId: turn.id,
    itemId: item.id,
    kind: item.kind === "error" ? "error" : "notice",
    text: line,
  }));
  cache.set(key, { signature, lines: built });
  return built;
}

/**
 * Render ordered `TranscriptTurn[]` into flat terminal lines with per-block
 * memoization so streaming deltas only re-layout the active block.
 */
export function buildTurnTranscriptLines(
  turns: readonly TranscriptTurn[],
  options: TurnTranscriptOptions,
  cache: TurnTranscriptCache = defaultTurnCache,
): TurnTranscriptLine[] {
  const lines: TurnTranscriptLine[] = [];
  const activeKeys = new Set<string>();
  const latestGroupId = latestActivityGroupId(turns);
  const contentWidth = Math.max(10, options.width - 2);

  turns.forEach((turn, turnIndex) => {
    if (turnIndex > 0) {
      lines.push({
        id: `${turn.id}:spacer`,
        turnId: turn.id,
        kind: "spacer",
        text: "",
      });
    }

    if (turn.userMessage !== null && turn.userMessage.length > 0) {
      const userKey = `user:${turn.id}`;
      activeKeys.add(userKey);
      const userSig = `${contentWidth}|${turn.userMessage}`;
      const cachedUser = cache.get(userKey);
      let userLines: TurnTranscriptLine[];
      if (cachedUser && cachedUser.signature === userSig) {
        userLines = cachedUser.lines;
      } else {
        userLines = wrapTranscriptText(turn.userMessage, contentWidth).map(
          (text, idx) => ({
            id: `${turn.id}:user:${idx}`,
            turnId: turn.id,
            kind: idx === 0 ? "user_prompt" : "user_continuation",
            text,
          }),
        );
        cache.set(userKey, { signature: userSig, lines: userLines });
      }
      for (const line of userLines) lines.push(line);
    }

    for (const item of turn.items) {
      const itemLines = buildTurnItemLines(
        turn,
        item,
        options,
        latestGroupId,
        cache,
        activeKeys,
      );
      for (const line of itemLines) lines.push(line);
    }

    if (turn.summary) {
      const footerKey = `footer:${turn.id}`;
      activeKeys.add(footerKey);
      const footerText = formatTurnFooter(
        turn.summary,
        options.config,
        turn.status,
      );
      if (footerText) {
        const footerSig = `${options.width}|${footerText}`;
        const cachedFooter = cache.get(footerKey);
        let footerLines: TurnTranscriptLine[];
        if (cachedFooter && cachedFooter.signature === footerSig) {
          footerLines = cachedFooter.lines;
        } else {
          footerLines = wrapTranscriptText(footerText, contentWidth).map(
            (text, idx) => ({
              id: `${turn.id}:footer:${idx}`,
              turnId: turn.id,
              kind: "turn_footer",
              text,
            }),
          );
          cache.set(footerKey, { signature: footerSig, lines: footerLines });
        }
        for (const line of footerLines) lines.push(line);
      }
    }
  });

  if (cache.size > activeKeys.size + 100) {
    cache.prune(activeKeys);
  }

  return lines;
}
