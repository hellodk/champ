import { describe, expect, it, beforeEach } from "vitest";
import {
  buildTranscriptLines,
  buildTurnTranscriptLines,
  computeTranscriptViewportLines,
  TurnTranscriptCache,
  wrapTranscriptText,
  TranscriptLineCache,
  clearTranscriptLineCache,
} from "@/tui/transcript";
import type { ChatMessage, TranscriptTurn } from "@/tui/state";
import { DEFAULT_TRANSCRIPT_CONFIG } from "@/tui/activity";
import type { ToolRecord } from "@/tui/tool-events";

function msg(
  id: string,
  text: string,
  role: ChatMessage["role"] = "user",
): ChatMessage {
  return { id, role, text, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("TUI transcript lines (#191)", () => {
  beforeEach(() => {
    clearTranscriptLineCache();
  });

  it("wraps long paragraphs at word boundaries without losing words", () => {
    const lines = wrapTranscriptText("alpha beta gamma delta epsilon", 12);
    expect(lines.join(" ")).toBe("alpha beta gamma delta epsilon");
    expect(lines.every((line) => line.length <= 12)).toBe(true);
  });

  it("keeps explicit newlines and produces one line for an empty message", () => {
    expect(wrapTranscriptText("a\nb", 40)).toEqual(["a", "b"]);
    expect(wrapTranscriptText("", 40)).toEqual([""]);
  });

  it("emits a role line followed by wrapped body lines per message", () => {
    const lines = buildTranscriptLines(
      [msg("m1", "short"), msg("m2", "one two three four", "assistant")],
      9,
    );
    expect(lines[0]).toMatchObject({ messageId: "m1", kind: "role" });
    expect(lines[0].text).toBe("USER");
    expect(lines[1]).toMatchObject({ messageId: "m1", kind: "body" });
    expect(lines.slice(2).map((line) => line.text)).toEqual([
      "ASSISTANT",
      "one two",
      "three",
      "four",
    ]);
  });

  describe("TranscriptLineCache memoization & streaming optimization", () => {
    it("reuses cached lines when message text and width do not change", () => {
      const cache = new TranscriptLineCache();
      const m1 = msg("m1", "hello world", "user");
      const m2 = msg("m2", "streaming response", "assistant");

      const linesFirst = buildTranscriptLines([m1, m2], 80, cache);
      expect(cache.size).toBe(2);

      const m2Updated = { ...m2, text: "streaming response delta" };
      const linesSecond = buildTranscriptLines([m1, m2Updated], 80, cache);

      // m1 lines should be the exact same object references from cache
      const m1FirstLines = linesFirst.filter((l) => l.messageId === "m1");
      const m1SecondLines = linesSecond.filter((l) => l.messageId === "m1");
      expect(m1SecondLines).toEqual(m1FirstLines);
      expect(m1SecondLines[0]).toBe(m1FirstLines[0]);
      expect(m1SecondLines[1]).toBe(m1FirstLines[1]);

      // m2 lines should be updated with new content
      const m2SecondLines = linesSecond.filter((l) => l.messageId === "m2");
      expect(m2SecondLines.map((l) => l.text)).toContain(
        "streaming response delta",
      );
    });

    it("invalidates and recalculates lines when width changes", () => {
      const cache = new TranscriptLineCache();
      const m1 = msg("m1", "one two three four five six", "assistant");

      const narrowLines = buildTranscriptLines([m1], 10, cache);
      expect(narrowLines.length).toBeGreaterThan(3);

      const wideLines = buildTranscriptLines([m1], 80, cache);
      expect(wideLines.length).toBe(2); // Role + 1 body line
    });

    it("prunes evicted message IDs from the cache", () => {
      const cache = new TranscriptLineCache();
      const m1 = msg("m1", "first", "user");
      const m2 = msg("m2", "second", "assistant");
      buildTranscriptLines([m1, m2], 80, cache);
      expect(cache.size).toBe(2);

      // Only m2 remains active (e.g. after retention trimming)
      cache.prune(new Set(["m2"]));
      expect(cache.size).toBe(1);
      expect(cache.get("m1")).toBeUndefined();
      expect(cache.get("m2")).toBeDefined();
    });
  });
});

describe("turn-based transcript line builder (#212)", () => {
  const toolRecords: Record<string, ToolRecord> = {
    t1: {
      start: { id: "t1", name: "read_file", args: '{"path":"src/auth.ts"}' },
      result: {
        id: "t1",
        name: "read_file",
        output: "export const a = 1;",
        success: true,
        durationMs: 12,
      },
    },
    t2: {
      start: { id: "t2", name: "edit_file", args: '{"path":"src/auth.ts"}' },
      result: {
        id: "t2",
        name: "edit_file",
        output: "Edited src/auth.ts",
        success: true,
        durationMs: 8,
      },
    },
  };

  const sampleTurn: TranscriptTurn = {
    id: "turn-1",
    userMessage: "Fix auth",
    startedAt: "2026-11-28T12:00:00.000Z",
    finishedAt: "2026-11-28T12:00:05.000Z",
    status: "completed",
    items: [
      { id: "i1", kind: "assistant_text", text: "Checking now." },
      {
        id: "i2",
        kind: "activity_group",
        group: {
          id: "g1",
          entries: [
            {
              id: "t1",
              kind: "tool",
              category: "read",
              toolId: "t1",
              toolName: "read_file",
              startedAt: "2026-11-28T12:00:01.000Z",
              finishedAt: "2026-11-28T12:00:01.012Z",
              durationMs: 12,
              status: "done",
            },
            {
              id: "t2",
              kind: "tool",
              category: "edit",
              toolId: "t2",
              toolName: "edit_file",
              startedAt: "2026-11-28T12:00:02.000Z",
              finishedAt: "2026-11-28T12:00:02.008Z",
              durationMs: 8,
              status: "done",
            },
          ],
        },
      },
      { id: "i3", kind: "assistant_text", text: "All fixed." },
    ],
    summary: {
      tools: 2,
      inputTokens: 4000,
      outputTokens: 500,
      durationMs: 5000,
      contextUsed: 4500,
      contextWindow: 32768,
      contextPercent: 14,
      costUsd: 0,
      costKnown: true,
      costSource: "local",
      model: "/models/Qwen3-4B.gguf",
    },
  };

  it("renders low verbosity collapsed by default with no uppercase role headings", () => {
    const cache = new TurnTranscriptCache();
    const lines = buildTurnTranscriptLines(
      [sampleTurn],
      {
        width: 80,
        config: DEFAULT_TRANSCRIPT_CONFIG,
        expandedGroups: new Set(),
        toolRecords,
      },
      cache,
    );
    const texts = lines.map((l) => l.text).join("\n");
    expect(texts).not.toContain("USER");
    expect(texts).not.toContain("ASSISTANT");
    expect(texts).not.toContain("SYSTEM");
    expect(texts).not.toContain("[turn]");
    expect(
      lines.some(
        (l) =>
          l.kind === "activity_summary" && l.text.includes("Explored 1 file"),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.kind === "activity_item")).toBe(false);
    expect(
      lines.some(
        (l) => l.kind === "turn_footer" && l.text.includes("Qwen3-4B"),
      ),
    ).toBe(true);
  });

  it("expands activity group items when groupId is in expandedGroups", () => {
    const cache = new TurnTranscriptCache();
    const lines = buildTurnTranscriptLines(
      [sampleTurn],
      {
        width: 80,
        config: DEFAULT_TRANSCRIPT_CONFIG,
        expandedGroups: new Set(["g1"]),
        toolRecords,
      },
      cache,
    );
    expect(
      lines.some(
        (l) =>
          l.kind === "activity_item" && l.text.includes("Read src/auth.ts"),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.kind === "activity_item" && l.text.includes("Edit src/auth.ts"),
      ),
    ).toBe(true);
  });

  it("exposes edits individually in medium verbosity and full details in high verbosity", () => {
    const medium = buildTurnTranscriptLines(
      [sampleTurn],
      {
        width: 80,
        config: { ...DEFAULT_TRANSCRIPT_CONFIG, verbosity: "medium" },
        expandedGroups: new Set(),
        toolRecords,
      },
      new TurnTranscriptCache(),
    );
    expect(
      medium.some(
        (l) =>
          l.kind === "activity_item" && l.text.includes("Edit src/auth.ts"),
      ),
    ).toBe(true);

    const high = buildTurnTranscriptLines(
      [sampleTurn],
      {
        width: 80,
        config: { ...DEFAULT_TRANSCRIPT_CONFIG, verbosity: "high" },
        expandedGroups: new Set(),
        toolRecords,
      },
      new TurnTranscriptCache(),
    );
    expect(
      high.some(
        (l) =>
          l.kind === "activity_detail" &&
          l.text.includes("export const a = 1;"),
      ),
    ).toBe(true);
  });

  it("memoizes unchanged items in TurnTranscriptCache across streaming updates", () => {
    const cache = new TurnTranscriptCache();
    const first = buildTurnTranscriptLines(
      [sampleTurn],
      {
        width: 80,
        config: DEFAULT_TRANSCRIPT_CONFIG,
        expandedGroups: new Set(),
        toolRecords,
      },
      cache,
    );
    const updatedTurn: TranscriptTurn = {
      ...sampleTurn,
      items: [
        sampleTurn.items[0],
        sampleTurn.items[1],
        { id: "i3", kind: "assistant_text", text: "All fixed and verified." },
      ],
    };
    const second = buildTurnTranscriptLines(
      [updatedTurn],
      {
        width: 80,
        config: DEFAULT_TRANSCRIPT_CONFIG,
        expandedGroups: new Set(),
        toolRecords,
      },
      cache,
    );
    // Unchanged item i1 should return exact cached TranscriptLine reference
    const firstI1 = first.find((l) => l.itemId === "i1");
    const secondI1 = second.find((l) => l.itemId === "i1");
    expect(firstI1).toBeDefined();
    expect(secondI1).toBe(firstI1);
  });

  it("adapts viewport height to terminal rows with fallback 16", () => {
    expect(computeTranscriptViewportLines(undefined)).toBe(16);
    expect(computeTranscriptViewportLines(40)).toBeGreaterThan(16);
    expect(computeTranscriptViewportLines(14)).toBeGreaterThanOrEqual(8);
  });
});
