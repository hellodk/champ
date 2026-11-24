/**
 * Headless CLI routing must send requests with the model chosen by
 * SmartRouter, not the model the endpoint provider was constructed with.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentController } from "@/agent/agent-controller";
import { SmartRouter } from "@/providers/smart-router";
import { ToolRegistry } from "@/tools/registry";

function makeProvider(model: string) {
  const chat = vi.fn(async function* () {
    yield { type: "text" as const, text: "answer" };
    yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } };
  });
  return {
    name: "local",
    config: { provider: "ollama", model },
    modelInfo: () => ({
      id: model,
      name: model,
      provider: "ollama",
      contextWindow: 8192,
      maxOutputTokens: 2048,
      supportsToolUse: true,
      supportsImages: false,
      supportsStreaming: true,
    }),
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    supportsImages: () => false,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    chat,
    complete: vi.fn(async function* () {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }),
    withModel: vi.fn((nextModel: string) => makeProvider(nextModel)),
  };
}

describe("headless CLI routed model", () => {
  it("sends the task override model with the routed provider", async () => {
    const endpointProvider = makeProvider("endpoint-first-model");
    const router = new SmartRouter();
    router.registerProvider("local", endpointProvider as never, "ollama");
    router.seedDiscoveredModels([
      {
        id: "endpoint-first-model",
        providerName: "local",
        providerType: "ollama",
        capabilities: ["coding"],
        speed: "medium",
        contextWindow: 8192,
        sizeHint: "8B",
        quantizationLevel: "",
        source: "discovered",
      },
      {
        id: "task-override-model",
        providerName: "local",
        providerType: "ollama",
        capabilities: ["coding"],
        speed: "fast",
        contextWindow: 16384,
        sizeHint: "8B",
        quantizationLevel: "",
        source: "discovered",
      },
    ]);
    router.setTaskModel("coding", "task-override-model");

    const controller = new AgentController(
      endpointProvider as never,
      new ToolRegistry(),
      "/tmp",
    );
    controller.setSmartRouter(router);

    await controller.processMessage("hello");

    expect(endpointProvider.withModel).toHaveBeenCalledWith(
      "task-override-model",
    );
    const used = endpointProvider.withModel.mock.results[0].value as ReturnType<
      typeof makeProvider
    >;
    expect(used.config.model).toBe("task-override-model");
    expect(used.chat.mock.calls.length).toBe(1);
    expect(endpointProvider.chat.mock.calls.length).toBe(0);
  });
});
