/**
 * TDD: Tests for OllamaProvider.
 * Tests local model interaction, streaming, model listing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { OllamaProvider } from "@/providers/ollama";
import type { LLMMessage, StreamDelta } from "@/providers/types";

// Mock fetch for Ollama HTTP calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("OllamaProvider", () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new OllamaProvider({
      provider: "ollama",
      model: "llama3.1",
      baseUrl: "http://localhost:11434",
      maxTokens: 2048,
      temperature: 0.7,
    });
  });

  it("should have correct name", () => {
    expect(provider.name).toBe("ollama");
  });

  it("should default baseUrl to localhost:11434", () => {
    const p = new OllamaProvider({
      provider: "ollama",
      model: "llama3.1",
      maxTokens: 2048,
      temperature: 0.7,
    });
    expect(p.config.baseUrl).toBe("http://localhost:11434");
  });

  it("should support streaming", () => {
    expect(provider.supportsStreaming()).toBe(true);
  });

  it("should report tool use support based on model capabilities", () => {
    // Ollama supports tool use for some models
    const result = provider.supportsToolUse();
    expect(typeof result).toBe("boolean");
  });

  it("should stream chat responses", async () => {
    // Mock the Ollama /api/chat endpoint
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ message: { content: "Hello" }, done: false }) +
              "\n",
          ),
        );
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              message: { content: " world" },
              done: true,
              eval_count: 10,
              prompt_eval_count: 5,
            }) + "\n",
          ),
        );
        controller.close();
      },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      body: mockStream,
    });

    const messages: LLMMessage[] = [{ role: "user", content: "Hi" }];
    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chat(messages)) {
      deltas.push(delta);
    }

    expect(deltas.length).toBeGreaterThan(0);
    const textDeltas = deltas.filter((d) => d.type === "text");
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it("should stream completion responses for autocomplete", async () => {
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ response: "function hello() {", done: false }) +
              "\n",
          ),
        );
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ response: "}", done: true }) + "\n",
          ),
        );
        controller.close();
      },
    });

    mockFetch.mockResolvedValue({ ok: true, body: mockStream });

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.complete("function he")) {
      deltas.push(delta);
    }

    expect(deltas.some((d) => d.type === "text")).toBe(true);
  });

  it("should handle connection errors gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const messages: LLMMessage[] = [{ role: "user", content: "Hi" }];
    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chat(messages)) {
      deltas.push(delta);
    }

    expect(deltas.some((d) => d.type === "error")).toBe(true);
  });

  it("should return model info", () => {
    const info = provider.modelInfo();
    expect(info.provider).toBe("ollama");
    expect(info.id).toBe("llama3.1");
  });

  it("should dispose cleanly", () => {
    expect(() => provider.dispose()).not.toThrow();
  });

  describe("context window detection", () => {
    function createMockStream(
      chunks: Array<Record<string, unknown>>,
    ): ReadableStream {
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(chunk) + "\n"),
            );
          }
          controller.close();
        },
      });
    }

    it("awaits context window detection before trimming in chat()", async () => {
      let resolveDetection!: () => void;
      const detectionPromise = new Promise<void>((resolve) => {
        resolveDetection = resolve;
      });

      // First call: /api/show (detection), then /api/chat (actual request)
      mockFetch
        .mockImplementationOnce(async () => {
          await detectionPromise; // simulate slow detection
          return {
            ok: true,
            json: async () => ({
              model_info: { "llama.context_length": 4096 },
            }),
          };
        })
        .mockImplementationOnce(async () => ({
          ok: true,
          body: createMockStream([
            { message: { content: "hello" }, done: false },
            {
              message: { content: "" },
              done: true,
              prompt_eval_count: 10,
              eval_count: 5,
            },
          ]),
        }));

      // Start chat — should await detection
      const chatPromise = (async () => {
        const chunks: string[] = [];
        for await (const delta of provider.chat([
          { role: "user", content: "hello" },
        ])) {
          if (delta.type === "text") chunks.push(delta.text ?? "");
        }
        return chunks;
      })();

      // Resolve detection after a tick
      resolveDetection();
      await chatPromise;

      // After chat completes, detectedContextWindow should be 4096
      expect(
        (provider as unknown as { detectedContextWindow: number })
          .detectedContextWindow,
      ).toBe(4096);
    });

    it("uses default 8192 when /api/show fails", async () => {
      mockFetch
        .mockImplementationOnce(async () => ({ ok: false, status: 404 })) // detection fails
        .mockImplementationOnce(async () => ({
          ok: true,
          body: createMockStream([
            { message: { content: "hello" }, done: false },
            {
              message: { content: "" },
              done: true,
              prompt_eval_count: 10,
              eval_count: 5,
            },
          ]),
        }));

      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
        // consume stream
      }

      expect(
        (provider as unknown as { detectedContextWindow: number })
          .detectedContextWindow,
      ).toBe(8192);
    });
  });
});
