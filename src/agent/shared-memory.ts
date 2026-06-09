/**
 * InMemorySharedMemory: default SharedMemory implementation.
 *
 * Backed by plain Maps — no persistence. Lives for the duration of a
 * single workflow; the orchestrator resets it between workflows.
 */
import type {
  SharedMemory as ISharedMemory,
  AgentOutput,
  AgentMessage,
} from "./agents/types";

/**
 * Known keys and their value types for typed memory access.
 * Add entries here when introducing new well-known memory keys.
 * Dynamic keys (e.g. `${agentId}_token_usage`) remain untyped.
 */
export interface MemorySchema {
  __workspaceRoot: string;
  __userRequest: string;
  __globalContext?: string;
}

export class SharedMemory implements ISharedMemory {
  private state = new Map<string, unknown>();
  private outputs = new Map<string, AgentOutput>();
  private mailboxes = new Map<string, AgentMessage[]>();

  /** @deprecated Use setTyped/getTyped for known keys */
  set(key: string, value: unknown): void {
    this.state.set(key, value);
  }

  /** @deprecated Use setTyped/getTyped for known keys */
  get(key: string): unknown {
    return this.state.get(key);
  }

  /** Type-safe set — enforces value type at compile time for known keys. */
  setTyped<K extends keyof MemorySchema>(key: K, value: MemorySchema[K]): void {
    this.state.set(key, value);
  }

  /** Type-safe get — returns typed value or undefined. */
  getTyped<K extends keyof MemorySchema>(key: K): MemorySchema[K] | undefined {
    return this.state.get(key) as MemorySchema[K] | undefined;
  }

  has(key: string): boolean {
    return this.state.has(key);
  }

  keys(): string[] {
    return Array.from(this.state.keys());
  }

  setOutput(agentName: string, output: AgentOutput): void {
    this.outputs.set(agentName, output);
  }

  getOutput(agentName: string): AgentOutput | undefined {
    return this.outputs.get(agentName);
  }

  sendMessage(
    from: string,
    to: string,
    content: Record<string, unknown>,
  ): void {
    const mailbox = this.mailboxes.get(to) ?? [];
    mailbox.push({
      from,
      to,
      content,
      timestamp: Date.now(),
    });
    this.mailboxes.set(to, mailbox);
  }

  getMessages(agentName: string): AgentMessage[] {
    return this.mailboxes.get(agentName) ?? [];
  }

  reset(): void {
    this.state.clear();
    this.outputs.clear();
    this.mailboxes.clear();
  }

  publish(channel: string, data: unknown): void {
    this.state.set(`__channel:${channel}`, data);
  }

  hasChannel(channel: string): boolean {
    return this.state.has(`__channel:${channel}`);
  }

  async subscribe(channel: string, timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    let delay = 50;
    while (Date.now() < deadline) {
      if (this.state.has(`__channel:${channel}`)) {
        return this.state.get(`__channel:${channel}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2000);
    }
    return null;
  }
}
