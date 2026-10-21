/**
 * TDD: Tests for OpenAICompatibleProvider.
 * Used for vLLM, llama.cpp, and any generic OpenAI-compatible endpoint.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAICompatibleProvider } from "@/providers/openai-compatible";
import type { LLMMessage, StreamDelta } from "@/providers/types";

// Mock fetch for OpenAI-compatible HTTP calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("OpenAICompatibleProvider", () => {
  let provider: OpenAICompatibleProvider;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      model: "custom-model",
      baseUrl: "http://localhost:9000/v1",
      apiKey: "optional-key",
      maxTokens: 2048,
      temperature: 0.7,
    });
  });

  it("should have name from config", () => {
    expect(provider.name).toBe("openai-compatible");
  });

  it("should support streaming", () => {
    expect(provider.supportsStreaming()).toBe(true);
  });

  it("should stream chat responses via SSE", async () => {
    // Simulate an SSE stream with OpenAI-style chunks.
    const sseStream = new ReadableStream({
      start(controller) {
        const chunks = [
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ];
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      body: sseStream,
      status: 200,
      statusText: "OK",
    });

    const messages: LLMMessage[] = [{ role: "user", content: "Hi" }];
    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chat(messages)) {
      deltas.push(delta);
    }

    expect(deltas.some((d) => d.type === "text")).toBe(true);
    expect(deltas.some((d) => d.type === "done")).toBe(true);
  });

  it("should handle connection errors", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chat([
      { role: "user", content: "Hi" },
    ])) {
      deltas.push(delta);
    }

    expect(deltas.some((d) => d.type === "error")).toBe(true);
  });

  it("should handle non-200 responses", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      body: null,
    });

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chat([
      { role: "user", content: "Hi" },
    ])) {
      deltas.push(delta);
    }

    expect(deltas.some((d) => d.type === "error")).toBe(true);
  });

  it("should stream completions for autocomplete", async () => {
    const sseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"hello()"}}]}\n\n',
          ),
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      body: sseStream,
      status: 200,
      statusText: "OK",
    });

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.complete("function hello")) {
      deltas.push(delta);
    }

    expect(deltas.some((d) => d.type === "text")).toBe(true);
  });

  it("should support tool use when model supports it", () => {
    expect(typeof provider.supportsToolUse()).toBe("boolean");
  });

  it("should count tokens", () => {
    const count = provider.countTokens("Hello");
    expect(count).toBeGreaterThan(0);
  });

  it("should dispose cleanly", () => {
    expect(() => provider.dispose()).not.toThrow();
  });
});

/**
 * Native tool-calling round-trip (review finding, 2026-10-21).
 *
 * When a provider declares supportsTools, the *second* leg of a tool
 * round-trip must be spec-compliant: the assistant turn that made the call
 * has to carry `tool_calls`, and the result has to come back as
 * `role: "tool"` with a matching `tool_call_id`. Without that linkage the
 * model cannot tell the result apart from ordinary conversation and
 * re-issues the same call forever until the iteration cap.
 *
 * The legacy flatten (drop tool linkage, downgrade `tool` -> `user`) is
 * kept for servers that do not accept the `tool` role — i.e. whenever the
 * provider does not declare supportsTools.
 */
describe("OpenAICompatibleProvider native tool round-trip", () => {
  const history = (): LLMMessage[] => [
    { role: "system", content: "You are Champ." },
    { role: "user", content: "List the files." },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_1", name: "list_directory", arguments: { path: "." } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: "call_1",
          content: "notes.txt\nsample.ts",
          isError: false,
        },
      ],
      toolCallId: "call_1",
    },
  ];

  const wire = (p: OpenAICompatibleProvider): Array<Record<string, any>> =>
    (
      p as unknown as {
        convertMessages(
          m: LLMMessage[],
          native: boolean,
        ): Array<Record<string, any>>;
      }
    ).convertMessages(history(), true);

  const nativeProvider = new OpenAICompatibleProvider({
    provider: "openai-compatible",
    model: "custom-model",
    baseUrl: "http://localhost:9000/v1",
    apiKey: "optional-key",
    supportsTools: true,
  });

  it("keeps the assistant tool-call turn on the wire", () => {
    const assistant = wire(nativeProvider).find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: {
          name: "list_directory",
          arguments: JSON.stringify({ path: "." }),
        },
      },
    ]);
  });

  it("returns the tool result as role 'tool' with a matching tool_call_id", () => {
    const toolMsg = wire(nativeProvider).find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe("call_1");
    expect(toolMsg?.content).toBe("notes.txt\nsample.ts");
  });

  it("legacy flatten (non-native) still downgrades 'tool' to 'user'", () => {
    const flat = (
      nativeProvider as unknown as {
        convertMessages(
          m: LLMMessage[],
          native: boolean,
        ): Array<Record<string, any>>;
      }
    ).convertMessages(history(), false);
    expect(flat.some((m) => m.role === "tool")).toBe(false);
    expect(flat.some((m) => m.tool_call_id !== undefined)).toBe(false);
    expect(flat.some((m) => m.tool_calls !== undefined)).toBe(false);
  });
});
