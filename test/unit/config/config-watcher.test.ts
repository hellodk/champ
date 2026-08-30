import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigWatcher } from "@/config/config-watcher";

interface FakeClock {
  now: number;
  intervals: Array<() => void>;
  timeouts: Map<number, () => void>;
  nextId: number;
  step(ms: number): void;
  setInterval(cb: () => void): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval>): void;
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

function makeClock(): FakeClock {
  const clock: FakeClock = {
    now: 0,
    intervals: [],
    timeouts: new Map(),
    nextId: 1,
    step(ms) {
      clock.now += ms;
      // run due timeouts that have elapsed (simple: fire all in order)
      for (const [, cb] of [...clock.timeouts]) cb();
      clock.timeouts.clear();
    },
    setInterval(cb) {
      clock.intervals.push(cb);
      return clock.nextId++;
    },
    clearInterval(id) {
      // not needed for correctness of these tests
    },
    setTimeout(cb) {
      const id = clock.nextId++;
      clock.timeouts.set(id, cb);
      return id;
    },
    clearTimeout(id) {
      clock.timeouts.delete(id);
    },
  };
  return clock;
}

function build(
  onChange: () => void,
  opts: { mtimeMs?: () => number; pollIntervalMs?: number } = {},
) {
  const clock = makeClock();
  let curMtime = opts.mtimeMs ? opts.mtimeMs() : 1000;
  const setMtime = (ms: number) => (curMtime = ms);
  const w = new ConfigWatcher({
    path: "/home/user/.champ/config.yaml",
    onChange,
    debounceMs: 300,
    pollIntervalMs: opts.pollIntervalMs ?? 1000,
    now: () => clock.now,
    setIntervalFn: clock.setInterval,
    clearIntervalFn: clock.clearInterval,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    stat: async () => (curMtime === -1 ? null : { mtimeMs: curMtime }),
  });
  return { w, clock, setMtime };
}

describe("ConfigWatcher (#129 out-of-workspace config reload)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires a baseline without onChange on first poll", async () => {
    const onChange = vi.fn();
    const { w, clock } = build(onChange);
    w.start();
    clock.intervals[0](); // first poll -> baseline only
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    w.dispose();
  });

  it("calls onChange (debounced) exactly once when mtime changes", async () => {
    const onChange = vi.fn();
    const { w, clock, setMtime } = build(onChange);
    w.start();
    clock.intervals[0](); // baseline
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();

    setMtime(2000);
    clock.intervals[0](); // poll sees new mtime -> schedule debounce
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled(); // debounce not elapsed yet
    clock.step(400); // debounce elapses
    expect(onChange).toHaveBeenCalledTimes(1);
    w.dispose();
  });

  it("collapses rapid mtime changes into a single reload", async () => {
    const onChange = vi.fn();
    const { w, clock, setMtime } = build(onChange);
    w.start();
    clock.intervals[0](); // baseline
    await Promise.resolve();

    // several changes arrive inside the debounce window
    setMtime(3000);
    clock.intervals[0]();
    await Promise.resolve();
    setMtime(4000);
    clock.intervals[0]();
    await Promise.resolve();
    clock.step(400);
    expect(onChange).toHaveBeenCalledTimes(1);
    w.dispose();
  });

  it("does not reload again when mtime is unchanged on subsequent polls", async () => {
    const onChange = vi.fn();
    const { w, clock, setMtime } = build(onChange);
    w.start();
    clock.intervals[0](); // baseline
    setMtime(2000);
    clock.intervals[0](); // change detected
    await Promise.resolve();
    clock.step(400);
    expect(onChange).toHaveBeenCalledTimes(1);

    clock.intervals[0](); // unchanged
    await Promise.resolve();
    clock.step(400);
    expect(onChange).toHaveBeenCalledTimes(1); // still one
    w.dispose();
  });

  it("treats a deleted file as a signal (missing -> reload once)", async () => {
    const onChange = vi.fn();
    const { w, clock, setMtime } = build(onChange);
    w.start();
    clock.intervals[0](); // baseline
    await Promise.resolve();

    setMtime(-1); // file deleted
    clock.intervals[0]();
    await Promise.resolve();
    clock.step(400);
    expect(onChange).toHaveBeenCalledTimes(1);
    w.dispose();
  });
});
