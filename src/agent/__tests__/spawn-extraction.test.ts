import { describe, it, expect } from "vitest";
import { extractSpawnRequests } from "../team-agent";

describe("extractSpawnRequests", () => {
  it("extracts a valid SPAWN line", () => {
    const raw = `Some output\nSPAWN: {"id":"worker","name":"Worker","role":"Does work","systemPrompt":"You are a worker"}\nMore text`;
    const results = extractSpawnRequests(raw, "orchestrator");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("worker");
    expect(results[0].name).toBe("Worker");
    expect(results[0].role).toBe("Does work");
    expect(results[0].systemPrompt).toBe("You are a worker");
  });

  it("returns empty array when no SPAWN lines", () => {
    const raw = "Just some output\nNo spawning here";
    expect(extractSpawnRequests(raw, "agent")).toHaveLength(0);
  });

  it("extracts multiple SPAWN lines", () => {
    const raw = [
      `SPAWN: {"id":"a1","name":"Alpha","role":"Role A","systemPrompt":"Sys A"}`,
      `SPAWN: {"id":"b2","name":"Beta","role":"Role B","systemPrompt":"Sys B"}`,
    ].join("\n");
    const results = extractSpawnRequests(raw, "parent");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(["a1", "b2"]);
  });

  it("defaults outputKey to id when not provided", () => {
    const raw = `SPAWN: {"id":"myagent","name":"My Agent","role":"Role","systemPrompt":"Prompt"}`;
    const results = extractSpawnRequests(raw, "parent");
    expect(results[0].outputKey).toBe("myagent");
  });

  it("uses explicit outputKey when provided", () => {
    const raw = `SPAWN: {"id":"myagent","name":"My Agent","role":"Role","systemPrompt":"Prompt","outputKey":"custom_key"}`;
    const results = extractSpawnRequests(raw, "parent");
    expect(results[0].outputKey).toBe("custom_key");
  });

  it("defaults dependsOn and tools to empty arrays", () => {
    const raw = `SPAWN: {"id":"x","name":"X","role":"R","systemPrompt":"S"}`;
    const results = extractSpawnRequests(raw, "p");
    expect(results[0].dependsOn).toEqual([]);
    expect(results[0].tools).toEqual([]);
  });

  it("skips SPAWN lines with invalid JSON without throwing", () => {
    const messages: string[] = [];
    const raw = `SPAWN: {bad json here}\nSPAWN: {"id":"ok","name":"OK","role":"R","systemPrompt":"S"}`;
    const results = extractSpawnRequests(raw, "agent", {
      appendLine: (msg) => messages.push(msg),
    });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("ok");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("skips SPAWN with missing required fields", () => {
    // missing systemPrompt
    const raw = `SPAWN: {"id":"x","name":"X","role":"R"}`;
    const results = extractSpawnRequests(raw, "agent");
    expect(results).toHaveLength(0);
  });
});
