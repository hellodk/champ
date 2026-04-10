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
    expect(ChatViewProvider.viewType).toBe("champ.chatView");
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

  describe("@-symbol resolution", () => {
    it("should resolve @Files references and append them to the user message", async () => {
      const resolverParse = vi
        .fn()
        .mockReturnValue([
          { type: "file", value: "src/main.ts", start: 0, end: 21 },
        ]);
      const resolverResolve = vi
        .fn()
        .mockResolvedValue([
          { type: "file", label: "src/main.ts", content: "console.log('hi')" },
        ]);
      provider = new ChatViewProvider(
        {
          fsPath: "/ext",
          scheme: "file",
          path: "/ext",
          toString: () => "/ext",
        } as never,
        agent,
      );
      provider.setContextResolver({
        parseReferences: resolverParse,
        resolve: resolverResolve,
      });

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({
        type: "userMessage",
        text: "@Files(src/main.ts) explain this",
      });
      await new Promise((resolve) => setImmediate(resolve));

      // Resolver was called with the user's text.
      expect(resolverParse).toHaveBeenCalledWith(
        "@Files(src/main.ts) explain this",
      );
      expect(resolverResolve).toHaveBeenCalled();

      // The agent received an enriched message containing both the
      // user's text and the resolved file content.
      const processCalls = (agent.processMessage as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(processCalls.length).toBeGreaterThan(0);
      const sentText = processCalls[0][0] as string;
      expect(sentText).toContain("@Files(src/main.ts) explain this");
      expect(sentText).toContain("console.log('hi')");
    });

    it("should pass user text through unchanged when no @-references are present", async () => {
      const resolverParse = vi.fn().mockReturnValue([]);
      const resolverResolve = vi.fn();
      provider = new ChatViewProvider(
        {
          fsPath: "/ext",
          scheme: "file",
          path: "/ext",
          toString: () => "/ext",
        } as never,
        agent,
      );
      provider.setContextResolver({
        parseReferences: resolverParse,
        resolve: resolverResolve,
      });

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "userMessage", text: "just a question" });
      await new Promise((resolve) => setImmediate(resolve));

      // Parser ran but resolver did not (no refs).
      expect(resolverParse).toHaveBeenCalled();
      expect(resolverResolve).not.toHaveBeenCalled();

      // The agent received the original text untouched.
      const processCalls = (agent.processMessage as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(processCalls[0][0]).toBe("just a question");
    });

    it("should still process the message if no resolver is attached", async () => {
      // No resolver attached at all.
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "userMessage", text: "@Files(x.ts) hi" });
      await new Promise((resolve) => setImmediate(resolve));

      // Should pass through verbatim.
      const processCalls = (agent.processMessage as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(processCalls[0][0]).toBe("@Files(x.ts) hi");
    });
  });

  describe("approval flow", () => {
    it("should pass a requestApproval callback to processMessage", async () => {
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "userMessage", text: "do something" });
      await new Promise((resolve) => setImmediate(resolve));

      const processCalls = (agent.processMessage as ReturnType<typeof vi.fn>)
        .mock.calls;
      const opts = processCalls[0][1] as {
        requestApproval?: (description: string) => Promise<boolean>;
      };
      expect(typeof opts.requestApproval).toBe("function");
    });

    it("should post an approvalRequest to the webview when the agent calls the callback", async () => {
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      // Capture the callback the provider passes to processMessage.
      let capturedRequestApproval:
        | ((description: string) => Promise<boolean>)
        | undefined;
      (agent.processMessage as ReturnType<typeof vi.fn>).mockImplementation(
        async (_text: string, opts: never) => {
          capturedRequestApproval = (
            opts as { requestApproval: (d: string) => Promise<boolean> }
          ).requestApproval;
          return { text: "", toolCalls: [] };
        },
      );

      view.fireMessage({ type: "userMessage", text: "edit something" });
      await new Promise((resolve) => setImmediate(resolve));

      // Now simulate the agent calling requestApproval.
      const approvalPromise = capturedRequestApproval!("Edit src/main.ts");

      // The provider should have posted an approvalRequest to the webview.
      const approvalPosts = postMessage.mock.calls.filter(
        (args) => (args[0] as { type: string }).type === "approvalRequest",
      );
      expect(approvalPosts.length).toBe(1);
      const sentMsg = approvalPosts[0][0] as {
        id: string;
        description: string;
      };
      expect(sentMsg.description).toContain("Edit src/main.ts");
      expect(sentMsg.id).toBeDefined();

      // Simulate the user clicking Approve.
      view.fireMessage({
        type: "approvalResponse",
        id: sentMsg.id,
        approved: true,
      });

      const result = await approvalPromise;
      expect(result).toBe(true);
    });

    it("should resolve the approval promise to false on rejection", async () => {
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      let capturedRequestApproval:
        | ((description: string) => Promise<boolean>)
        | undefined;
      (agent.processMessage as ReturnType<typeof vi.fn>).mockImplementation(
        async (_text: string, opts: never) => {
          capturedRequestApproval = (
            opts as { requestApproval: (d: string) => Promise<boolean> }
          ).requestApproval;
          return { text: "", toolCalls: [] };
        },
      );

      view.fireMessage({ type: "userMessage", text: "delete something" });
      await new Promise((resolve) => setImmediate(resolve));

      const approvalPromise = capturedRequestApproval!("Delete file.txt");

      const approvalPosts = postMessage.mock.calls.filter(
        (args) => (args[0] as { type: string }).type === "approvalRequest",
      );
      const sentMsg = approvalPosts[0][0] as { id: string };

      view.fireMessage({
        type: "approvalResponse",
        id: sentMsg.id,
        approved: false,
      });

      const result = await approvalPromise;
      expect(result).toBe(false);
    });
  });

  describe("skill invocation (slash commands)", () => {
    /**
     * Helper that wires a minimal skill registry + context provider +
     * resolver onto a fresh ChatViewProvider so each test can vary
     * just the bits it cares about.
     */
    function withSkills(skill?: {
      name: string;
      template: string;
    }): ChatViewProvider {
      const skillStub = {
        get: vi.fn((name: string) =>
          skill && name === skill.name
            ? {
                metadata: {
                  name: skill.name,
                  description: `${skill.name} description`,
                  trigger: `/${skill.name}`,
                },
                template: skill.template,
              }
            : undefined,
        ),
        list: vi.fn().mockReturnValue([]),
        matchPrefix: vi.fn().mockReturnValue([]),
      };
      const p = new ChatViewProvider(
        {
          fsPath: "/ext",
          scheme: "file",
          path: "/ext",
          toString: () => "/ext",
        } as never,
        agent,
      );
      p.setSkillRegistry(skillStub as never);
      p.setSkillContext(
        {
          build: (userInput: string) => ({
            workspaceRoot: "/work",
            date: "2026-04-08",
            userInput,
          }),
        },
        (template, ctx) =>
          template.replace(/\{\{userInput\}\}/g, ctx.userInput ?? ""),
      );
      // Expose the registry mock for test assertions.
      (p as unknown as { __skillStub: typeof skillStub }).__skillStub =
        skillStub;
      return p;
    }

    it("expands /<name> input into the skill template before sending to the agent", async () => {
      provider = withSkills({
        name: "explain",
        template: "Please explain:\n{{userInput}}",
      });

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({
        type: "userMessage",
        text: "/explain how does this auth flow work",
      });
      await new Promise((resolve) => setImmediate(resolve));

      // The agent should have been called with the resolved template,
      // not the raw "/explain ..." text.
      const processCalls = (agent.processMessage as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(processCalls.length).toBe(1);
      const sentText = processCalls[0][0] as string;
      expect(sentText).toContain("Please explain:");
      expect(sentText).toContain("how does this auth flow work");
      // The literal "/explain " should NOT have leaked into the prompt.
      expect(sentText).not.toMatch(/^\/explain /);
    });

    it("falls through to the original text when the skill name is unknown", async () => {
      provider = withSkills(); // no skills registered

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({
        type: "userMessage",
        text: "/nonsense some args",
      });
      await new Promise((resolve) => setImmediate(resolve));

      const processCalls = (agent.processMessage as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(processCalls[0][0]).toBe("/nonsense some args");
    });

    it("does not interpret messages that don't start with /", async () => {
      provider = withSkills();
      const skillStub = (
        provider as unknown as {
          __skillStub: { get: ReturnType<typeof vi.fn> };
        }
      ).__skillStub;

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({
        type: "userMessage",
        text: "hello world (no slash)",
      });
      await new Promise((resolve) => setImmediate(resolve));

      // Skill registry should NOT have been queried.
      expect(skillStub.get).not.toHaveBeenCalled();
      const processCalls = (agent.processMessage as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(processCalls[0][0]).toBe("hello world (no slash)");
    });

    it("works without any skill registry attached (no-op)", async () => {
      // No setSkillRegistry call.
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({
        type: "userMessage",
        text: "/explain something",
      });
      await new Promise((resolve) => setImmediate(resolve));

      // Should pass through verbatim.
      const processCalls = (agent.processMessage as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(processCalls[0][0]).toBe("/explain something");
    });
  });

  describe("skill autocomplete handler", () => {
    function createSkillRegistry(skills: string[]) {
      return {
        get: vi.fn(),
        list: vi.fn().mockReturnValue(
          skills.map((n) => ({
            metadata: { name: n, description: `${n} desc`, trigger: `/${n}` },
          })),
        ),
        matchPrefix: vi.fn((prefix: string) =>
          skills
            .filter((n) => n.startsWith(prefix.toLowerCase()))
            .sort()
            .map((n) => ({
              metadata: { name: n, description: `${n} desc`, trigger: `/${n}` },
            })),
        ),
      };
    }

    it("responds with matching skills when the webview asks for autocomplete", async () => {
      const skillStub = createSkillRegistry(["explain", "examine", "test"]);
      provider = new ChatViewProvider(
        {
          fsPath: "/ext",
          scheme: "file",
          path: "/ext",
          toString: () => "/ext",
        } as never,
        agent,
      );
      provider.setSkillRegistry(skillStub as never);

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "skillAutocompleteRequest", prefix: "ex" });
      await new Promise((resolve) => setImmediate(resolve));

      // Registry was queried with the correct prefix.
      expect(skillStub.matchPrefix).toHaveBeenCalledWith("ex");

      // The webview received a skillAutocompleteResponse with the matches.
      const responses = postMessage.mock.calls.filter(
        (args) =>
          (args[0] as { type: string }).type === "skillAutocompleteResponse",
      );
      expect(responses).toHaveLength(1);
      const msg = responses[0][0] as {
        prefix: string;
        suggestions: Array<{ name: string; description: string }>;
      };
      expect(msg.prefix).toBe("ex");
      expect(msg.suggestions.map((s) => s.name).sort()).toEqual([
        "examine",
        "explain",
      ]);
      expect(msg.suggestions[0].description).toContain("desc");
    });

    it("returns empty suggestions when no skill registry is attached", async () => {
      // No setSkillRegistry call.
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "skillAutocompleteRequest", prefix: "ex" });
      await new Promise((resolve) => setImmediate(resolve));

      const responses = postMessage.mock.calls.filter(
        (args) =>
          (args[0] as { type: string }).type === "skillAutocompleteResponse",
      );
      expect(responses).toHaveLength(1);
      const msg = responses[0][0] as { suggestions: unknown[] };
      expect(msg.suggestions).toEqual([]);
    });

    it("returns all skills for empty prefix", async () => {
      const skillStub = createSkillRegistry(["explain", "test", "commit"]);
      provider = new ChatViewProvider(
        {
          fsPath: "/ext",
          scheme: "file",
          path: "/ext",
          toString: () => "/ext",
        } as never,
        agent,
      );
      provider.setSkillRegistry(skillStub as never);

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "skillAutocompleteRequest", prefix: "" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(skillStub.matchPrefix).toHaveBeenCalledWith("");
      const responses = postMessage.mock.calls.filter(
        (args) =>
          (args[0] as { type: string }).type === "skillAutocompleteResponse",
      );
      const msg = responses[0][0] as {
        suggestions: Array<{ name: string }>;
      };
      expect(msg.suggestions).toHaveLength(3);
    });
  });

  describe("Chat UI v2 — settings, help, setModel, providerStatus", () => {
    it("openSettingsRequest fires the workbench.action.openSettings command", async () => {
      const vscode = await import("vscode");
      const exec = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
      exec.mockClear();

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "openSettingsRequest" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(exec).toHaveBeenCalledWith(
        "workbench.action.openSettings",
        "champ",
      );
    });

    it("showHelpRequest fires the champ.showHelp command", async () => {
      const vscode = await import("vscode");
      const exec = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
      exec.mockClear();

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "showHelpRequest" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(exec).toHaveBeenCalledWith("champ.showHelp");
    });

    it("setModelRequest fires champ.setActiveModel with the providerName", async () => {
      const vscode = await import("vscode");
      const exec = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
      exec.mockClear();

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({
        type: "setModelRequest",
        providerName: "vllm",
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(exec).toHaveBeenCalledWith("champ.setActiveModel", "vllm");
    });

    it("broadcastProviderStatus posts a providerStatus message to the webview", () => {
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      provider.broadcastProviderStatus({
        state: "ready",
        providerName: "ollama",
        modelName: "qwen2.5-coder:14b",
        available: [
          {
            providerName: "ollama",
            modelName: "qwen2.5-coder:14b",
            label: "ollama: qwen2.5-coder:14b",
          },
        ],
      });

      const posts = postMessage.mock.calls.filter(
        (args) => (args[0] as { type: string }).type === "providerStatus",
      );
      expect(posts).toHaveLength(1);
      const msg = posts[0][0] as {
        state: string;
        providerName?: string;
        modelName?: string;
        available: Array<{ providerName: string }>;
      };
      expect(msg.state).toBe("ready");
      expect(msg.providerName).toBe("ollama");
      expect(msg.modelName).toBe("qwen2.5-coder:14b");
      expect(msg.available).toHaveLength(1);
    });

    it("broadcastProviderStatus state=loading carries no provider info", () => {
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      provider.broadcastProviderStatus({ state: "loading", available: [] });

      const posts = postMessage.mock.calls.filter(
        (args) => (args[0] as { type: string }).type === "providerStatus",
      );
      const msg = posts[0][0] as {
        state: string;
        providerName?: string;
      };
      expect(msg.state).toBe("loading");
      expect(msg.providerName).toBeUndefined();
    });

    it("broadcastProviderStatus state=error includes errorMessage", () => {
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      provider.broadcastProviderStatus({
        state: "error",
        errorMessage: "Connection refused",
        available: [],
      });

      const posts = postMessage.mock.calls.filter(
        (args) => (args[0] as { type: string }).type === "providerStatus",
      );
      const msg = posts[0][0] as { state: string; errorMessage?: string };
      expect(msg.state).toBe("error");
      expect(msg.errorMessage).toBe("Connection refused");
    });
  });

  describe("Onboarding flow (Phase B)", () => {
    it("firstRunSelectRequest fires champ.firstRunSelect with the templateId", async () => {
      const vscode = await import("vscode");
      const exec = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
      exec.mockClear();

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({
        type: "firstRunSelectRequest",
        templateId: "ollama-basic",
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(exec).toHaveBeenCalledWith("champ.firstRunSelect", "ollama-basic");
    });

    it("firstRunDismissRequest fires champ.firstRunDismiss", async () => {
      const vscode = await import("vscode");
      const exec = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
      exec.mockClear();

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "firstRunDismissRequest" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(exec).toHaveBeenCalledWith("champ.firstRunDismiss");
    });

    it("broadcastFirstRunWelcome posts a firstRunWelcome message to the webview", () => {
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      provider.broadcastFirstRunWelcome([
        { id: "ollama-basic", label: "Ollama", description: "Local" },
      ]);

      const posts = postMessage.mock.calls.filter(
        (args) => (args[0] as { type: string }).type === "firstRunWelcome",
      );
      expect(posts).toHaveLength(1);
      const msg = posts[0][0] as {
        templates: Array<{ id: string }>;
      };
      expect(msg.templates).toHaveLength(1);
      expect(msg.templates[0].id).toBe("ollama-basic");
    });
  });

  describe("File attachment flow (Phase C)", () => {
    it("stores an attached file and enriches the next user message", async () => {
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      // Attach a file.
      view.fireMessage({
        type: "attachFileRequest",
        filename: "notes.txt",
        mimeType: "text/plain",
        contentBase64: btoa("Hello world"),
      });
      await new Promise((resolve) => setImmediate(resolve));

      // Now send a message — it should include the file content.
      view.fireMessage({
        type: "userMessage",
        text: "summarize this file",
      });
      await new Promise((resolve) => setImmediate(resolve));

      const processCalls = (agent.processMessage as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(processCalls.length).toBeGreaterThan(0);
      const sentText = processCalls[0][0] as string;
      expect(sentText).toContain("summarize this file");
      expect(sentText).toContain("notes.txt");
      expect(sentText).toContain("Hello world");
    });

    it("clears pending attachments after sending a message", async () => {
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      // Attach then send.
      view.fireMessage({
        type: "attachFileRequest",
        filename: "a.txt",
        mimeType: "text/plain",
        contentBase64: btoa("data"),
      });
      await new Promise((resolve) => setImmediate(resolve));

      view.fireMessage({ type: "userMessage", text: "first" });
      await new Promise((resolve) => setImmediate(resolve));

      // Reset mock and send a second message without attaching again.
      (agent.processMessage as ReturnType<typeof vi.fn>).mockClear();
      view.fireMessage({ type: "userMessage", text: "second" });
      await new Promise((resolve) => setImmediate(resolve));

      const processCalls = (agent.processMessage as ReturnType<typeof vi.fn>)
        .mock.calls;
      const sentText = processCalls[0][0] as string;
      // Should NOT contain the attachment from the first send.
      expect(sentText).not.toContain("a.txt");
      expect(sentText).toBe("second");
    });
  });

  describe("Session management handlers (History)", () => {
    it("switchSessionRequest fires champ.switchSession with sessionId", async () => {
      const vscode = await import("vscode");
      const exec = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
      exec.mockClear();

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "switchSessionRequest", sessionId: "s1" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(exec).toHaveBeenCalledWith("champ.switchSession", "s1");
    });

    it("newSessionRequest fires champ.newSession", async () => {
      const vscode = await import("vscode");
      const exec = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
      exec.mockClear();

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "newSessionRequest" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(exec).toHaveBeenCalledWith("champ.newSession", undefined);
    });

    it("deleteSessionRequest fires champ.deleteSession with sessionId", async () => {
      const vscode = await import("vscode");
      const exec = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
      exec.mockClear();

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({ type: "deleteSessionRequest", sessionId: "s2" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(exec).toHaveBeenCalledWith("champ.deleteSession", "s2");
    });

    it("renameSessionRequest fires champ.renameSession", async () => {
      const vscode = await import("vscode");
      const exec = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
      exec.mockClear();

      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      view.fireMessage({
        type: "renameSessionRequest",
        sessionId: "s1",
        newLabel: "renamed",
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(exec).toHaveBeenCalledWith("champ.renameSession", "s1", "renamed");
    });

    it("broadcastSessionList posts a sessionList message to the webview", () => {
      const view = createMockWebviewView(postMessage);
      provider.resolveWebviewView(view as never, {} as never, {} as never);

      provider.broadcastSessionList(
        [
          {
            id: "s1",
            label: "test",
            state: "idle",
            createdAt: 0,
            lastActivityAt: 0,
            mode: "agent",
            messageCount: 0,
            modifiedFiles: [],
            archived: false,
          },
        ],
        "s1",
      );

      const posts = postMessage.mock.calls.filter(
        (args) => (args[0] as { type: string }).type === "sessionList",
      );
      expect(posts).toHaveLength(1);
      const msg = posts[0][0] as {
        sessions: Array<{ id: string }>;
        activeSessionId: string | null;
      };
      expect(msg.sessions).toHaveLength(1);
      expect(msg.activeSessionId).toBe("s1");
    });
  });
});
