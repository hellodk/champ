import { describe, expect, it } from "vitest";
import { RuntimeState } from "@/config/runtime-status";

const target = { endpointId: "ep_a", modelId: "model-a" };

describe("RuntimeState", () => {
  it("classifies failures and does not make one timeout permanently unavailable", () => {
    const state = new RuntimeState({ nowMs: () => 1_000 });
    state.recordFailure(target, "timeout");
    expect(state.get(target)?.lastError).toBe("timeout");
    expect(state.isAvailable(target, 1_000)).toBe(true);

    expect(state.isAvailable(target, 1_000 + 60_000)).toBe(true);
  });

  it("opens the circuit after repeated hard failures and half-opens after cooldown", () => {
    const state = new RuntimeState({
      nowMs: () => 1_000,
      failureThreshold: 2,
      cooldownMs: 5_000,
    });
    state.recordFailure(target, "auth");
    state.recordFailure(target, "auth");
    expect(state.isAvailable(target, 1_000)).toBe(false);
    expect(state.isAvailable(target, 1_000 + 5_001)).toBe(true);

    state.recordSuccess(target, 120);
    expect(state.get(target)?.consecutiveFailures).toBe(0);
    expect(state.isAvailable(target, 1_000 + 5_002)).toBe(true);
  });

  it("tracks in-flight load without going negative under concurrent completion", async () => {
    const state = new RuntimeState();
    const releases = [state.beginRequest(target), state.beginRequest(target)];
    expect(state.get(target)?.inFlight).toBe(2);
    releases[0]();
    releases[0]();
    expect(state.get(target)?.inFlight).toBe(1);
    releases[1]();
    expect(state.get(target)?.inFlight).toBe(0);
  });

  it("captures latency and ttft without inventing missing values", () => {
    const state = new RuntimeState({ nowMs: () => 0 });
    expect(state.get(target)?.latencyMs).toBeUndefined();
    state.recordSuccess(target, 250, 80);
    expect(state.get(target)?.latencyMs).toBe(250);
    expect(state.get(target)?.ttftMs).toBe(80);
  });
});
