/**
 * AgentRegistry: tracks agents that declare an identity.
 *
 * Agents without an `identity` field are silently ignored — identity is
 * opt-in. This registry is the foundation for future agent-to-agent (A2A)
 * routing where external callers need to discover available agents by ID
 * or capability.
 */
import type { Agent, AgentIdentity } from "./agents/types";

export class AgentRegistry {
  private entries = new Map<string, Agent>();

  /** Register an agent. Agents without `identity.id` are silently ignored. Overwrites if same ID. */
  register(agent: Agent): void {
    if (!agent.identity?.id) return;
    this.entries.set(agent.identity.id, agent);
  }

  /** Unregister by stable ID. No-op if not found. */
  unregister(id: string): void {
    this.entries.delete(id);
  }

  /** Retrieve by stable ID. Returns undefined if not found. */
  get(id: string): Agent | undefined {
    return this.entries.get(id);
  }

  /** List all registered agents. */
  list(): Agent[] {
    return Array.from(this.entries.values());
  }

  /**
   * Find all agents that declare a given capability.
   * Used for routing tasks to agents that can handle them.
   */
  findByCapability(capability: AgentIdentity["capabilities"][number]): Agent[] {
    return this.list().filter((a) =>
      (a.identity?.capabilities ?? []).includes(capability),
    );
  }
}
