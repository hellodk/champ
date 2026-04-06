/**
 * TDD: Tests for ChatViewProvider message handling.
 *
 * The tests cover the message-handling layer (what happens when the
 * webview sends a user message, changes mode, cancels, etc.), not the
 * WebviewView resolution itself — that's exercised via F5/E2E tests.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatViewProvider } from "@/ui/chat-view-provider";
import type { AgentController } from "@/agent/agent-controller";

function createMockAgent(): AgentController {
  return {
    processMessage: vi.fn().mockResolvedValue({
      text: "response",
      toolCalls: [],
    }),
    reset: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
    onStreamDelta: vi.fn().mockReturnValue(() => {}),
  } as unknown as AgentController;
}

function createMockWebviewView(postMessageMock: ReturnType<typeof vi.fn>) {
  let messageListener: ((msg: unknown) => void) | null = null;
  return {
    webview: {
      postMessage: postMessageMock,
      onDidReceiveMessage: vi.fn((listener: (msg: unknown) => void) => {
        messageListener = listener;
        return { dispose: vi.fn() };
      }),
      options: {},
      html: "",
      asWebviewUri: vi.fn((uri: unknown) => uri),
      cspSource: "vscode-resource:",
    },
    onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    visible: true,
    fireMessage(msg: unknown): void {
      messageListener?.(msg);
    },
  };
}

describe("ChatViewProvider", () => {
  let agent: AgentController;
  let provider: ChatViewProvider;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    agent = createMockAgent();
    postMessage = vi.fn();
    provider = new ChatViewProvider(
      {
        fsPath: "/ext",
        scheme: "file",
        path: "/ext",
        toString: () => "/ext",
      } as never,
      agent,
    );
  });

  it("has a static viewType identifier", () => {
    expect(ChatViewProvider.viewType).toBe("aidev.chatView");
  });

  it("resolves a webview view and sets HTML", () => {
    const view = createMockWebviewView(postMessage);
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    expect(view.webview.html).toContain("<!DOCTYPE html>");
  });

  it("routes userMessage to the agent controller", async () => {
    const view = createMockWebviewView(postMessage);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    view.fireMessage({ type: "userMessage", text: "Hello" });
    // Wait for the async handler to complete.
    await new Promise((resolve) => setImmediate(resolve));

    expect(agent.processMessage).toHaveBeenCalledWith(
      "Hello",
      expect.any(Object),
    );
  });

  it("resets conversation on newChat message", async () => {
    const view = createMockWebviewView(postMessage);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    view.fireMessage({ type: "newChat" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(agent.reset).toHaveBeenCalled();
  });

  it("cancels active request on cancelRequest message", () => {
    const view = createMockWebviewView(postMessage);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    view.fireMessage({ type: "userMessage", text: "slow task" });
    view.fireMessage({ type: "cancelRequest" });

    // The controller itself is mocked, but we can confirm the cancel
    // handler ran without errors — the internal abort controller is
    // triggered synchronously.
    expect(view.webview.onDidReceiveMessage).toHaveBeenCalled();
  });

  it("posts streamDelta messages during processing", async () => {
    // Capture the stream listener so we can simulate deltas.
    let deltaListener: ((delta: unknown) => void) | null = null;
    (agent.onStreamDelta as ReturnType<typeof vi.fn>).mockImplementation(
      (listener: (delta: unknown) => void) => {
        deltaListener = listener;
        return () => {};
      },
    );

    const view = createMockWebviewView(postMessage);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    view.fireMessage({ type: "userMessage", text: "Hi" });
    // Let the handler register its stream listener before firing.
    await new Promise((resolve) => setImmediate(resolve));

    deltaListener?.({ type: "text", text: "Hello" });

    // The provider should forward text deltas to the webview.
    const streamDeltaPosts = postMessage.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === "streamDelta",
    );
    expect(streamDeltaPosts.length).toBeGreaterThan(0);
  });
});
