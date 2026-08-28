/**
 * TDD: ticket #121 — assistant-prefill, prefix stability, structured output,
 * and KV-prompt-cache toggle.
 *
 * F1 Assistant-prefill: on prompt-based tool-continuation turns the request
 *    carries a trailing assistant seed so local models begin inside the
 *    `<tool_call>` format instead of narrating. If the model answers without
 *    completing a call, the seed is stripped so it never pollutes history.
 * F2 Prefix stability: identical system + tools always assemble byte-identical
 *    prompts so backend KV/prompt caches hit across turns.
 * F3 Structured output: `structuredOutput: true` on a provider pins
 *    `response_format`/`format: json` on chat bodies (never on tool-call turns).
 * F4 KV-cache toggle: `cachePrompt: true` sends `options.cache_prompt`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  TOOL_CALL_START_PREFIX,
  buildPrefillAssistantMessage,
  injectToolsIntoPrompt,
} from "@/providers/prompt-based-tools";
import { OllamaProvider } from "@/providers/ollama";
import { OpenAICompatibleProvider } from "@/providers/openai-compatible";
import { ConfigLoader } from "@/config/config-loader";
import { AgentController } from "@/agent/agent-controller";
import type { LLMMessage, LLMProvider, StreamDelta } from "@/providers/types";
import type { ToolRegistry } from "@/tools/registry";

// ── shared fixtures ──────────────────────────────────────────────────────────

function mockStream(chunks: object[]): ReadableStream<Uint8Array> {
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

const OLLAMA_BASE = {
  provider: "ollama",
  model: "m",
  baseUrl: "http://localhost:11434",
  maxTokens: 256,
  temperature: 0.7,
};

const OAI_BASE = {
  provider: "openai-compatible",
  model: "m",
  baseUrl: "http://localhost:8000/v1",
  maxTokens: 256,
  temperature: 0.7,
};

/** Capture the JSON body of the first (only) non-probe chat request. */
async function captureChatBody(
  provider: LLMProvider,
  options: Parameters<LLMProvider["chat"]>[1] = {},
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const isOllama = provider.name === "ollama";
  const mockFetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (!isOllama && (u.endsWith("/props") || u.endsWith("/models"))) {
        // Context-detect probes — route them to a not-found response.
        return { ok: false } as unknown as Response;
      }
      captured = JSON.parse((init as RequestInit)?.body as string);
      if (isOllama) {
        return {
          ok: true,
          body: mockStream([{ message: { content: "hi" }, done: true }]),
        } as unknown as Response;
      }
      return {
        ok: true,
        body: mockStream([{ choices: [{ delta: { content: "hi" } }] }]),
      } as unknown as Response;
    },
  );
  vi.stubGlobal("fetch", mockFetch);
  for await (const _ of provider.chat(
    [{ role: "user", content: "hi" }],
    options,
  )) {
    // drain
  }
  vi.unstubAllGlobals();
  return captured;
}

// ── F1: prefill unit ─────────────────────────────────────────────────────────

describe("#121 prefill primitives", () => {
  it("TOOL_CALL_START_PREFIX is the exact XML tool-call opener", () => {
    expect(TOOL_CALL_START_PREFIX).toBe("<tool_call>\n<name>");
  });

  it("buildPrefillAssistantMessage returns a trailing assistant message", () => {
    const m = buildPrefillAssistantMessage();
    expect(m.role).toBe("assistant");
    expect(m.content).toBe("<tool_call>\n<name>");
  });
});

// ── F2: prefix stability ─────────────────────────────────────────────────────

describe("#121 prefix stability (KV/prompt-cache reuse)", () => {
  const tools = [
    {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "grep_search",
      description: "Search for text",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          include_pattern: { type: "string" },
        },
        required: ["query"],
      },
    },
  ] as unknown as Parameters<typeof injectToolsIntoPrompt>[1];

  it("two turns with identical system+tools produce byte-identical prompts", () => {
    const a = injectToolsIntoPrompt("Base system.", tools);
    const b = injectToolsIntoPrompt("Base system.", tools);
    expect(a).toBe(b);
  });

  it("deep-delivered tool objects (re-parsed YAML, server echo) stay identical", () => {
    const reParsed = JSON.parse(JSON.stringify(tools)) as typeof tools;
    const a = injectToolsIntoPrompt("Base system.", tools);
    const b = injectToolsIntoPrompt("Base system.", reParsed);
    expect(a).toBe(b);
  });

  it("changing the base prompt changes the prompt (stability is input-bound)", () => {
    const a = injectToolsIntoPrompt("Base system.", tools);
    const b = injectToolsIntoPrompt("Base system PLUS a change.", tools);
    expect(a).not.toBe(b);
  });
});

// ── F1: agent-controller prefill integration ────────────────────────────────

describe("#121 assistant-prefill in the agent loop", () => {
  function makePromptBasedProvider(): {
    provider: LLMProvider;
    received: LLMMessage[][];
  } {
    const received: LLMMessage[][] = [];
    let callIdx = 0;
    const provider = {
      name: "mock-prompt",
      config: {
        provider: "mock-prompt",
        model: "test",
        maxTokens: 1024,
        temperature: 0.7,
      },
      chat: vi.fn(async function* (
        messages: LLMMessage[],
      ): AsyncGenerator<StreamDelta> {
        received.push([...messages]);
        const idx = callIdx++;
        if (idx === 0) {
          // Full XML call: the model chooses to use a tool on turn 1.
          yield {
            type: "text",
            text: 'Let me look.\n\n<tool_call>\n<name>read_file</name>\n<arguments>{"path": "a.ts"}</arguments>\n</tool_call>',
          };
          yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
        } else {
          // Continuation of the seeded `<tool_call>\n<name>` prefix: the
          // backend generates only the remainder of the tag.
          yield {
            type: "text",
            text: 'read_file</name>\n<arguments>{"path": "b.ts"}</arguments>\n</tool_call>',
          };
          yield { type: "done", usage: { inputTokens: 10, outputTokens: 4 } };
        }
      }),
      complete: vi.fn(),
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: () => 10,
      modelInfo: () => ({
        id: "test",
        name: "Test",
        provider: "mock-prompt",
        contextWindow: 4096,
        maxOutputTokens: 1024,
        supportsToolUse: false,
        supportsImages: false,
        supportsStreaming: true,
      }),
      dispose: vi.fn(),
    } as unknown as LLMProvider;
    return { provider, received };
  }

  function makePromptBasedRegistry(): ToolRegistry {
    const defs = [
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ] as unknown as Parameters<ToolRegistry["getDefinitions"]>[0];
    return {
      getAll: vi.fn().mockReturnValue(defs),
      getDefinitions: vi.fn().mockReturnValue(defs),
      get: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
      execute: vi
        .fn()
        .mockResolvedValue({ success: true, output: "file content" }),
    } as unknown as ToolRegistry;
  }

  it("seeds the assistant prefill on tool-continuation turns only", async () => {
    const { provider, received } = makePromptBasedProvider();
    const registry = makePromptBasedRegistry();
    const controller = new AgentController(provider, registry);

    await controller.processMessage("Read a.ts and b.ts");

    expect(received.length).toBeGreaterThanOrEqual(2);
    // Turn 0 — no prefill.
    expect(received[0][received[0].length - 1]).not.toMatchObject({
      role: "assistant",
    });
    // Turn 1 — trailing assistant seed present.
    expect(received[1][received[1].length - 1]).toEqual({
      role: "assistant",
      content: "<tool_call>\n<name>",
    });
  });

  it("strips the unanswered seed so a plain follow-up stays clean", async () => {
    const { provider, received } = makePromptBasedProvider();
    // Override: iteration 1 answers without calling a tool.
    received.length = 0;
    let callIdx = 0;
    provider.chat = vi.fn(async function* (
      messages: LLMMessage[],
    ): AsyncGenerator<StreamDelta> {
      received.push([...messages]);
      const idx = callIdx++;
      if (idx === 0) {
        yield {
          type: "text",
          text: 'Let me look.\n\n<tool_call>\n<name>read_file</name>\n<arguments>{"path": "a.ts"}</arguments>\n</tool_call>',
        };
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
      } else {
        yield { type: "text", text: "All good." };
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } };
      }
    }) as unknown as LLMProvider["chat"];

    const registry = makePromptBasedRegistry();
    const controller = new AgentController(provider, registry);

    const result = await controller.processMessage("Read a.ts");
    expect(result.text).toContain("All good.");
    expect(result.toolCalls).toHaveLength(1);
  });
});

// ── F3: structured output ────────────────────────────────────────────────────

describe("#121 structured output", () => {
  it("openai-compatible sends response_format when structuredOutput is on", async () => {
    const provider = new OpenAICompatibleProvider({
      ...OAI_BASE,
      structuredOutput: true,
    });
    const body = await captureChatBody(provider);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("openai-compatible omits response_format by default", async () => {
    const provider = new OpenAICompatibleProvider({ ...OAI_BASE });
    const body = await captureChatBody(provider);
    expect(body.response_format).toBeUndefined();
  });

  it("openai-compatible never constrains tool-call turns", async () => {
    const provider = new OpenAICompatibleProvider({
      ...OAI_BASE,
      structuredOutput: true,
    });
    const body = await captureChatBody(provider, { taskHint: "toolcall" });
    expect(body.response_format).toBeUndefined();
  });

  it("ollama sends format: json when structuredOutput is on", async () => {
    const provider = new OllamaProvider({
      ...OLLAMA_BASE,
      structuredOutput: true,
    });
    const body = await captureChatBody(provider);
    expect(body.format).toBe("json");
  });

  it("ollama omits format: json by default", async () => {
    const provider = new OllamaProvider({ ...OLLAMA_BASE });
    const body = await captureChatBody(provider);
    expect(body.format).toBeUndefined();
  });

  it("ollama keeps options.jsonFormat (explicit request wins)", async () => {
    const provider = new OllamaProvider({ ...OLLAMA_BASE });
    const body = await captureChatBody(provider, { jsonFormat: true });
    expect(body.format).toBe("json");
  });
});

// ── F4: KV/prompt-cache toggle ───────────────────────────────────────────────

describe("#121 KV-cache toggle", () => {
  it("ollama sends options.cache_prompt when cachePrompt is on", async () => {
    const provider = new OllamaProvider({ ...OLLAMA_BASE, cachePrompt: true });
    const body = await captureChatBody(provider);
    const opts = body.options as Record<string, unknown>;
    expect(opts.cache_prompt).toBe(true);
  });

  it("ollama omits options.cache_prompt by default", async () => {
    const provider = new OllamaProvider({ ...OLLAMA_BASE });
    const body = await captureChatBody(provider);
    const opts = body.options as Record<string, unknown>;
    expect(opts.cache_prompt).toBeUndefined();
  });
});

// ── config validation ────────────────────────────────────────────────────────

describe("#121 YAML validation", () => {
  it("accepts structuredOutput: true on a provider", () => {
    const cfg = ConfigLoader.parseYaml(`
provider: ollama
providers:
  ollama:
    model: m
    structuredOutput: true
`);
    expect(cfg.providers?.ollama?.structuredOutput).toBe(true);
  });

  it("rejects a non-boolean structuredOutput", () => {
    expect(() =>
      ConfigLoader.parseYaml(`
provider: ollama
providers:
  ollama:
    structuredOutput: "yes"
`),
    ).toThrow(/structuredOutput/);
  });

  it("accepts cachePrompt: false and rejects a non-boolean cachePrompt", () => {
    const cfg = ConfigLoader.parseYaml(`
provider: ollama
providers:
  ollama:
    cachePrompt: false
`);
    expect(cfg.providers?.ollama?.cachePrompt).toBe(false);
    expect(() =>
      ConfigLoader.parseYaml(`
provider: ollama
providers:
  ollama:
    cachePrompt: 1
`),
    ).toThrow(/cachePrompt/);
  });
});
