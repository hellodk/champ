import { describe, it, expect, beforeEach } from "vitest";
import { AgentRegistry } from "@/agent/agent-registry";
import type { Agent } from "@/agent/agents/types";

function makeAgent(name: string, id: string, caps: string[] = []): Agent {
  return {
    name,
    role: `${name} role`,
    identity: {
      id,
      version: "1.0.0",
      capabilities: caps as Agent["identity"]["capabilities"],
    },
    execute: async () => ({ success: true, output: "done" }),
  };
}

describe("AgentRegistry", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it("registers an agent and retrieves it by ID", () => {
    const agent = makeAgent("planner", "built-in:planner");
    registry.register(agent);
    expect(registry.get("built-in:planner")).toBe(agent);
  });

  it("lists all registered agents", () => {
    registry.register(makeAgent("a", "id-a"));
    registry.register(makeAgent("b", "id-b"));
    expect(registry.list()).toHaveLength(2);
  });

  it("unregisters an agent by ID", () => {
    registry.register(makeAgent("a", "id-a"));
    registry.unregister("id-a");
    expect(registry.get("id-a")).toBeUndefined();
  });

  it("silently ignores agents without identity", () => {
    const noIdentity: Agent = {
      name: "bare",
      role: "bare",
      execute: async () => ({ success: true, output: "" }),
    };
    registry.register(noIdentity);
    expect(registry.list()).toHaveLength(0);
  });

  it("finds agents by capability", () => {
    registry.register(makeAgent("coder", "id-coder", ["write", "llm"]));
    registry.register(makeAgent("searcher", "id-searcher", ["search", "read"]));
    const writers = registry.findByCapability("write");
    expect(writers).toHaveLength(1);
    expect(writers[0].name).toBe("coder");
  });
});
