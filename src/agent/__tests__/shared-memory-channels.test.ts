import { describe, it, expect } from "vitest";
import { SharedMemory } from "../shared-memory";

describe("SharedMemory — channel pub/sub", () => {
  it("publish stores data and hasChannel returns true", () => {
    const mem = new SharedMemory();
    mem.publish("results", { score: 42 });
    expect(mem.hasChannel("results")).toBe(true);
  });

  it("hasChannel returns false for unpublished channel", () => {
    const mem = new SharedMemory();
    expect(mem.hasChannel("missing")).toBe(false);
  });

  it("subscribe resolves immediately when channel already published", async () => {
    const mem = new SharedMemory();
    mem.publish("data", "hello");
    const result = await mem.subscribe("data", 1000);
    expect(result).toBe("hello");
  });

  it("subscribe returns null when channel never published within timeout", async () => {
    const mem = new SharedMemory();
    const result = await mem.subscribe("ghost", 100);
    expect(result).toBeNull();
  });

  it("subscribe resolves when publish happens during wait", async () => {
    const mem = new SharedMemory();
    // Publish after a small delay
    setTimeout(() => mem.publish("late", { value: 99 }), 80);
    const result = await mem.subscribe("late", 1000);
    expect(result).toEqual({ value: 99 });
  });

  it("publish overwrites previous value on same channel", () => {
    const mem = new SharedMemory();
    mem.publish("ch", "first");
    mem.publish("ch", "second");
    expect(mem.hasChannel("ch")).toBe(true);
    // subscribe immediately since it's already published
    return mem.subscribe("ch", 100).then((v) => expect(v).toBe("second"));
  });

  it("channel keys do not appear in regular get/has", () => {
    const mem = new SharedMemory();
    mem.publish("x", 1);
    // get/has use plain key, not __channel: prefixed key
    expect(mem.has("x")).toBe(false);
    expect(mem.get("x")).toBeUndefined();
  });

  it("reset clears channels", () => {
    const mem = new SharedMemory();
    mem.publish("ch", "data");
    mem.reset();
    expect(mem.hasChannel("ch")).toBe(false);
  });
});
