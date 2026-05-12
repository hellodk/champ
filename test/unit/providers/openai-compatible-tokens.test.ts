import { describe, it, expect, vi } from "vitest";
import { OpenAICompatibleProvider } from "@/providers/openai-compatible";

function makeProvider() {
  return new OpenAICompatibleProvider({
    provider: "openai-compatible",
    model: "llama3",
    baseUrl: "http://localhost:11434",
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

describe("OpenAICompatibleProvider token accounting", () => {
  it("reads prompt_tokens and completion_tokens from usage chunk", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      body: sseBody([
        { choices: [{ delta: { content: "Hello" } }] },
        {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        },
      ]),
    } as unknown as Response);

    const provider = makeProvider();
    let done:
      | { type: string; usage: { inputTokens: number; outputTokens: number } }
      | undefined;
    for await (const delta of provider.chat([
      { role: "user", content: "Hi" },
    ])) {
      if (delta.type === "done") done = delta as typeof done;
    }

    expect(done?.usage.inputTokens).toBe(42);
    expect(done?.usage.outputTokens).toBe(7);
  });

  it("emits stream_options include_usage in request body", async () => {
    let capturedBody: Record<string, unknown> = {};
    vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        body: sseBody([{ choices: [{ delta: {} }] }]),
      } as unknown as Response;
    });

    const provider = makeProvider();
    for await (const _ of provider.chat([{ role: "user", content: "Hi" }])) {
      // drain
    }
    expect(
      (capturedBody.stream_options as Record<string, unknown>)?.include_usage,
    ).toBe(true);
  });
});
