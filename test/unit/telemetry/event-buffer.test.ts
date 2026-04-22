import { describe, it, expect } from "vitest";
import { EventBuffer } from "../../../src/telemetry/event-buffer";

describe("EventBuffer", () => {
  it("stores and drains events in FIFO order", () => {
    const buf = new EventBuffer<string>(10, 1024 * 1024);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    expect(buf.size()).toBe(3);
    const drained = buf.drain();
    expect(drained).toEqual(["a", "b", "c"]);
    expect(buf.size()).toBe(0);
  });

  it("drops oldest events when maxEvents exceeded", () => {
    const buf = new EventBuffer<number>(3, 1024 * 1024);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // should evict 1
    expect(buf.size()).toBe(3);
    expect(buf.drain()).toEqual([2, 3, 4]);
  });

  it("drops oldest events when maxBytes exceeded", () => {
    // Each event ~10 bytes when serialized as JSON number string
    const buf = new EventBuffer<string>(1000, 30);
    buf.push("aaaaaaaaaa"); // ~12 bytes: "aaaaaaaaaa"
    buf.push("bbbbbbbbbb"); // ~12 bytes
    buf.push("cccccccccc"); // ~12 bytes — total exceeds 30
    // should have dropped oldest until under 30 bytes
    expect(buf.size()).toBeLessThan(3);
    const events = buf.drain();
    expect(events[events.length - 1]).toBe("cccccccccc");
  });

  it("drain resets byteSize to 0", () => {
    const buf = new EventBuffer<string>(10, 1024);
    buf.push("hello");
    expect(buf.byteSize()).toBeGreaterThan(0);
    buf.drain();
    expect(buf.byteSize()).toBe(0);
    expect(buf.size()).toBe(0);
  });

  it("byteSize tracks serialized byte count", () => {
    const buf = new EventBuffer<object>(10, 1024 * 1024);
    const event = { key: "value" };
    buf.push(event);
    const expected = Buffer.byteLength(JSON.stringify(event), "utf8");
    expect(buf.byteSize()).toBe(expected);
  });
});
