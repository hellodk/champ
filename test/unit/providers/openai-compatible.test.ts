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
