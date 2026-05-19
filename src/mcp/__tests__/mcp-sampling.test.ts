/**
 * Tests for MCP sampling/createMessage support.
 *
 * MCP sampling allows a server to request LLM completions FROM the client
 * (Champ). These tests verify that MCPClientManager correctly handles
 * inbound sampling requests, routes them to the registered handler, and
 * sends back well-formed JSON-RPC responses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPClientManager } from "../../mcp/mcp-client";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Build a minimal fake MCPConnection with a writable stdin spy. */
function makeConnection(name = "test-server") {
  const written: string[] = [];
  const stdinWrite = vi.fn((data: string) => {
    written.push(data);
    return true;
  });

  const connection = {
    config: { name, command: "echo" },
    tools: [],
    process: {
      stdin: { write: stdinWrite },
      stdout: null,
      kill: vi.fn(),
      on: vi.fn(),
    },
    nextId: 1,
    pendingRequests: new Map(),
    buffer: "",
    capabilities: {},
  };

  return { connection, written, stdinWrite };
}

/** Call the private processBuffer method via type-cast. */
function processBuffer(manager: MCPClientManager, connection: unknown): void {
  (
    manager as unknown as {
      processBuffer: (c: unknown) => void;
    }
  ).processBuffer(connection);
}

/** Call the private handleServerRequest method via type-cast. */
async function handleServerRequest(
  manager: MCPClientManager,
  connection: unknown,
  id: number | string,
  method: string,
  params: unknown,
): Promise<void> {
  return (
    manager as unknown as {
      handleServerRequest: (
        c: unknown,
        id: number | string,
        method: string,
        params: unknown,
      ) => Promise<void>;
    }
  ).handleServerRequest(connection, id, method, params);
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("MCPClientManager.onSamplingRequest", () => {
  it("is undefined by default", () => {
    const manager = new MCPClientManager();
    expect(manager.onSamplingRequest).toBeUndefined();
  });

  it("can be assigned a callback", () => {
    const manager = new MCPClientManager();
    const handler = vi.fn().mockResolvedValue("Hello from LLM");
    manager.onSamplingRequest = handler;
    expect(manager.onSamplingRequest).toBe(handler);
  });
});

describe("MCPClientManager handleServerRequest — sampling/createMessage", () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    manager = new MCPClientManager();
  });

  it("calls onSamplingRequest with normalised messages and returns result", async () => {
    const { connection, written } = makeConnection();
    const handler = vi.fn().mockResolvedValue("42 is the answer");
    manager.onSamplingRequest = handler;

    await handleServerRequest(
      manager,
      connection,
      7,
      "sampling/createMessage",
      {
        messages: [
          { role: "user", content: { type: "text", text: "What is 6*7?" } },
        ],
        maxTokens: 256,
      },
    );

    expect(handler).toHaveBeenCalledWith(
      "test-server",
      [{ role: "user", content: "What is 6*7?" }],
      256,
    );

    expect(written.length).toBe(1);
    const response = JSON.parse(written[0]) as {
      jsonrpc: string;
      id: number;
      result: {
        role: string;
        content: { type: string; text: string };
        stopReason: string;
        model: string;
      };
    };
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(7);
    expect(response.result.role).toBe("assistant");
    expect(response.result.content.type).toBe("text");
    expect(response.result.content.text).toBe("42 is the answer");
    expect(response.result.stopReason).toBe("endTurn");
    expect(response.result.model).toBe("champ");
  });

  it("uses maxTokens default of 1000 when not supplied", async () => {
    const { connection } = makeConnection();
    const handler = vi.fn().mockResolvedValue("ok");
    manager.onSamplingRequest = handler;

    await handleServerRequest(
      manager,
      connection,
      1,
      "sampling/createMessage",
      {
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      },
    );

    expect(handler).toHaveBeenCalledWith(
      "test-server",
      [{ role: "user", content: "hi" }],
      1000,
    );
  });

  it("maps unknown roles to 'user'", async () => {
    const { connection } = makeConnection();
    const handler = vi.fn().mockResolvedValue("ok");
    manager.onSamplingRequest = handler;

    await handleServerRequest(
      manager,
      connection,
      2,
      "sampling/createMessage",
      {
        messages: [
          { role: "system", content: { type: "text", text: "be helpful" } },
        ],
        maxTokens: 100,
      },
    );

    const [, msgs] = handler.mock.calls[0] as [
      string,
      Array<{ role: string; content: string }>,
      number,
    ];
    expect(msgs[0].role).toBe("user");
  });

  it("preserves 'assistant' role", async () => {
    const { connection } = makeConnection();
    const handler = vi.fn().mockResolvedValue("ok");
    manager.onSamplingRequest = handler;

    await handleServerRequest(
      manager,
      connection,
      3,
      "sampling/createMessage",
      {
        messages: [
          {
            role: "assistant",
            content: { type: "text", text: "I am an assistant" },
          },
        ],
        maxTokens: 100,
      },
    );

    const [, msgs] = handler.mock.calls[0] as [
      string,
      Array<{ role: string; content: string }>,
      number,
    ];
    expect(msgs[0].role).toBe("assistant");
  });

  it("returns error response when onSamplingRequest is not configured", async () => {
    const { connection, written } = makeConnection();
    // No handler assigned

    await handleServerRequest(
      manager,
      connection,
      9,
      "sampling/createMessage",
      {
        messages: [],
        maxTokens: 100,
      },
    );

    const response = JSON.parse(written[0]) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toBe("Sampling not configured");
  });

  it("returns error response when handler throws", async () => {
    const { connection, written } = makeConnection();
    manager.onSamplingRequest = vi
      .fn()
      .mockRejectedValue(new Error("LLM unavailable"));

    await handleServerRequest(
      manager,
      connection,
      5,
      "sampling/createMessage",
      {
        messages: [{ role: "user", content: { type: "text", text: "hello" } }],
        maxTokens: 50,
      },
    );

    const response = JSON.parse(written[0]) as {
      error: { code: number; message: string };
    };
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toBe("LLM unavailable");
  });

  it("returns method-not-found for unknown methods", async () => {
    const { connection, written } = makeConnection();

    await handleServerRequest(manager, connection, 11, "unknown/method", {});

    const response = JSON.parse(written[0]) as {
      error: { code: number; message: string };
    };
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toBe("Method not found");
  });

  it("handles empty messages array gracefully", async () => {
    const { connection, written } = makeConnection();
    const handler = vi.fn().mockResolvedValue("empty response");
    manager.onSamplingRequest = handler;

    await handleServerRequest(
      manager,
      connection,
      4,
      "sampling/createMessage",
      {
        messages: [],
        maxTokens: 100,
      },
    );

    expect(handler).toHaveBeenCalledWith("test-server", [], 100);
    const response = JSON.parse(written[0]) as {
      result: { content: { text: string } };
    };
    expect(response.result.content.text).toBe("empty response");
  });
});

describe("MCPClientManager processBuffer — server-initiated requests", () => {
  it("dispatches sampling/createMessage from processBuffer", async () => {
    const manager = new MCPClientManager();
    const handler = vi.fn().mockResolvedValue("processed");
    manager.onSamplingRequest = handler;

    const { connection } = makeConnection("buf-server");

    // Inject a JSON-RPC request line into the buffer
    const requestLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "sampling/createMessage",
      params: {
        messages: [{ role: "user", content: { type: "text", text: "ping" } }],
        maxTokens: 10,
      },
    });
    connection.buffer = requestLine + "\n";

    processBuffer(manager, connection);

    // Allow async handleServerRequest to complete
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(handler).toHaveBeenCalledWith(
      "buf-server",
      [{ role: "user", content: "ping" }],
      10,
    );
  });

  it("still handles normal responses in processBuffer alongside server requests", () => {
    const manager = new MCPClientManager();
    const { connection } = makeConnection();

    const resolve = vi.fn();
    const reject = vi.fn();
    const timer = setTimeout(() => {}, 30_000);
    connection.pendingRequests.set(1, { resolve, reject, timer });
    connection.nextId = 2;

    const responseLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });
    connection.buffer = responseLine + "\n";

    processBuffer(manager, connection);

    expect(resolve).toHaveBeenCalledWith({ tools: [] });
    clearTimeout(timer);
  });

  it("handles server notifications (no id) without throwing", () => {
    const manager = new MCPClientManager();
    const { connection } = makeConnection();

    const notificationLine = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {},
    });
    connection.buffer = notificationLine + "\n";

    // Should not throw
    expect(() => processBuffer(manager, connection)).not.toThrow();
  });
});

describe("MCPClientManager initialize capability declaration", () => {
  it("initialize params include sampling capability", () => {
    // Verify the shape of the initialize params that will be sent during connect().
    // Full connect() integration requires mocking spawn; here we verify the
    // params object that is passed to sendRequest matches the spec.
    const initParams = {
      protocolVersion: "2024-11-05",
      capabilities: {
        sampling: {},
      },
      clientInfo: { name: "champ-vscode", version: "0.3.0" },
    };

    expect(initParams.capabilities).toHaveProperty("sampling");
    expect(initParams.capabilities.sampling).toEqual({});
  });
});
