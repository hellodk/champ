import { describe, expect, it, beforeEach } from "vitest";
import {
  buildTranscriptLines,
  wrapTranscriptText,
  TranscriptLineCache,
  clearTranscriptLineCache,
} from "@/tui/transcript";
import type { ChatMessage } from "@/tui/state";

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
