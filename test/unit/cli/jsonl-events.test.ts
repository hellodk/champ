import { describe, expect, it } from "vitest";
import {
  JsonlEventSink,
  parseJsonlEvent,
  JSONL_PROTOCOL_VERSION,
} from "@/cli/jsonl-events";

function collect() {
  const lines: string[] = [];
  const sink = new JsonlEventSink((line) => lines.push(line));
  return { sink, lines };
}

describe("JSONL event protocol", () => {
  it("emits versioned, timestamped events and one session.started", () => {
    const { sink, lines } = collect();
    sink.startSession({
      workspace: "/ws",
      sessionId: "sess-1",
      model: "m",
      mode: "agent",
    });
    sink.startSession({ workspace: "/ws", mode: "agent" });
    sink.emit({ type: "message.delta", text: "hello" });
    sink.emit({ type: "agent.status", status: "success" });
    sink.completeSession("success");

    const events = lines.map(parseJsonlEvent);
    expect(events.filter((e) => e.type === "session.started")).toHaveLength(1);
    expect(events[0]).toMatchObject({
      v: JSONL_PROTOCOL_VERSION,
      type: "session.started",
      sessionId: "sess-1",
    });
    expect(events[1]).toMatchObject({ type: "message.delta", text: "hello" });
    expect(events.at(-1)).toMatchObject({
      type: "session.completed",
      status: "success",
    });
    for (const event of events) {
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }
  });

  it("carries failed and cancelled statuses without plain text", () => {
    const { sink, lines } = collect();
    sink.emit({ type: "error", message: "provider failed" });
    sink.emit({
      type: "message.completed",
      text: "",
      status: "failed",
    });
    sink.completeSession("cancelled");

    const events = lines.map((line) => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({ type: "error", message: "provider failed" }),
      expect.objectContaining({ type: "message.completed", status: "failed" }),
      expect.objectContaining({
        type: "session.completed",
        status: "cancelled",
      }),
    ]);
  });

  it("rejects an unknown protocol version", () => {
    expect(() => parseJsonlEvent('{"v":99,"type":"error"}')).toThrow(
      /unsupported JSONL event protocol version/,
    );
  });
});
