/**
 * Regression tests for issue #178: selecting a model must swap the provider
 * used by the live agent, and /status must report that live provider.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "@/agent/agent-controller";
import { SystemPromptBuilder } from "@/agent/system-prompt-builder";
import {
  formatLiveStatus,
  switchLiveModel,
  type ModelSwitchDeps,
} from "@/cli/model-switch";
import type { ChampConfig } from "@/config/config-loader";
import type { Endpoint } from "@/config/provider-model";
import type { LLMProvider } from "@/providers/types";
import { ToolRegistry } from "@/tools/registry";

function makeProvider(model: string): LLMProvider {
  const provider = {
    name: `provider-${model}`,
    config: { provider: "vllm", model, maxTokens: 512 },
    modelInfo: () => ({
      id: model,
      name: model,
      provider: "vllm",
      contextWindow: 8000,
      maxOutputTokens: 512,
      supportsToolUse: false,
      supportsImages: false,
      supportsStreaming: true,
    }),
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    supportsImages: () => false,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    chat: vi.fn(async function* () {
      yield {
        type: "done" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
    complete: vi.fn(async function* () {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }),
    withModel: (next: string) => makeProvider(next),
  };
  return provider as unknown as LLMProvider;
}

function endpoint(id: string, model: string): Endpoint {
  return {
    id,
    name: id,
    provider: "vllm",
    baseUrl: `http://${id}:8000/v1`,
    credential: null,
    enabled: true,
    isDefault: true,
    models: [{ id: model }],
  };
}

function deps(overrides: Partial<ModelSwitchDeps> = {}): ModelSwitchDeps {
  const endpoints = [
    endpoint("ep-old", "old-model"),
    endpoint("ep-new", "new-model"),
  ];
  const factory = {
    createFromEndpoint: vi.fn(async (_ep: Endpoint, opts: { model: string }) =>
      makeProvider(opts.model),
    ),
    createFromChampConfig: vi.fn(async () => makeProvider("yaml-model")),
  };
  return {
    registry: {
      list: async () => endpoints,
      setAssignment: vi.fn(async () => {}),
    },
    credentials: { get: async () => undefined },
    config: { provider: "vllm" } as ChampConfig,
    registryChoice: null,
    flags: {},
    factory,
    ...overrides,
  } as ModelSwitchDeps;
}

function controllerWith(model: string): AgentController {
  return new AgentController(
    makeProvider(model),
    new ToolRegistry(),
    "/tmp",
    new SystemPromptBuilder("agent"),
  );
}

describe("live model switching (#178)", () => {
  it("swaps the provider used by the next turn", async () => {
    const ctrl = controllerWith("old-model");
    const result = await switchLiveModel(deps(), ctrl, {
      provider: "ep-new",
      model: "new-model",
    });

    expect(result).toEqual({
      model: "new-model",
      provider: "provider-new-model",
    });

    await ctrl.processMessage("hello");
    expect(ctrl.getProvider().config.model).toBe("new-model");
    expect(ctrl.getProvider().chat).toHaveBeenCalledTimes(1);
  });

  it("reports the live model in /status", async () => {
    const ctrl = controllerWith("old-model");
    const before = formatLiveStatus(ctrl, "agent", "none");
    await switchLiveModel(deps(), ctrl, {
      provider: "ep-new",
      model: "new-model",
    });
    const after = formatLiveStatus(ctrl, "agent", "none");

    expect(before).toContain("model=old-model");
    expect(after).toContain("model=new-model");
  });

  it("keeps the working provider when the rebuild fails", async () => {
    const ctrl = controllerWith("old-model");
    const broken = deps({
      factory: {
        createFromEndpoint: vi.fn(async () => {
          throw new Error("build failed");
        }),
        createFromChampConfig: vi.fn(async () => makeProvider("yaml-model")),
      },
    });

    await expect(
      switchLiveModel(broken, ctrl, {
        provider: "ep-new",
        model: "new-model",
      }),
    ).rejects.toThrow("build failed");
    expect(ctrl.getProvider().config.model).toBe("old-model");
  });
});
