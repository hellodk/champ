// src/agent/__tests__/agent-worker-bridge.test.ts
import { describe, it, expect, vi } from "vitest";
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  WorkerBridge,
} from "../agent-worker-bridge";

// ---------------------------------------------------------------------------
// WorkerInboundMessage type tests
// ---------------------------------------------------------------------------

describe("WorkerInboundMessage", () => {
  it("accepts a 'start' message with task and config", () => {
    const msg: WorkerInboundMessage = {
      type: "start",
      task: "fix the bug in auth.ts",
      config: { model: "claude-3-5-sonnet" },
    };
    expect(msg.type).toBe("start");
    expect((msg as Extract<WorkerInboundMessage, { type: "start" }>).task).toBe(
      "fix the bug in auth.ts",
    );
  });

  it("accepts a 'toolResult' message with callId and result", () => {
    const msg: WorkerInboundMessage = {
      type: "toolResult",
      callId: "call-abc123",
      result: "file contents here",
    };
    expect(msg.type).toBe("toolResult");
    const typed = msg as Extract<WorkerInboundMessage, { type: "toolResult" }>;
    expect(typed.callId).toBe("call-abc123");
    expect(typed.result).toBe("file contents here");
  });

  it("accepts an 'abort' message", () => {
    const msg: WorkerInboundMessage = { type: "abort" };
    expect(msg.type).toBe("abort");
  });
});

// ---------------------------------------------------------------------------
// WorkerOutboundMessage type tests
// ---------------------------------------------------------------------------

describe("WorkerOutboundMessage", () => {
  it("accepts a 'streamDelta' message", () => {
    const msg: WorkerOutboundMessage = {
      type: "streamDelta",
      text: "Hello, world!",
    };
    expect(msg.type).toBe("streamDelta");
    const typed = msg as Extract<
      WorkerOutboundMessage,
      { type: "streamDelta" }
    >;
    expect(typed.text).toBe("Hello, world!");
  });

  it("accepts a 'toolCall' message with callId, name, and args", () => {
    const msg: WorkerOutboundMessage = {
      type: "toolCall",
      callId: "call-xyz",
      name: "read_file",
      args: { path: "src/index.ts" },
    };
    expect(msg.type).toBe("toolCall");
    const typed = msg as Extract<WorkerOutboundMessage, { type: "toolCall" }>;
    expect(typed.name).toBe("read_file");
    expect(typed.callId).toBe("call-xyz");
  });

  it("accepts an 'iteration' message with iteration and tokens", () => {
    const msg: WorkerOutboundMessage = {
      type: "iteration",
      iteration: 3,
      tokens: 4200,
    };
    expect(msg.type).toBe("iteration");
    const typed = msg as Extract<WorkerOutboundMessage, { type: "iteration" }>;
    expect(typed.iteration).toBe(3);
    expect(typed.tokens).toBe(4200);
  });

  it("accepts a 'done' message with usage stats", () => {
    const msg: WorkerOutboundMessage = {
      type: "done",
      usage: { input: 1500, output: 300 },
    };
    expect(msg.type).toBe("done");
    const typed = msg as Extract<WorkerOutboundMessage, { type: "done" }>;
    expect(typed.usage.input).toBe(1500);
    expect(typed.usage.output).toBe(300);
  });

  it("accepts an 'error' message with a message string", () => {
    const msg: WorkerOutboundMessage = {
      type: "error",
      message: "Provider rate-limited",
    };
    expect(msg.type).toBe("error");
    const typed = msg as Extract<WorkerOutboundMessage, { type: "error" }>;
    expect(typed.message).toBe("Provider rate-limited");
  });
});

// ---------------------------------------------------------------------------
// WorkerBridge interface tests (using a mock implementation)
// ---------------------------------------------------------------------------

describe("WorkerBridge", () => {
  function makeMockBridge(): WorkerBridge {
    const handlers = new Set<(msg: WorkerOutboundMessage) => void>();
    return {
      send: vi.fn(),
      onMessage(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      terminate: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("allows sending an inbound message", () => {
    const bridge = makeMockBridge();
    const msg: WorkerInboundMessage = {
      type: "start",
      task: "do something",
      config: {},
    };
    bridge.send(msg);
    expect(bridge.send).toHaveBeenCalledWith(msg);
  });

  it("allows registering and unregistering an onMessage handler", () => {
    const bridge = makeMockBridge();
    const handler = vi.fn();
    const unregister = bridge.onMessage(handler);
    expect(typeof unregister).toBe("function");
    // Calling unregister should not throw
    unregister();
  });

  it("terminate resolves without error", async () => {
    const bridge = makeMockBridge();
    await expect(bridge.terminate()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AgentController.onIterationStart integration — lightweight smoke test
// ---------------------------------------------------------------------------

describe("AgentController onIterationStart", () => {
  it("registers and unregisters an iteration start listener", async () => {
    // Import lazily to avoid VS Code module errors in test env.
    const { AgentController } = await import("../agent-controller.js");

    // Minimal stub provider
    const provider = {
      chat: vi.fn().mockReturnValue(
        (async function* () {
          yield { type: "text", text: "hello" };
          yield {
            type: "done",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        })(),
      ),
      supportsToolUse: () => false,
      countTokens: (_text: string) => Math.ceil(_text.length / 4),
      modelInfo: () => ({
        name: "stub",
        id: "stub",
        supportsImages: false,
        contextWindow: 4096,
      }),
    };

    // Minimal tool registry stub
    const toolRegistry = {
      getDefinitions: () => [],
      execute: vi.fn(),
    };

    const controller = new AgentController(
      provider as any,

      toolRegistry as any,
      "/tmp",
    );

    const calls: Array<[number, number]> = [];
    const unsubscribe = controller.onIterationStart(
      (iter: number, tokens: number) => {
        calls.push([iter, tokens]);
      },
    );

    await controller.processMessage("hello");

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toBe(0); // first iteration is 0

    // After unsubscribing, a new message should not trigger the listener.
    const callCountBefore = calls.length;
    unsubscribe();

    // Reset provider mock for second call
    provider.chat.mockReturnValue(
      (async function* () {
        yield { type: "text", text: "bye" };
        yield {
          type: "done",
          usage: { inputTokens: 5, outputTokens: 2 },
        };
      })(),
    );

    await controller.processMessage("bye");
    expect(calls.length).toBe(callCountBefore); // no new calls after unsubscribe
  });
});
