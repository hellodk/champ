/**
 * TDD: per-backend decode-parameter field mapping (ticket #120).
 * Each provider maps effective ChatOptions onto its native body names.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaProvider } from "@/providers/ollama";
import { OpenAICompatibleProvider } from "@/providers/openai-compatible";
import { DEFAULT_PROFILES } from "@/config/decode-profile";

function createMockStream(chunks: object[]): ReadableStream {
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

function sseBody(chunks: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = chunks
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .concat(["data: [DONE]\n\n"]);
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("Ollama native body mapping (#120)", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("maps effective params onto native options.* names", async () => {
    let captured: Record<string, unknown> = {};
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model_info: {} }),
      })
      .mockImplementationOnce(async (_url, init) => {
        captured = JSON.parse(init?.body as string);
        return {
          ok: true,
          body: createMockStream([{ message: { content: "hi" }, done: true }]),
        } as unknown as Response;
      });
    vi.stubGlobal("fetch", mockFetch);

    const provider = new OllamaProvider({
      provider: "ollama",
      model: "m",
      baseUrl: "http://localhost:11434",
      maxTokens: 2048,
      temperature: 0.7,
    });
    for await (const _ of provider.chat([{ role: "user", content: "hi" }], {
      taskHint: "toolcall",
    })) {
      // drain
    }
    const opts = captured.options as Record<string, unknown>;
    expect(opts.temperature).toBe(DEFAULT_PROFILES.toolcall.temperature);
    expect(opts.top_p).toBe(DEFAULT_PROFILES.toolcall.topP);
    expect(opts.seed).toBe(DEFAULT_PROFILES.toolcall.seed);
    expect(opts.num_predict).toBe(2048);
  });

  it("explicit temperature overrides the profile and YAML options", async () => {
    let captured: Record<string, unknown> = {};
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model_info: {} }),
      })
      .mockImplementationOnce(async (_url, init) => {
        captured = JSON.parse(init?.body as string);
        return {
          ok: true,
          body: createMockStream([{ message: { content: "hi" }, done: true }]),
        } as unknown as Response;
      });
    vi.stubGlobal("fetch", mockFetch);

    const provider = new OllamaProvider({
      provider: "ollama",
      model: "m",
      baseUrl: "http://localhost:11434",
      maxTokens: 2048,
      temperature: 0.7,
      options: { temperature: 0.9 },
    });
    for await (const _ of provider.chat([{ role: "user", content: "hi" }], {
      taskHint: "toolcall",
      temperature: 0.1,
    })) {
      // drain
    }
    const opts = captured.options as Record<string, unknown>;
    expect(opts.temperature).toBe(0.1);
  });

  it("YAML options beat the task profile", async () => {
    let captured: Record<string, unknown> = {};
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model_info: {} }),
      })
      .mockImplementationOnce(async (_url, init) => {
        captured = JSON.parse(init?.body as string);
        return {
          ok: true,
          body: createMockStream([{ message: { content: "hi" }, done: true }]),
        } as unknown as Response;
      });
    vi.stubGlobal("fetch", mockFetch);

    const provider = new OllamaProvider({
      provider: "ollama",
      model: "m",
      baseUrl: "http://localhost:11434",
      maxTokens: 2048,
      temperature: 0.7,
      options: { temperature: 0.9, topK: 99 },
    });
    for await (const _ of provider.chat([{ role: "user", content: "hi" }], {
      taskHint: "toolcall",
    })) {
      // drain
    }
    const opts = captured.options as Record<string, unknown>;
    expect(opts.temperature).toBe(0.9);
    expect(opts.top_k).toBe(99);
  });
});

describe("OpenAI-compatible body mapping (#120)", () => {
  it("maps effective params onto OpenAI field names", async () => {
    let captured: Record<string, unknown> = {};
    vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      captured = JSON.parse(init?.body as string);
      return {
        ok: true,
        body: sseBody([{ choices: [{ delta: {} }] }]),
      } as unknown as Response;
    });

    const provider = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      model: "m",
      baseUrl: "http://localhost:11434",
      maxTokens: 4096,
    });
    for await (const _ of provider.chat([{ role: "user", content: "hi" }], {
      taskHint: "toolcall",
    })) {
      // drain
    }
    expect(captured.temperature).toBe(DEFAULT_PROFILES.toolcall.temperature);
    expect(captured.top_p).toBe(DEFAULT_PROFILES.toolcall.topP);
    expect(captured.seed).toBe(DEFAULT_PROFILES.toolcall.seed);
    expect(captured.max_tokens).toBe(4096);
  });

  it("explicit override wins over the profile", async () => {
    let captured: Record<string, unknown> = {};
    vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      captured = JSON.parse(init?.body as string);
      return {
        ok: true,
        body: sseBody([{ choices: [{ delta: {} }] }]),
      } as unknown as Response;
    });

    const provider = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      model: "m",
      baseUrl: "http://localhost:11434",
      maxTokens: 4096,
    });
    for await (const _ of provider.chat([{ role: "user", content: "hi" }], {
      taskHint: "toolcall",
      temperature: 0.05,
      seed: 7,
    })) {
      // drain
    }
    expect(captured.temperature).toBe(0.05);
    expect(captured.seed).toBe(7);
  });
});
