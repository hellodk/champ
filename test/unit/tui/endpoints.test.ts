import { describe, expect, it } from "vitest";
import {
  dedupeEndpointSummaries,
  normalizeBaseUrl,
  resolveTuiSelection,
} from "@/tui/endpoints";
import type { EndpointSummary } from "@/tui/state";

function endpoint(
  id: string,
  baseUrl: string,
  models: string[],
  provider = "openai-compatible",
): EndpointSummary {
  return {
    id,
    name: id,
    provider,
    baseUrl,
    hasCredential: false,
    models,
  };
}

describe("TUI endpoint dedupe", () => {
  it("normalizes base URLs for comparison", () => {
    expect(normalizeBaseUrl("HTTP://Host.Example:8030/v1/")).toBe(
      "http://host.example:8030/v1",
    );
  });

  it("keeps one canonical endpoint per provider and base URL", () => {
    const endpoints = [
      endpoint("ep_local", "http://192.168.1.64:8030/v1", ["stale-model"]),
      endpoint("ep_mm", "http://192.168.1.64:8030/v1/", [
        "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
      ]),
      endpoint("ep_other", "http://127.0.0.1:11434", ["qwen3:8b"], "ollama"),
    ];

    const deduped = dedupeEndpointSummaries(endpoints, "ep_mm");

    expect(deduped).toHaveLength(2);
    expect(deduped[0].id).toBe("ep_mm");
    expect(deduped[0].models).toEqual([
      "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
      "stale-model",
    ]);
    expect(deduped[1].id).toBe("ep_other");
  });

  it("resolves the assigned model instead of the first discovered model", () => {
    const endpoints = dedupeEndpointSummaries([
      endpoint("ep_a", "http://192.168.1.64:8030/v1", [
        "mlx-community/Qwen3.5-4B-MLX-4bit",
        "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
      ]),
    ]);

    const selected = resolveTuiSelection(endpoints, "ep_a", {
      endpointId: "ep_a",
      model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    });

    expect(selected).toEqual({
      endpointId: "ep_a",
      model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
      stale: false,
    });
  });

  it("keeps a missing assigned model visible and flags it for re-pick", () => {
    const endpoints = [
      endpoint("ep_a", "http://host:8030/v1", ["fresh-model"]),
    ];

    expect(
      resolveTuiSelection(endpoints, "ep_a", {
        endpointId: "ep_a",
        model: "removed-model",
      }),
    ).toEqual({ endpointId: "ep_a", model: "removed-model", stale: true });
  });

  it("uses the first endpoint but keeps the assigned model when its id disappeared", () => {
    const endpoints = [
      endpoint("ep_a", "http://host:8030/v1", ["fresh-model"]),
    ];

    expect(
      resolveTuiSelection(endpoints, undefined, {
        endpointId: "ep_deleted",
        model: "old-model",
      }),
    ).toEqual({ endpointId: "ep_a", model: "old-model", stale: true });
  });
});
