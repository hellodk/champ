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
});

describe("supportsToolUse with capability detection", () => {
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

  it("returns true when Ollama reports tools capability", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: { "llama.context_length": 8192 },
        capabilities: ["completion", "tools", "insert"],
      }),
    });

    // Trigger detection
    provider.modelInfo();
    // Wait for detection
    await new Promise((r) => setTimeout(r, 10));

    expect(provider.supportsToolUse()).toBe(true);
  });

  it("returns false when Ollama reports no tools capability", async () => {
    const noToolsProvider = new OllamaProvider({
      provider: "ollama",
      model: "some-model",
      baseUrl: "http://localhost:11434",
      maxTokens: 2048,
      temperature: 0.7,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: { "llama.context_length": 8192 },
        capabilities: ["completion"], // no "tools"
      }),
    });

    noToolsProvider.modelInfo();
    await new Promise((r) => setTimeout(r, 10));

    expect(noToolsProvider.supportsToolUse()).toBe(false);
  });

  it("falls back to name-based check when capabilities field is absent (old Ollama)", async () => {
    const llama31Provider = new OllamaProvider({
      provider: "ollama",
      model: "llama3.1",
      baseUrl: "http://localhost:11434",
      maxTokens: 2048,
      temperature: 0.7,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: { "llama.context_length": 8192 },
        // No capabilities field
      }),
    });

    llama31Provider.modelInfo();
    await new Promise((r) => setTimeout(r, 10));

    // Falls back to name-based check — llama3.1 is in TOOL_CALLING_MODELS_FALLBACK
    expect(llama31Provider.supportsToolUse()).toBe(true);
  });
});

// Helper: build a ReadableStream from an array of NDJSON objects
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

describe("stripThinkingTokens (streaming)", () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new OllamaProvider({
      provider: "ollama",
      model: "qwen3:8b",
      baseUrl: "http://localhost:11434",
      maxTokens: 2048,
      temperature: 0.7,
    });
  });

  it("suppresses complete thinking blocks in a single chunk", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model_info: {} }),
      }) // detectModelCapabilities
      .mockResolvedValueOnce({
        ok: true,
        body: createMockStream([
          {
            message: {
              content: "<think>internal reasoning</think>actual answer",
            },
            done: false,
          },
          {
            message: { content: "" },
            done: true,
            prompt_eval_count: 5,
            eval_count: 10,
          },
        ]),
      });

    const chunks: string[] = [];
    for await (const delta of provider.chat([
      { role: "user", content: "test" },
    ])) {
      if (delta.type === "text" && delta.text) chunks.push(delta.text);
    }

    const fullText = chunks.join("");
    expect(fullText).not.toContain("<think>");
    expect(fullText).not.toContain("internal reasoning");
    expect(fullText).toContain("actual answer");
  });

  it("suppresses reasoning across multiple chunks", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model_info: {} }),
      }) // detectModelCapabilities
      .mockResolvedValueOnce({
        ok: true,
        body: createMockStream([
          { message: { content: "<think>start of" }, done: false },
          { message: { content: "middle reasoning" }, done: false }, // must be suppressed
          { message: { content: "end</think>real answer" }, done: false },
          {
            message: { content: "" },
            done: true,
            prompt_eval_count: 5,
            eval_count: 10,
          },
        ]),
      });

    const chunks: string[] = [];
    for await (const delta of provider.chat([
      { role: "user", content: "test" },
    ])) {
      if (delta.type === "text" && delta.text) chunks.push(delta.text);
    }

    const fullText = chunks.join("");
    expect(fullText).not.toContain("middle reasoning");
    expect(fullText).not.toContain("start of");
    expect(fullText).toContain("real answer");
  });

  it("resets thinking state between separate chat calls", async () => {
    // First call — normal response
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model_info: {} }),
      }) // detectModelCapabilities (first chat triggers it)
      .mockResolvedValueOnce({
        ok: true,
        body: createMockStream([
          { message: { content: "clean response" }, done: false },
          {
            message: { content: "" },
            done: true,
            prompt_eval_count: 5,
            eval_count: 10,
          },
        ]),
      })
      // Second call — no new detection needed (already resolved)
      .mockResolvedValueOnce({
        ok: true,
        body: createMockStream([
          { message: { content: "clean response" }, done: false },
          {
            message: { content: "" },
            done: true,
            prompt_eval_count: 5,
            eval_count: 10,
          },
        ]),
      });

    for (let i = 0; i < 2; i++) {
      const chunks: string[] = [];
      for await (const delta of provider.chat([
        { role: "user", content: "hi" },
      ])) {
        if (delta.type === "text" && delta.text) chunks.push(delta.text);
      }
      expect(chunks.join("")).toContain("clean response");
    }
  });
});
