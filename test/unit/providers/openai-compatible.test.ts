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

describe("OpenAICompatibleProvider wire fidelity (#186)", () => {
  const provider = (contextWindow = 1000): OpenAICompatibleProvider =>
    new OpenAICompatibleProvider({
      provider: "openai-compatible",
      model: "custom-model",
      baseUrl: "http://localhost:9000/v1",
      contextWindow,
      maxTokens: 100,
      temperature: 0.7,
    });

  const wire = (
    p: OpenAICompatibleProvider,
    messages: LLMMessage[],
    nativeTools = true,
  ): Array<Record<string, any>> =>
    (
      p as unknown as {
        convertMessages(
          m: LLMMessage[],
          native: boolean,
        ): Array<Record<string, any>>;
      }
    ).convertMessages(messages, nativeTools);

  it("keeps middle turns that fit when an older turn is oversized", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "S".repeat(2000) },
      { role: "user", content: "small old turn that still fits" },
      { role: "user", content: "old".repeat(2000) },
      { role: "assistant", content: "middle answer" },
      { role: "user", content: "new question" },
    ];
    const result = wire(provider(), messages);
    expect(result.map((m) => m.content)).toContain(
      "small old turn that still fits",
    );
    expect(result.map((m) => m.content)).toContain("middle answer");
    expect(result[result.length - 1].content).toBe("new question");
  });

  it("does not split an assistant tool call from its result", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: "a".repeat(4000),
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "." } }],
      },
      { role: "tool", content: "file body", toolCallId: "c1" },
      { role: "user", content: "next" },
    ];
    const result = wire(provider(), messages);
    const callIndex = result.findIndex((m) => m.tool_calls);
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(result[callIndex + 1]).toMatchObject({
      role: "tool",
      tool_call_id: "c1",
    });
  });

  it("rejects an oversized last message locally without a chat POST", async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(
      async () => new Response("{}", { status: 404 }),
    );
    const deltas: StreamDelta[] = [];
    for await (const delta of provider(500).chat([
      { role: "user", content: "x".repeat(8000) },
    ])) {
      deltas.push(delta);
    }
    expect(
      mockFetch.mock.calls.some((call) =>
        String(call[0]).endsWith("/chat/completions"),
      ),
    ).toBe(false);
    const error = deltas.find((d) => d.type === "error");
    expect(error?.type === "error" && error.error).toMatch(
      /context window|too large/i,
    );
  });
});

describe("OpenAICompatibleProvider readiness (#177)", () => {
  it("resolves readiness with the detected window before modelInfo is used", async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/props")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer sk-ready",
        );
        return new Response(
          JSON.stringify({ default_generation_settings: { n_ctx: 4096 } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const provider = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      model: "custom-model",
      baseUrl: "http://localhost:9000/v1",
      apiKey: "sk-ready",
      maxTokens: 512,
      temperature: 0.7,
    });

    // modelInfo() kicks off detection but must not be trusted until ready.
    expect(provider.modelInfo().contextWindow).toBe(8192);
    await provider.ready();
    expect(provider.modelInfo().contextWindow).toBe(4096);
  });

  it("falls back deterministically when detection fails", async () => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = new OpenAICompatibleProvider({
        provider: "openai-compatible",
        model: "custom-model",
        baseUrl: "http://localhost:9000/v1",
        maxTokens: 512,
        temperature: 0.7,
      });
      await provider.ready();
      expect(provider.modelInfo().contextWindow).toBe(8192);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("OpenAICompatibleProvider context metadata (#181, #182)", () => {
  const responseFor = (url: string, nCtx: number): Response => {
    if (url.endsWith("/props")) {
      return new Response(
        JSON.stringify({ default_generation_settings: { n_ctx: nCtx } }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        data: [{ id: "custom-model", max_context_length: nCtx }],
      }),
      { status: 200 },
    );
  };

  it("caps a detected window with the configured contextWindow", async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: string) => responseFor(url, 8192));
    const provider = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      model: "custom-model",
      baseUrl: "http://localhost:9000/v1",
      contextWindow: 4096,
      maxTokens: 512,
      temperature: 0.7,
    });

    provider.modelInfo();
    await vi.waitFor(() =>
      expect(provider.modelInfo().contextWindow).toBe(4096),
    );
  });

  it("sends auth and custom headers on /props and /v1/models probes", async () => {
    mockFetch.mockReset();
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url);
      seen.push({
        url: target,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (target.endsWith("/props")) return new Response("{}", { status: 404 });
      return responseFor(target, 16384);
    });
    const provider = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      model: "custom-model",
      baseUrl: "http://localhost:9000/v1",
      apiKey: "sk-metadata",
      customHeaders: { "X-Champ-Test": "1" },
      contextWindow: 32768,
      maxTokens: 512,
      temperature: 0.7,
    });

    provider.modelInfo();
    await vi.waitFor(() =>
      expect(provider.modelInfo().contextWindow).toBe(16384),
    );

    const props = seen.find((entry) => entry.url.endsWith("/props"));
    const models = seen.find((entry) => entry.url.endsWith("/models"));
    expect(props?.headers.Authorization).toBe("Bearer sk-metadata");
    expect(models?.headers["X-Champ-Test"]).toBe("1");
    expect(models?.headers.Authorization).toBe("Bearer sk-metadata");
  });

  it("uses the configured maxTokens on the wire, with per-call override winning", async () => {
    const sse = () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      );
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: string) =>
      String(url).endsWith("/chat/completions")
        ? sse()
        : new Response("{}", { status: 404 }),
    );
    const provider = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      model: "custom-model",
      baseUrl: "http://localhost:9000/v1",
      maxTokens: 777,
      temperature: 0.7,
    });

    for await (const _delta of provider.chat([
      { role: "user", content: "Hi" },
    ])) {
      // drain the stream
    }
    let body = JSON.parse(
      String(
        mockFetch.mock.calls.find((call) =>
          String(call[0]).endsWith("/chat/completions"),
        )?.[1]?.body,
      ),
    ) as { max_tokens: number };
    expect(body.max_tokens).toBe(777);

    mockFetch.mockClear();
    for await (const _delta of provider.chat(
      [{ role: "user", content: "Hi" }],
      { maxTokens: 123 },
    )) {
      // drain the stream
    }
    body = JSON.parse(
      String(
        mockFetch.mock.calls.find((call) =>
          String(call[0]).endsWith("/chat/completions"),
        )?.[1]?.body,
      ),
    ) as { max_tokens: number };
    expect(body.max_tokens).toBe(123);
  });
});

describe("OpenAICompatibleProvider HTTP error detail (#180)", () => {
  const provider = (): OpenAICompatibleProvider =>
    new OpenAICompatibleProvider({
      provider: "openai-compatible",
      model: "custom-model",
      baseUrl: "http://localhost:9000/v1",
      maxTokens: 512,
      temperature: 0.7,
    });

  it("surfaces the final 507 body without retrying or leaking credentials", async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.endsWith("/props") || target.endsWith("/models")) {
        return new Response("{}", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          error: { message: "KV cache full — free 2 GiB" },
          apiKey: "sk-should-not-leak",
        }),
        { status: 507, statusText: "Insufficient Storage" },
      );
    });

    const deltas: StreamDelta[] = [];
    for await (const delta of provider().chat([
      { role: "user", content: "Hi" },
    ])) {
      deltas.push(delta);
    }

    const posts = mockFetch.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    const error = deltas.find((d) => d.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error).toContain(
      "KV cache full — free 2 GiB",
    );
    expect(JSON.stringify(deltas)).not.toContain("sk-should-not-leak");
  });
});
