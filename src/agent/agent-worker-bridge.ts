/**
 * AgentWorkerBridge: interface for the planned worker thread isolation.
 *
 * When Phase 6 (champd daemon) is implemented, AgentController execution
 * will move to a worker thread or daemon process. This interface defines
 * the message protocol between host and worker.
 *
 * Current status: event loop yielding via setImmediate is used instead
 * of true worker threads (VS Code extension host limitations make full
 * worker thread isolation complex — tool calls require VS Code APIs that
 * are only available on the main thread).
 */

export type WorkerInboundMessage =
  | { type: "start"; task: string; config: unknown }
  | { type: "toolResult"; callId: string; result: string }
  | { type: "abort" };

export type WorkerOutboundMessage =
  | { type: "streamDelta"; text: string }
  | { type: "toolCall"; callId: string; name: string; args: unknown }
  | { type: "iteration"; iteration: number; tokens: number }
  | { type: "done"; usage: { input: number; output: number } }
  | { type: "error"; message: string };

/**
 * WorkerBridge: the host-side handle for a running worker agent.
 *
 * In the current implementation (setImmediate yielding) this interface
 * is not yet instantiated — it serves as a specification contract for
 * Phase 6 implementation. When full worker isolation is shipped, the
 * extension host will construct a WorkerBridge per agent session and
 * route all tool execution and UI updates through it.
 */
export interface WorkerBridge {
  /**
   * Send a message into the worker. The worker's message handler
   * dispatches inbound messages to the appropriate handler.
   */
  send(message: WorkerInboundMessage): void;

  /**
   * Register a handler for messages coming out of the worker.
   * Returns a disposable function to unregister.
   */
  onMessage(handler: (message: WorkerOutboundMessage) => void): () => void;

  /**
   * Terminate the worker immediately. Pending tool calls are dropped.
   */
  terminate(): Promise<void>;
}
