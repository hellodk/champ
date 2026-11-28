import { describe, expect, it } from "vitest";
import { buildTranscriptLines, TranscriptLineCache } from "@/tui/transcript";
import type { ChatMessage } from "@/tui/state";

describe("TUI transcript performance and streaming benchmarks", () => {
  it("delivers fast streaming deltas via line caching on a large transcript", () => {
    // Generate 100 realistic messages
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 100; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      messages.push({
        id: `msg-${i}`,
        role,
        text: `Message ${i} with some formatting: **bold**, *italic*, \`code\`, and a list:\n- item 1\n- item 2\n\`\`\`ts\nconst x = ${i};\n\`\`\``,
        timestamp: "2026-01-01T00:00:00.000Z",
      });
    }

    // Add streaming assistant message at the end
    const streamingMsg: ChatMessage = {
      id: "stream-msg",
      role: "assistant",
      text: "Initial text",
      timestamp: "2026-01-01T00:00:00.000Z",
      streaming: true,
    };
    messages.push(streamingMsg);

    const cache = new TranscriptLineCache();
    // Warm up the cache
    buildTranscriptLines(messages, 80, cache);

    // Simulate 50 streaming token chunks arriving
    const startCached = performance.now();
    for (let chunk = 0; chunk < 50; chunk++) {
      streamingMsg.text += ` token_${chunk}`;
      buildTranscriptLines(messages, 80, cache);
    }
    const durationCached = performance.now() - startCached;
    const avgPerDelta = durationCached / 50;

    // Each streaming delta should re-parse only the streaming message,
    // taking well under 5ms per delta on modern hardware.
    expect(avgPerDelta).toBeLessThan(10);
    expect(cache.size).toBe(101);
  });

  it("efficiently handles very large tool outputs without unbounded re-parsing", () => {
    const largeContent = Array.from(
      { length: 1000 },
      (_, i) => `line ${i}: output data with key=value and status=ok`,
    ).join("\n");

    const messages: ChatMessage[] = [
      {
        id: "tool-large",
        role: "tool",
        text: largeContent,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "assistant-stream",
        role: "assistant",
        text: "Thinking...",
        timestamp: "2026-01-01T00:00:00.000Z",
        streaming: true,
      },
    ];

    const cache = new TranscriptLineCache();
    // Warm up
    const initialLines = buildTranscriptLines(messages, 80, cache);
    expect(initialLines.length).toBeGreaterThan(1000);

    // Stream 20 chunks into assistant message
    const start = performance.now();
    for (let c = 0; c < 20; c++) {
      messages[1].text += ` step ${c}`;
      const lines = buildTranscriptLines(messages, 80, cache);
      expect(lines.length).toBeGreaterThan(1000);
    }
    const totalTime = performance.now() - start;
    // 20 deltas should not re-parse the 1000-line tool output each time
    expect(totalTime / 20).toBeLessThan(15);
  });
});
