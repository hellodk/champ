import { describe, expect, it } from "vitest";
import { buildTranscriptLines, wrapTranscriptText } from "@/tui/transcript";
import type { ChatMessage } from "@/tui/state";

function msg(
  id: string,
  text: string,
  role: ChatMessage["role"] = "user",
): ChatMessage {
  return { id, role, text, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("TUI transcript lines (#191)", () => {
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
});
