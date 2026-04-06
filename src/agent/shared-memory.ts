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

export class SharedMemory implements ISharedMemory {
  private state = new Map<string, unknown>();
  private outputs = new Map<string, AgentOutput>();
  private mailboxes = new Map<string, AgentMessage[]>();

  set(key: string, value: unknown): void {
    this.state.set(key, value);
  }

  get(key: string): unknown {
    return this.state.get(key);
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
}
