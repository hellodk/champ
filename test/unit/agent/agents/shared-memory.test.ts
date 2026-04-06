/**
 * TDD: Tests for SharedMemory.
 * Inter-agent state sharing and message passing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SharedMemory } from "@/agent/shared-memory";

describe("SharedMemory", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory();
  });

  it("should store and retrieve task state", () => {
    memory.set("plan", { steps: [1, 2, 3] });
    expect(memory.get("plan")).toEqual({ steps: [1, 2, 3] });
  });

  it("should return undefined for missing keys", () => {
    expect(memory.get("nonexistent")).toBeUndefined();
  });

  it("should store agent outputs", () => {
    memory.setOutput("planner", { success: true, output: "plan created" });
    const output = memory.getOutput("planner");
    expect(output).toBeDefined();
    expect(output!.output).toBe("plan created");
  });

  it("should support message passing between agents", () => {
    memory.sendMessage("planner", "code", {
      type: "plan",
      steps: ["edit main.ts"],
    });
    memory.sendMessage("planner", "code", {
      type: "context",
      files: ["main.ts"],
    });

    const messages = memory.getMessages("code");
    expect(messages).toHaveLength(2);
    expect(messages[0].from).toBe("planner");
    expect(messages[0].content.type).toBe("plan");
  });

  it("should return empty array for agent with no messages", () => {
    expect(memory.getMessages("nobody")).toHaveLength(0);
  });

  it("should clear all state on reset", () => {
    memory.set("key", "value");
    memory.setOutput("agent", { success: true, output: "done" });
    memory.sendMessage("a", "b", { data: 1 });

    memory.reset();

    expect(memory.get("key")).toBeUndefined();
    expect(memory.getOutput("agent")).toBeUndefined();
    expect(memory.getMessages("b")).toHaveLength(0);
  });

  it("should check if a key exists", () => {
    memory.set("exists", true);
    expect(memory.has("exists")).toBe(true);
    expect(memory.has("missing")).toBe(false);
  });

  it("should list all stored keys", () => {
    memory.set("a", 1);
    memory.set("b", 2);
    expect(memory.keys()).toEqual(expect.arrayContaining(["a", "b"]));
  });
});
