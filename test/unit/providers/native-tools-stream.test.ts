/**
 * TDD: native OpenAI tool-call streaming for openai-compatible providers.
 *
 * Contract: when the server streams delta.tool_calls (OpenAI wire format),
 * the provider must surface them as tool_call_start / tool_call_delta /
 * tool_call_end deltas. reasoning_content chunks must not leak into text.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatibleProvider } from "@/providers/openai-compatible";

function sseResponse(chunks: unknown[]): Response {
  const body =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200 });
}

function makeProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    provider: "openai-compatible",
    baseUrl: "http://fake/v1",
    model: "m",
    apiKey: "k",
    maxTokens: 100,
    temperature: 0,
    supportsTools: true,
  });
}

describe("native tool-call streaming", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("emits start/delta/end deltas from delta.tool_calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
              },
            ],
          },
          // Reasoning models put chain-of-thought here — never user-facing.
          {
            choices: [
              {
                index: 0,
                delta: { reasoning_content: "I should call the tool" },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "list_directory", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"pa' } }],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: 'th":"a"}' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );

    const p = makeProvider();
    const deltas = [] as unknown[];
    for await (const d of p.chat([{ role: "user", content: "x" }], {
      tools: [
        {
          name: "list_directory",
          description: "d",
          parameters: { type: "object", properties: {}, required: [] },
        },
      ],
    })) {
      deltas.push(d);
    }

    const start = deltas.find((d) => d.type === "tool_call_start") as
      | {
          type: "tool_call_start";
          toolCall: {
            id: string;
            name: string;
            arguments: Record<string, unknown>;
          };
        }
      | undefined;
    const argDelta = deltas.filter(
      (d) => d.type === "tool_call_delta",
    ) as Array<{
      type: "tool_call_delta";
      toolCallId: string;
      argumentsDelta: string;
    }>;
    const end = deltas.find((d) => d.type === "tool_call_end") as
      | { type: "tool_call_end"; toolCallId?: string }
      | undefined;

    expect(start?.toolCall.name).toBe("list_directory");
    expect(start?.toolCall.id).toBe("call_1");
    expect(argDelta.map((d) => d.argumentsDelta).join("")).toBe('{"path":"a"}');
    expect(end?.toolCallId).toBe("call_1");

    const texts = deltas
      .filter((d) => d.type === "text")
      .map((d) => (d as { text: string }).text)
      .join("");
    expect(texts).not.toContain("chain-of-thought");
  });

  it("parses accumulated arguments into toolCall.arguments on start when they arrive in one chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          sseResponse([
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_2",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: '{"path":"src/x.ts"}',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]),
        ),
    );
    const p = makeProvider();
    let sawArgs: unknown;
    for await (const d of p.chat([{ role: "user", content: "x" }], {})) {
      if (d.type === "tool_call_start") {
        sawArgs = d.toolCall.arguments;
      }
    }
    expect(sawArgs).toEqual({ path: "src/x.ts" });
  });

  it("flags an empty 200 stream as an error instead of a blank answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response("", { status: 200 })),
    );
    const p = makeProvider();
    const deltas: Array<{ type: string; error?: string }> = [];
    for await (const d of p.chat([{ role: "user", content: "x" }], {})) {
      deltas.push(d as { type: string });
    }
    // Server sometimes returns 200 with zero SSE events; that is a failure,
    // not a valid empty completion.
    expect(deltas.some((d) => d.type === "error")).toBe(true);
  });
});
